"""OpenRouter API client for making LLM requests."""
import asyncio
import json
import re
import time
import traceback
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from typing import Any, Dict, List, Optional

import httpx

from .config import (
    OPENROUTER_API_URL,
    OPENROUTER_CREDITS_URL,
    OPENROUTER_KEY_URL,
    OPENROUTER_MAX_TOKENS,
    OPENROUTER_MAX_TOKENS_HIGH,
    OPENROUTER_MODELS_URL,
)
from .loop_guard import create_loop_detector
from .roster import (
    FREE_MINUTE_SECONDS,
    MODEL_COOLDOWN_MAX_SECONDS,
    MODEL_COOLDOWN_SECONDS,
    admit_free_post,
    UPSTREAM_LIMIT,
    blocked_ids,
    catalogue_id,
    drop_blocked_model,
    is_free_model,
    is_harness_only_message,
    is_upstream_limited,
    model_unavailable,
    pause_free_queue,
    remember_model_cooldown,
    run_free_call,
)
from .settings import settings


def get_api_key() -> Optional[str]:
    """Personal key from settings. Credits, key info, and completions all use it."""
    return settings.api_key


def resolve_max_tokens(model: str, override: Optional[int] = None) -> int:
    """Return the completion cap OpenRouter should reserve for this model."""
    if override is not None:
        return max(1, int(override))
    if str(model).endswith('-reasoning-high'):
        return OPENROUTER_MAX_TOKENS_HIGH
    return OPENROUTER_MAX_TOKENS


# Upper bound on an honoured Retry-After; a longer wait ties up a council slot.
MAX_RETRY_AFTER_SECONDS = 60


class CatalogueUnavailable(Exception):
    """OpenRouter model list could not be loaded."""


def parse_retry_after(
    raw: Optional[str],
    fallback: float,
    limit: float = MAX_RETRY_AFTER_SECONDS,
) -> float:
    """
    Seconds to wait from a Retry-After header.

    RFC 9110 allows either a delta in seconds or an HTTP-date, and a proxy in
    front of OpenRouter may send either. Anything unparseable falls back to the
    caller's backoff, and every value is clamped so one header cannot park a
    request for an hour.
    """
    wait = None
    if raw is not None:
        text = str(raw).strip()
        try:
            wait = float(text)
        except ValueError:
            try:
                when = parsedate_to_datetime(text)
            except (TypeError, ValueError):
                wait = None
            else:
                if when is not None:
                    if when.tzinfo is None:
                        when = when.replace(tzinfo=timezone.utc)
                    wait = (when - datetime.now(timezone.utc)).total_seconds()
    if wait is None:
        wait = fallback
    return max(0.0, min(float(wait), limit))


def catalogue_model_id(model: str) -> str:
    """Strip a trailing reasoning suffix so the id matches the OpenRouter catalogue."""
    return re.sub(r'-reasoning(?:-high)?$', '', model)


def model_family(model: str) -> str:
    """
    Group models by the vendor that trained them.

    OpenRouter ids are '<author>/<slug>', so the author segment is the family:
    'anthropic/claude-opus-4.1' and 'anthropic/claude-sonnet-4.5' are one
    family, and a judge must not grade its own vendor's answers. Ids with no
    author fall back to the whole catalogue id.
    """
    base = catalogue_model_id(str(model or '')).strip().lstrip('~').lower()
    author, sep, _ = base.partition('/')
    return author if sep and author else base


async def unknown_catalogue_ids(models: List[str]) -> List[str]:
    """Return catalogue ids that are not in the OpenRouter model list."""
    pricing = await get_models_pricing()
    if not pricing:
        raise CatalogueUnavailable('OpenRouter model catalogue unavailable')
    unknown = []
    seen = set()
    for model in models:
        if not model or not str(model).strip():
            continue
        cid = catalogue_id(model)
        if cid in seen:
            continue
        seen.add(cid)
        if cid not in pricing:
            unknown.append(cid)
    return unknown


