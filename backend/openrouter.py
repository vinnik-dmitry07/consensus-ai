"""OpenRouter API client for making LLM requests."""
import asyncio
import time
import traceback
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
from .settings import settings


def get_api_key() -> Optional[str]:
    """Get the current API key from settings."""
    return settings.api_key


def resolve_max_tokens(model: str, override: Optional[int] = None) -> int:
    """Return the completion cap OpenRouter should reserve for this model."""
    if override is not None:
        return max(1, int(override))
    if 'reasoning-high' in model:
        return OPENROUTER_MAX_TOKENS_HIGH
    return OPENROUTER_MAX_TOKENS


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
            detail = str(err.get('message') or err)
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

            # Build cache: model_id -> model info
            _models_cache = {}
            _models_cache_time = time.time()
            for model in data.get('data', []):
                model_id = model.get('id')
                if model_id:
                    _models_cache[model_id] = {
                        'name': model.get('name'),
                        'pricing': model.get('pricing', {}),
                        'description': model.get('description', ''),
                    }
            
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
        print(f'Error fetching {label}: No API key configured')
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


def _fail_result(
    message: str, status: Optional[int] = None, detail: str = ''
) -> Dict[str, Any]:
    return {
        'ok': False,
        'error': {'status': status, 'message': message, 'detail': detail},
    }


async def query_model_result(
    model: str,
    messages: List[Dict[str, str]],
    timeout: float = 120.0,
    max_tokens: Optional[int] = None,
) -> Dict[str, Any]:
    """
    Query a single model and always return a result dict.

    Success: {'ok': True, 'content', 'reasoning_details', 'usage'}
    Failure: {'ok': False, 'error': {'status', 'message', 'detail'}}
    """
    api_key = get_api_key()
    if not api_key:
        print(f'Error querying model {model}: No API key configured')
        return _fail_result('No API key configured')

    headers = {
        'Authorization': f'Bearer {api_key}',
        'Content-Type': 'application/json',
    }

    base_model = model.replace('-reasoning-high', '').replace('-reasoning', '')
    is_anthropic = base_model.lstrip('~').startswith('anthropic/')

    payload = {
        'model': base_model,
        'messages': messages,
        'max_tokens': resolve_max_tokens(model, max_tokens),
    }
    if 'reasoning-high' in model:
        # Anthropic supports 'xhigh' (extra high); use it for R+. Others use 'high'.
        payload['reasoning'] = {'effort': 'xhigh' if is_anthropic else 'high'}
    elif 'reasoning' in model:
        payload['reasoning'] = {'effort': 'high'}

    max_retries = 5
    for attempt in range(max_retries):
        try:
            async with httpx.AsyncClient(timeout=timeout) as client:
                response = await client.post(
                    OPENROUTER_API_URL, headers=headers, json=payload
                )
                response.raise_for_status()

                data = response.json()
                message = data['choices'][0]['message']
                usage = data.get('usage', {})
                content = message.get('content')
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
            if e.response.status_code == 429 and attempt < max_retries - 1:
                wait = int(e.response.headers.get('Retry-After', 2**attempt))
                print(f'Rate limited for {model}, retrying in {wait}s...')
                await asyncio.sleep(wait)
                continue

            error = parse_http_error(e.response)
            if e.response.status_code == 402:
                print(f'Payment required for {model} (402): {error["detail"] or e}')
            elif e.response.status_code == 404:
                print(f'Model {model} not found (404)')
            else:
                traceback.print_exc()
                print(f'Error querying model {model}: {e}')
            return {'ok': False, 'error': error}
        except Exception as e:
            traceback.print_exc()
            print(f'Error querying model {model}: {e}')
            return _fail_result(str(e))
    return _fail_result('HTTP 429: Rate limit exceeded', status=429)


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


async def query_models_parallel(
    models: List[str], messages: List[Dict[str, str]], max_concurrent: int = 5
) -> Dict[str, Optional[Dict[str, Any]]]:
    """
    Query multiple models in parallel with rate limiting.

    Args:
        models: List of OpenRouter model identifiers
        messages: List of message dicts to send to each model
        max_concurrent: Max concurrent requests to avoid rate limits

    Returns:
        Dict mapping model identifier to response dict (or None if failed)
    """
    # Filter out non-existent models first
    available = await get_models_pricing()
    valid_models = []
    for m in models:
        base_model = m.replace('-reasoning-high', '').replace('-reasoning', '')
        if base_model in available:
            valid_models.append(m)
        else:
            print(f'Model {m} not available - skipping')

    semaphore = asyncio.Semaphore(max_concurrent)

    async def limited_query(model: str):
        async with semaphore:
            return await query_model(model, messages)

    tasks = [limited_query(model) for model in valid_models]
    responses = await asyncio.gather(*tasks)

    result = {model: response for model, response in zip(valid_models, responses)}
    # Add None for skipped models
    for m in models:
        if m not in result:
            result[m] = None
    return result