def parse_http_error(response: httpx.Response) -> Dict[str, Any]:
    """Extract status, user-facing message, and raw detail from an HTTP error."""
    status = response.status_code
    detail = ''
    try:
        data = response.json()
    except ValueError:
        detail = response.text or ''
    else:
        err = data.get('error')
        if isinstance(err, dict):
            message = str(err.get('message') or '')
            metadata = err.get('metadata')
            raw = ''
            if isinstance(metadata, dict) and metadata.get('raw'):
                raw = str(metadata.get('raw'))
            parts = [part for part in (message, raw) if part]
            detail = ' '.join(parts) if parts else str(err)
        elif err:
            detail = str(err)
        else:
            detail = response.text or ''

    if status == 402:
        message = '402: cannot afford reserved tokens'
    elif status == 404:
        message = 'Model not found (404)'
    else:
        message = f'HTTP {status}'
        if detail:
            message = f'{message}: {detail}'

    return {
        'status': status,
        'message': message,
        'detail': detail,
    }


# Cache for model pricing data with TTL
_models_cache: Optional[Dict[str, Dict[str, Any]]] = None
_models_cache_time: float = 0
_CACHE_TTL = 300  # 5 minutes


async def get_models_pricing() -> Dict[str, Dict[str, Any]]:
    """
    Fetch and cache model pricing data from OpenRouter.
    
    Returns:
        Dict mapping model ID to pricing info
    """
    global _models_cache, _models_cache_time

    if _models_cache is not None and (time.time() - _models_cache_time) < _CACHE_TTL:
        return _models_cache
    
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            response = await client.get(OPENROUTER_MODELS_URL)
            response.raise_for_status()
            data = response.json()

            built = {}
            for model in data.get('data', []):
                model_id = model.get('id')
                if model_id:
                    top = model.get('top_provider') or {}
                    params = model.get('supported_parameters')
                    built[model_id] = {
                        'name': model.get('name'),
                        'pricing': model.get('pricing', {}),
                        'description': model.get('description', ''),
                        'context_length': model.get('context_length'),
                        'max_completion_tokens': (
                            top.get('max_completion_tokens') if isinstance(top, dict) else None
                        ),
                        'supported_parameters': list(params) if isinstance(params, list) else None,
                    }
            _models_cache = built
            _models_cache_time = time.time()
            return _models_cache
    except Exception as e:
        print(f"Error fetching models: {e}")
        return {}


async def _auth_get_data(
    url: str, label: str, timeout: float = 10.0
) -> Optional[Dict[str, Any]]:
    """GET an authenticated OpenRouter JSON object from response['data']."""
    api_key = get_api_key()
    if not api_key:
        return None

    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            response = await client.get(
                url, headers={'Authorization': f'Bearer {api_key}'}
            )
            response.raise_for_status()
            return response.json().get('data')
    except Exception as e:
        print(f'Error fetching {label}: {e}')
        return None


async def get_credits() -> Optional[Dict[str, Any]]:
    """Return OpenRouter credits ({total_credits, total_usage}) or None."""
    return await _auth_get_data(OPENROUTER_CREDITS_URL, 'credits')


async def get_key_info() -> Optional[Dict[str, Any]]:
    """Return per-key limits from GET /api/v1/key, or None."""
    return await _auth_get_data(OPENROUTER_KEY_URL, 'key info', timeout=2.0)


def has_visible_content(content: Any) -> bool:
    """True when the model returned a visible answer, not just reasoning."""
    return isinstance(content, str) and bool(content.strip())


def visible_reasoning_text(message: Any) -> str:
    """Text the model put in reasoning fields when content itself is blank."""
    if not isinstance(message, dict):
        return ''
    reasoning = message.get('reasoning')
    if isinstance(reasoning, str) and reasoning.strip():
        return reasoning.strip()
    details = message.get('reasoning_details')
    if not isinstance(details, list):
        return ''
    parts = []
    for item in details:
        if not isinstance(item, dict):
            continue
        for key in ('text', 'summary', 'content'):
            value = item.get(key)
            if isinstance(value, str) and value.strip():
                parts.append(value.strip())
                break
    return '\n\n'.join(parts)


def _skip_message(reason: str) -> str:
    messages = {
        'blocked': 'OpenRouter will not serve this model',
        'cooldown': 'Temporarily unavailable (cooldown)',
        'upstream-429': 'Temporarily rate-limited upstream',
        'provider-429': 'Provider returned an error',
        'harness-403': 'Only available on agentic harnesses',
    }
    return messages.get(reason, 'Skipped')


def _unavailable_skip_message(model: str) -> str:
    cid = catalogue_id(model)
    if cid and cid in blocked_ids():
        return _skip_message('blocked')
    return _skip_message('cooldown')


def _limited_skip_reason(detail: str) -> str:
    if UPSTREAM_LIMIT in str(detail or '').lower():
        return 'upstream-429'
    return 'provider-429'


def _skipped_result(message: str = 'Skipped') -> Dict[str, Any]:
    return {
        'ok': False,
        'skipped': True,
        'error': {'status': 403, 'message': message, 'detail': ''},
    }


def _fail_result(
    message: str, status: Optional[int] = None, detail: str = ''
) -> Dict[str, Any]:
    return {
        'ok': False,
        'error': {'status': status, 'message': message, 'detail': detail},
    }


# Conservative prompt size, as promptTokenEstimate in the in-browser engine:
# two characters per token plus a margin per message for the chat template.
CONTEXT_CHARS_PER_TOKEN = 2
CONTEXT_MESSAGE_MARGIN = 64
CONTEXT_TEMPLATE_MARGIN = 1024


def prompt_token_estimate(messages: Any) -> int:
    items = messages if isinstance(messages, list) else []
    chars = 0
    for message in items:
        content = message.get('content') if isinstance(message, dict) else None
        chars += len('' if content is None else str(content))
    return (
        -(-chars // CONTEXT_CHARS_PER_TOKEN)
        + CONTEXT_MESSAGE_MARGIN * len(items)
        + CONTEXT_TEMPLATE_MARGIN
    )


def _usage_counts(usage: Any) -> Dict[str, int]:
    usage = usage if isinstance(usage, dict) else {}
    return {
        'prompt_tokens': usage.get('prompt_tokens', 0),
        'completion_tokens': usage.get('completion_tokens', 0),
        'total_tokens': usage.get('total_tokens', 0),
    }


def _completion_from_data(data: Any, annotate: bool = False) -> Dict[str, Any]:
    """A non-streaming completion. annotate adds finish and provenance."""
    try:
        choice = data['choices'][0]
        message = choice['message']
    except (KeyError, IndexError, TypeError):
        return _fail_result('Empty model response')
    usage = data.get('usage', {})
    content = message.get('content')
    from_reasoning = not has_visible_content(content)
    if from_reasoning:
        content = visible_reasoning_text(message)
    if not has_visible_content(content):
        return _fail_result('Empty model response')
    result = {
        'ok': True,
        'content': content,
        'reasoning_details': message.get('reasoning_details'),
        'usage': _usage_counts(usage),
    }
    if annotate:
        if from_reasoning:
            result['content_from_reasoning'] = True
        if isinstance(choice, dict) and choice.get('finish_reason'):
            result['finish_reason'] = choice['finish_reason']
    return result


# Streaming, used by Self-MoA calls. Port of the stream reader in
# frontend/src/engine/browser/openrouter.js: same channels, same loop guard
# placement, same result for a stream the guard stopped.

class _StreamTarget:
    def __init__(self):
        self.content = ''
        self.reasoning = ''
        self.reasoning_content = ''
        self.details: Dict[str, Dict[str, Any]] = {}
        self.detail_seq = 0


def _detail_key(item: Dict[str, Any]) -> Optional[str]:
    parts = [item.get('type'), item.get('index'), item.get('id')]
    if all(part is None for part in parts):
        return None
    return '\0'.join('' if part is None else str(part) for part in parts)


def _merge_detail(target: _StreamTarget, item: Any) -> None:
    if not isinstance(item, dict):
        return
    key = _detail_key(item) or f'anon\0{target.detail_seq}'
    target.detail_seq += 1
    prev = target.details.get(key)
    if prev is None:
        target.details[key] = dict(item)
        return
    merged = dict(prev)
    for field, value in item.items():
        if (
            field in ('text', 'summary', 'content')
            and isinstance(prev.get(field), str)
            and isinstance(value, str)
        ):
            merged[field] = value if value.startswith(prev[field]) else prev[field] + value
        elif value is not None:
            merged[field] = value
    target.details[key] = merged


def _apply_delta(target: _StreamTarget, delta: Dict[str, Any]) -> None:
    if isinstance(delta.get('content'), str):
        target.content += delta['content']
    if isinstance(delta.get('reasoning'), str):
        target.reasoning += delta['reasoning']
    if isinstance(delta.get('reasoning_content'), str):
        target.reasoning_content += delta['reasoning_content']
    if isinstance(delta.get('reasoning_details'), list):
        for item in delta['reasoning_details']:
            _merge_detail(target, item)


def _apply_snapshot(target: _StreamTarget, message: Dict[str, Any]) -> None:
    target.content = message['content'] if isinstance(message.get('content'), str) else ''
    target.reasoning = message['reasoning'] if isinstance(message.get('reasoning'), str) else ''
    target.reasoning_content = (
        message['reasoning_content'] if isinstance(message.get('reasoning_content'), str) else ''
    )
    target.details = {}
    target.detail_seq = 0
    if isinstance(message.get('reasoning_details'), list):
        for item in message['reasoning_details']:
            _merge_detail(target, item)


def _details_text(target: _StreamTarget) -> str:
    return visible_reasoning_text({'reasoning_details': list(target.details.values())})


def _details_length(target: _StreamTarget) -> int:
    total = 0
    for item in target.details.values():
        if not isinstance(item, dict) or 'encrypted' in str(item.get('type') or ''):
            continue
        for key in ('text', 'summary', 'content'):
            value = item.get(key)
            if isinstance(value, str) and value:
                total += len(value)
                break
    return total


def _visible_stream_text(target: _StreamTarget) -> str:
    if has_visible_content(target.content):
        return target.content
    if has_visible_content(target.reasoning):
        return target.reasoning
    if has_visible_content(target.reasoning_content):
        return target.reasoning_content
    return _details_text(target)


# One canonical reasoning channel, fixed at its first text.
_REASONING_CHANNELS = {
    'reasoning': (lambda t: len(t.reasoning), lambda t: t.reasoning),
    'reasoningContent': (lambda t: len(t.reasoning_content), lambda t: t.reasoning_content),
    'details': (_details_length, _details_text),
}


class _StreamLoopGuard:
    def __init__(self, config):
        self.reasoning = create_loop_detector(config)
        self.content = create_loop_detector(config)
        self.channel = None

    def check(self, target: _StreamTarget) -> Optional[Dict[str, Any]]:
        if not self.channel:
            if target.reasoning:
                self.channel = 'reasoning'
            elif target.reasoning_content:
                self.channel = 'reasoningContent'
            elif _details_length(target) > 0:
                self.channel = 'details'
        if self.channel:
            length, text = _REASONING_CHANNELS[self.channel]
            if length(target) >= self.reasoning.next:
                hit = self.reasoning.observe(text(target))
                if hit:
                    return {'channel': self.channel, **hit}
        if len(target.content) >= self.content.next:
            hit = self.content.observe(target.content)
            if hit:
                return {'channel': 'content', **hit}
        return None


def _stream_success(
    target: _StreamTarget, content: str, usage: Any, annotate: bool, finish: Optional[str]
) -> Dict[str, Any]:
    details = list(target.details.values())
    result = {
        'ok': True,
        'content': content,
        'reasoning_details': details or None,
        'usage': _usage_counts(usage),
    }
    if annotate:
        if not has_visible_content(target.content):
            result['content_from_reasoning'] = True
        if finish:
            result['finish_reason'] = finish
    return result


def _loop_terminal(target: _StreamTarget, usage: Any, loop: Dict[str, Any]) -> Dict[str, Any]:
    """A stream the loop guard stopped: the caller retries or keeps the text."""
    content = _visible_stream_text(target)
    if has_visible_content(content):
        partial = _stream_success(target, content, usage, True, None)
        partial.update({'loop_cut': True, 'finish_reason': 'loop', 'loop': loop})
    else:
        partial = _fail_result('loop', None, 'Repetition loop before any text')
        partial['loop'] = loop
    return {
        'ok': False,
        'loop': loop,
        'partial': partial,
        'error': {
            'status': None,
            'message': 'loop',
            'detail': f"repetition in {loop['channel']} at {loop['position']}",
        },
    }


def _provider_failure(err: Any) -> Dict[str, Any]:
    if isinstance(err, dict):
        message = str(err.get('message') or err.get('error') or 'Stream error')
        status = err.get('code') if isinstance(err.get('code'), int) else None
    else:
        message = str(err or 'Stream error')
        status = None
    return _fail_result(message, status, message)


async def _read_completion_stream(lines, loop_guard: Any, annotate: bool) -> Dict[str, Any]:
    """Read an OpenRouter SSE stream to its first terminal result."""
    target = _StreamTarget()
    guard = _StreamLoopGuard(loop_guard) if loop_guard else None
    state = {'usage': None, 'finish': None, 'saw_delta': False}
    data_lines: List[str] = []
    event_name = ''

    def consume(parsed: Any) -> Optional[Dict[str, Any]]:
        if not isinstance(parsed, dict):
            return None
        if parsed.get('error'):
            return _provider_failure(parsed['error'])
        if isinstance(parsed.get('usage'), dict):
            state['usage'] = parsed['usage']
        choices = parsed.get('choices')
        choice = choices[0] if isinstance(choices, list) and choices else None
        if not isinstance(choice, dict):
            return None
        if choice.get('error'):
            return _provider_failure(choice['error'])
        if choice.get('finish_reason'):
            state['finish'] = choice['finish_reason']
        if choice.get('finish_reason') == 'content_filter':
            return _provider_failure('content_filter')
        if choice.get('finish_reason') == 'error':
            return _provider_failure('finish_reason error')
        delta = choice.get('delta')
        if isinstance(delta, dict):
            state['saw_delta'] = True
            if delta.get('tool_calls'):
                return _fail_result('protocol', None, 'Tool calls are not a council answer')
            _apply_delta(target, delta)
            if guard:
                loop = guard.check(target)
                if loop:
                    return _loop_terminal(target, state['usage'], loop)
            return None
        message = choice.get('message')
        if isinstance(message, dict) and not state['saw_delta']:
            if message.get('tool_calls'):
                return _fail_result('protocol', None, 'Tool calls are not a council answer')
            _apply_snapshot(target, message)
        return None

    def dispatch() -> Optional[Dict[str, Any]]:
        nonlocal data_lines, event_name
        data = '\n'.join(data_lines)
        name = event_name
        data_lines = []
        event_name = ''
        if not data:
            return None
        if name == 'error':
            try:
                parsed = json.loads(data)
                if isinstance(parsed, dict) and parsed.get('error'):
                    return _provider_failure(parsed['error'])
                if isinstance(parsed, dict) and parsed.get('message'):
                    return _provider_failure(parsed['message'])
            except ValueError:
                pass
            return _provider_failure(data)
        if data.strip() == '[DONE]':
            content = _visible_stream_text(target)
            if not has_visible_content(content):
                return _fail_result('Empty model response')
            return _stream_success(target, content, state['usage'], annotate, state['finish'])
        try:
            parsed = json.loads(data)
        except ValueError:
            return _fail_result('protocol', None, 'Invalid stream data')
        return consume(parsed)

    async for line in lines:
        if line == '':
            terminal = dispatch()
        elif line.startswith(':'):
            terminal = None
        else:
            field, _, value = line.partition(':')
            if value.startswith(' '):
                value = value[1:]
            if field == 'data':
                data_lines.append(value)
            elif field == 'event':
                event_name = value
            terminal = None
        if terminal:
            return terminal
    terminal = dispatch()
    if terminal:
        return terminal
    return _fail_result('protocol', None, 'Stream ended before [DONE]')


async def _post_stream(
    client, headers, payload, loop_guard: Any, annotate: bool, total_seconds: Optional[float]
) -> Dict[str, Any]:
    async def run():
        async with client.stream(
            'POST', OPENROUTER_API_URL, headers=headers, json=payload
        ) as response:
            if response.status_code >= 400:
                await response.aread()
                response.raise_for_status()
            if 'text/event-stream' not in (response.headers.get('content-type') or ''):
                await response.aread()
                return _completion_from_data(response.json(), annotate)
            return await _read_completion_stream(response.aiter_lines(), loop_guard, annotate)

    try:
        if total_seconds:
            return await asyncio.wait_for(run(), total_seconds)
        return await run()
    except asyncio.TimeoutError:
        return _fail_result('total')
    except httpx.TimeoutException:
        return _fail_result('idle')


async def _query_model_attempts(
    model: str,
    messages: List[Dict[str, str]],
    timeout: float = 120.0,
    max_tokens: Optional[int] = None,
    temperature: Optional[float] = None,
    top_p: Optional[float] = None,
    stream: bool = False,
    loop_guard: Any = None,
    max_retries: Optional[int] = None,
    annotate: bool = False,
    total_seconds: Optional[float] = None,
) -> Dict[str, Any]:
    """One model's HTTP attempts. Caller serializes :free models.

    stream or loop_guard reads an SSE stream: timeout is then the idle limit
    and total_seconds the limit for the whole stream. A stream the loop guard
    stopped is asked again while attempts remain; the last one keeps its
    text, marked loop_cut. max_retries is the number of attempts (default 5),
    as in the in-browser engine.
    """
    api_key = get_api_key()
    if not api_key:
        print(f'Error querying model {model}: No API key configured')
        return _fail_result('No API key configured')

    headers = {
        'Authorization': f'Bearer {api_key}',
        'Content-Type': 'application/json',
    }

    base_model = catalogue_model_id(model)
    is_anthropic = model_family(model) == 'anthropic'

    payload = {
        'model': base_model,
        'messages': messages,
        'max_tokens': resolve_max_tokens(model, max_tokens),
    }
    if str(model).endswith('-reasoning-high'):
        # Anthropic supports 'xhigh' (extra high); use it for R+. Others use 'high'.
        payload['reasoning'] = {'effort': 'xhigh' if is_anthropic else 'high'}
    elif str(model).endswith('-reasoning'):
        payload['reasoning'] = {'effort': 'high'}
    if temperature is not None:
        payload['temperature'] = temperature
    if top_p is not None:
        payload['top_p'] = top_p
    streaming = bool(stream or loop_guard)
    if streaming:
        payload['stream'] = True
        payload['stream_options'] = {'include_usage': True}

    if not (isinstance(max_retries, int) and max_retries > 0):
        max_retries = 5
    free = is_free_model(model)
    extra_wait = 0.0
    for attempt in range(max_retries):
        try:
            if model_unavailable(model):
                return _skipped_result(_unavailable_skip_message(model))
            async with httpx.AsyncClient(timeout=timeout) as client:
                if free:
                    await admit_free_post(extra_wait)
                    extra_wait = 0.0
                if streaming:
                    outcome = await _post_stream(
                        client, headers, payload, loop_guard, annotate, total_seconds
                    )
                    if outcome.get('loop'):
                        if attempt < max_retries - 1:
                            print(f'Repetition loop from {model}, retrying once')
                            continue
                        return outcome['partial']
                    return outcome
                response = await client.post(
                    OPENROUTER_API_URL, headers=headers, json=payload
                )
                response.raise_for_status()

                data = response.json()
                try:
                    message = data['choices'][0]['message']
                except (KeyError, IndexError, TypeError):
                    return _fail_result('Empty model response')
                usage = data.get('usage', {})
                content = message.get('content')
                if not has_visible_content(content):
                    content = visible_reasoning_text(message)
                if not has_visible_content(content):
                    return _fail_result('Empty model response')

                return {
                    'ok': True,
                    'content': content,
                    'reasoning_details': message.get('reasoning_details'),
                    'usage': {
                        'prompt_tokens': usage.get('prompt_tokens', 0),
                        'completion_tokens': usage.get('completion_tokens', 0),
                        'total_tokens': usage.get('total_tokens', 0),
                    },
                }

        except httpx.HTTPStatusError as e:
            if e.response.status_code == 429:
                error = parse_http_error(e.response)
                detail = f"{error.get('message', '')} {error.get('detail', '')}"
                free_limited = 'free-models-per-min' in detail
                header = e.response.headers.get('Retry-After')
                if free_limited:
                    wait = parse_retry_after(header, FREE_MINUTE_SECONDS)
                    pause_free_queue(wait)
                elif is_upstream_limited(detail):
                    wait = parse_retry_after(
                        header,
                        MODEL_COOLDOWN_SECONDS,
                        MODEL_COOLDOWN_MAX_SECONDS,
                    )
                    remember_model_cooldown(model, wait)
                    return _skipped_result(
                        _skip_message(_limited_skip_reason(detail))
                    )
                else:
                    wait = parse_retry_after(header, 2**attempt)
                if attempt < max_retries - 1:
                    print(f'Rate limited for {model}, retrying in {wait:g}s...')
                    if free and not free_limited:
                        extra_wait = wait
                    elif not free:
                        await asyncio.sleep(wait)
                    continue
                return {'ok': False, 'error': error}

            error = parse_http_error(e.response)
            if e.response.status_code == 402:
                print(f'Payment required for {model} (402): {error["detail"] or e}')
            elif e.response.status_code == 404:
                print(f'Model {model} not found (404)')
            elif (
                e.response.status_code == 403
                and is_harness_only_message(
                    f"{error.get('message', '')} {error.get('detail', '')}"
                )
            ):
                drop_blocked_model(model)
                print(f'Error querying model {model}: {e}')
                return _skipped_result(_skip_message('harness-403'))
            else:
                traceback.print_exc()
                print(f'Error querying model {model}: {e}')
            return {'ok': False, 'error': error}
        except Exception as e:
            traceback.print_exc()
            print(f'Error querying model {model}: {e}')
            return _fail_result(str(e))


async def query_model_result(
    model: str,
    messages: List[Dict[str, str]],
    timeout: float = 120.0,
    max_tokens: Optional[int] = None,
    **stream_options: Any,
) -> Dict[str, Any]:
    """
    Query a single model and always return a result dict.

    Success: {'ok': True, 'content', 'reasoning_details', 'usage'}
    Failure: {'ok': False, 'error': {'status', 'message', 'detail'}}

    Catalogue ids ending in :free share one queue: one call in flight,
    at least three seconds between starts, and at most 16 starts in any
    60-second window. Paid models stay parallel.
    """
    if model_unavailable(model):
        return _skipped_result(_unavailable_skip_message(model))

    async def attempt():
        return await _query_model_attempts(
            model, messages, timeout=timeout, max_tokens=max_tokens,
            **stream_options,
        )

    if is_free_model(model):
        return await run_free_call(attempt)
    return await attempt()


async def query_model(
    model: str,
    messages: List[Dict[str, str]],
    timeout: float = 120.0,
    max_tokens: Optional[int] = None,
) -> Optional[Dict[str, Any]]:
    """
    Query a single model via OpenRouter API.

    Args:
        model: OpenRouter model identifier (e.g., 'openai/gpt-4o')
        messages: List of message dicts with 'role' and 'content'
        timeout: Request timeout in seconds
        max_tokens: Optional completion cap (defaults to OPENROUTER_MAX_TOKENS)

    Returns:
        Response dict with 'content' and optional 'reasoning_details', or None if failed
    """
    result = await query_model_result(
        model, messages, timeout=timeout, max_tokens=max_tokens
    )
    if not result.get('ok'):
        return None
    return {
        'content': result.get('content'),
        'reasoning_details': result.get('reasoning_details'),
        'usage': result.get('usage', {}),
    }
