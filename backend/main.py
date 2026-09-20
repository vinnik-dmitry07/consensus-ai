"""FastAPI backend for LLM Council."""

import asyncio
import json
import uuid
from typing import Any, Dict, List, Optional, Tuple

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from . import storage
from .council import (
    Stage1AllFailed,
    build_council_metadata,
    build_user_message,
    canonical_label_to_model,
    compose_follow_up_query,
    generate_conversation_title,
    get_effective_text,
    pending_stage1_slots,
    retained_stage1_failures,
    run_full_council,
    run_post_ranking,
    stage1_collect_responses_streaming,
    stage2_collect_rankings_streaming,
    stage3_synthesize_final,
)
from .openrouter import (
    CatalogueUnavailable,
    get_credits,
    get_key_info,
    get_models_pricing,
    unknown_catalogue_ids,
)
from .settings import settings

app = FastAPI(title="LLM Council API")

# Enable CORS for local development
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://localhost:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class CreateConversationRequest(BaseModel):
    """Request to create a new conversation."""
    pass


class FileAttachment(BaseModel):
    """A text file attached to a message."""
    name: str
    content: str


class SendMessageRequest(BaseModel):
    """Request to send a message in a conversation."""
    content: str
    images: List[str] = []  # List of base64 data URLs (e.g., "data:image/jpeg;base64,...")
    files: List[FileAttachment] = []
    follow_up_to_message_index: Optional[int] = None


def _get_prior_final_answer(conversation: Dict[str, Any], message_index: int) -> str:
    """Return the Stage 3 response to follow up on."""
    messages = conversation.get('messages', [])
    if message_index < 0 or message_index >= len(messages):
        raise HTTPException(status_code=400, detail='Invalid follow-up message index')

    message = messages[message_index]
    if message.get('role') != 'assistant':
        raise HTTPException(status_code=400, detail='Follow-up must target an assistant message')

    prior_answer = _usable_final_answer(message.get('stage3'))
    if not prior_answer:
        raise HTTPException(status_code=400, detail='No final council answer to follow up on')

    return prior_answer


def _usable_final_answer(stage3: Optional[Dict[str, Any]]) -> Optional[str]:
    """Return Stage 3 text only when it is a real chairman answer."""
    if not stage3 or stage3.get('model') == 'error':
        return None
    text = stage3.get('response')
    if not isinstance(text, str):
        return None
    stripped = text.strip()
    if not stripped or stripped.startswith('Error:'):
        return None
    if stripped == 'All models failed to respond. Please try again.':
        return None
    return text


def _find_latest_follow_up_target(conversation: Dict[str, Any]) -> Optional[int]:
    """Index of the most recent assistant message with a usable Stage 3 answer."""
    messages = conversation.get('messages', [])
    for index in range(len(messages) - 1, -1, -1):
        message = messages[index]
        if message.get('role') != 'assistant':
            continue
        if _usable_final_answer(message.get('stage3')):
            return index
    return None


def _prepare_council_query(
    conversation: Dict[str, Any],
    content: str,
    images: List[str],
    files: List[Dict[str, str]],
    follow_up_to: Optional[int],
):
    """Build council inputs; continuing a thread uses prior final answer + question."""
    target = follow_up_to
    if target is None and not images:
        target = _find_latest_follow_up_target(conversation)

    if target is not None:
        prior_answer = _get_prior_final_answer(conversation, target)
        follow_up_text = get_effective_text(content, files)
        composed = compose_follow_up_query(prior_answer, follow_up_text)
        return composed, composed, target

    user_message = build_user_message(content, images, files)
    query_text = get_effective_text(content, files)
    return user_message, query_text, None


def _rebuild_council_query(conversation: Dict[str, Any], user_msg_index: int):
    """
    Rebuild the council inputs a stored user message was originally run with.

    A retry must ask the same question as the first attempt. Messages recorded
    with 'follow_up_to' were composed against the earlier final answer, so a
    retry has to recompose them; otherwise the council is handed a bare
    fragment ("what about its population?") and answers something else.
    """
    messages = conversation.get('messages', [])
    user_message = messages[user_msg_index]
    content = user_message.get('content', '')
    images = user_message.get('images', []) or []
    files = user_message.get('files', []) or []
    follow_up_to = user_message.get('follow_up_to')

    if follow_up_to is None:
        return build_user_message(content, images, files), get_effective_text(
            content, files
        )

    prior_answer = None
    if 0 <= follow_up_to < len(messages):
        prior_answer = _usable_final_answer(messages[follow_up_to].get('stage3'))
    if not prior_answer:
        raise HTTPException(
            status_code=400,
            detail=(
                'The earlier council answer this message follows up on is no '
                'longer available. Retry that message first.'
            ),
        )

    composed = compose_follow_up_query(
        prior_answer, get_effective_text(content, files)
    )
    return composed, composed


class ConversationMetadata(BaseModel):
    """Conversation metadata for list view."""
    id: str
    created_at: str
    title: str
    message_count: int


class Conversation(BaseModel):
    """Full conversation with all messages."""
    id: str
    created_at: str
    title: str
    messages: List[Dict[str, Any]]


def _files_to_dicts(files: List[FileAttachment]) -> List[Dict[str, str]]:
    return [{'name': f.name, 'content': f.content} for f in files]


async def _post_ranking_metadata(
    query_text: str,
    stage1_results: List[Dict[str, Any]],
    stage2_results: List[Dict[str, Any]],
    label_to_model: Optional[Dict[str, str]] = None,
) -> Dict[str, Any]:
    """Aggregate ranks, red-team the leader, and build persisted metadata."""
    (
        response_rankings,
        aggregate_rankings,
        top_k_indices,
        red_team,
        consensus,
        ranking_fallback,
    ) = await run_post_ranking(query_text, stage1_results, stage2_results)
    return build_council_metadata(
        label_to_model or canonical_label_to_model(stage1_results),
        response_rankings,
        aggregate_rankings,
        top_k_indices,
        red_team,
        consensus,
        ranking_fallback,
    )


async def _run_and_save_post_ranking(
    conversation_id: str,
    msg_index: int,
    query_text: str,
    stage1_results: List[Dict[str, Any]],
    stage2_results: List[Dict[str, Any]],
    label_to_model: Optional[Dict[str, str]] = None,
) -> Tuple[Dict[str, Any], bool, Optional[str]]:
    """Persist post-ranking metadata. Returns (metadata, red_team_ok, error)."""
    try:
        metadata = await _post_ranking_metadata(
            query_text, stage1_results, stage2_results, label_to_model
        )
        storage.update_streaming_message(
            conversation_id, msg_index, metadata=metadata
        )
        red_team = metadata.get('red_team')
        red_ok = bool(red_team) and not red_team.get('error')
        red_error = None
        if red_team and red_team.get('error'):
            red_error = (red_team['error'] or {}).get('message') or 'Red-team review unavailable'
        return metadata, red_ok, red_error
    except Exception as exc:
        metadata = {
            'label_to_model': label_to_model or canonical_label_to_model(stage1_results),
            'response_rankings': [],
            'aggregate_rankings': [],
            'top_k_indices': list(range(min(settings.top_k, len(stage1_results)))),
            'red_team': None,
            'consensus': {
                'level': 'LOW',
                'reasons': [f'Post-ranking failed: {exc}'],
                'leader_index': 0 if stage1_results else None,
                'leader_score': None,
                'leader_mean_correctness': None,
                'top1_agreement': 0.0,
                'disputed_claims': [],
                'red_team_verdict': None,
            },
            'ranking_fallback': True,
        }
        storage.update_streaming_message(
            conversation_id, msg_index, metadata=metadata
        )
        return metadata, False, str(exc)


async def _emit_stage1_sse(
    conversation_id: str,
    msg_index: int,
    user_message,
    collected: Dict[str, Any],
    existing_results: Optional[List[Dict[str, Any]]] = None,
    existing_failures: Optional[List[Dict[str, Any]]] = None,
):
    """Yield Stage 1 SSE lines and persist successes and failures as they land."""
    results: List[Dict[str, Any]] = []
    failures: List[Dict[str, Any]] = []
    council_models = list(settings.council_models)
    pending = pending_stage1_slots(
        council_models, settings.n_samples, existing_results
    )
    if existing_failures:
        storage.update_streaming_message(
            conversation_id,
            msg_index,
            stage1_failures=retained_stage1_failures(
                existing_failures, pending, council_models
            ),
        )
    async for event_type, event_data in stage1_collect_responses_streaming(
        user_message,
        existing_results=existing_results,
        existing_failures=existing_failures,
    ):
        if event_type == 'init':
            yield f"data: {json.dumps({'type': 'stage1_init', 'data': event_data})}\n\n"
        elif event_type == 'model_complete':
            if not event_data.get('existing'):
                storage.append_stage1_result(
                    conversation_id, msg_index, event_data['result']
                )
            yield f"data: {json.dumps({'type': 'stage1_model_complete', 'data': event_data})}\n\n"
        elif event_type == 'model_failed':
            if not event_data.get('existing'):
                storage.append_stage1_failure(conversation_id, msg_index, {
                    'model': event_data['model'],
                    'error': event_data.get('error'),
                })
            yield f"data: {json.dumps({'type': 'stage1_model_failed', 'data': event_data})}\n\n"
        elif event_type == 'all_complete':
            results = event_data['results']
            failures = event_data.get('failures') or []

    collected['results'] = results
    collected['failures'] = failures
    # Write back the full result set, not just the appended ones: a resume may
    # have dropped samples from models the council no longer contains, and the
    # stored Stage 1 must match what Stage 2 actually ranked.
    storage.update_streaming_message(
        conversation_id,
        msg_index,
        stage1=results,
        stage1_complete=bool(results),
        stage1_failures=failures,
    )
    if not results:
        raise Stage1AllFailed(failures)
    yield f"data: {json.dumps({'type': 'stage1_complete', 'data': results, 'failures': failures})}\n\n"


def _stage2_fail_message(failures: List[Dict[str, Any]]) -> str:
    if failures:
        first = (failures[0].get('error') or {}).get('message') or ''
        if first:
            return first
    return 'All models failed to respond in Stage 2'


async def _emit_stage2_sse(
    conversation_id: str,
    msg_index: int,
    query_text: str,
    stage1_results: List[Dict[str, Any]],
    collected: Dict[str, Any],
):
    """Yield Stage 2 SSE lines and keep failures on the collected dict."""
    results: List[Dict[str, Any]] = []
    label_to_model: Dict[str, str] = {}
    failures: List[Dict[str, Any]] = []
    collected['results'] = results
    collected['label_to_model'] = label_to_model
    collected['failures'] = failures

    async for event_type, event_data in stage2_collect_rankings_streaming(
        query_text, stage1_results
    ):
        if event_type == 'init':
            yield f"data: {json.dumps({'type': 'stage2_init', 'data': event_data})}\n\n"
        elif event_type == 'model_complete':
            yield f"data: {json.dumps({'type': 'stage2_model_complete', 'data': event_data})}\n\n"
        elif event_type == 'model_failed':
            failures.append(event_data)
            collected['failures'] = failures
            yield f"data: {json.dumps({'type': 'stage2_model_failed', 'data': event_data})}\n\n"
        elif event_type == 'all_complete':
            results = event_data['results']
            label_to_model = event_data['label_to_model']
            failures = event_data.get('failures') or failures
            collected['results'] = results
            collected['label_to_model'] = label_to_model
            collected['failures'] = failures

    if not results:
        raise Exception(_stage2_fail_message(failures))

    storage.update_streaming_message(
        conversation_id,
        msg_index,
        stage2=results,
        stage2_failures=failures,
        metadata={'label_to_model': label_to_model},
    )
    yield f"data: {json.dumps({'type': 'stage2_complete', 'data': results, 'failures': failures, 'metadata': {'label_to_model': label_to_model}})}\n\n"


def _settle_title_task(conversation_id: str, title_task: "asyncio.Task") -> None:
    """Save an already-finished title, or cancel one still in flight."""
    if not title_task.done():
        title_task.cancel()
        return
    if title_task.cancelled():
        return
    try:
        title = title_task.result()
    except Exception:
        return
    try:
        storage.update_conversation_title(conversation_id, title)
    except Exception:
        pass


def _persist_generic_error(
    conversation_id: str,
    msg_index: int,
    stage: Optional[int],
    exc: Exception,
) -> str:
    storage.update_streaming_message(
        conversation_id,
        msg_index,
        error={'stage': stage, 'message': str(exc)},
        streaming=False,
    )
    return (
        f"data: {json.dumps({'type': 'error', 'stage': stage, 'message': str(exc)})}\n\n"
    )


def _persist_stage2_error(
    conversation_id: str,
    msg_index: int,
    exc: Exception,
    collected: Dict[str, Any],
) -> str:
    failures = collected.get('failures') or []
    storage.update_streaming_message(
        conversation_id,
        msg_index,
        error={'stage': 2, 'message': str(exc)},
        stage2_failures=failures,
        streaming=False,
    )
    return f"data: {json.dumps({'type': 'stage2_error', 'stage': 2, 'message': str(exc), 'failures': failures})}\n\n"


@app.get("/")
async def root():
    """Health check endpoint."""
    return {"status": "ok", "service": "LLM Council API"}


@app.get("/api/credits")
async def get_openrouter_credits():
    """Get OpenRouter credits balance and per-key spend remaining."""
    credits_data, key_data = await asyncio.gather(get_credits(), get_key_info())
    if credits_data is None:
        raise HTTPException(status_code=500, detail='Failed to fetch credits')

    total = credits_data.get('total_credits', 0)
    used = credits_data.get('total_usage', 0)
    remaining = total - used

    payload = {
        'total': total,
        'used': used,
        'remaining': remaining,
    }
    if key_data:
        payload['limit'] = key_data.get('limit')
        payload['limit_remaining'] = key_data.get('limit_remaining')
        payload['limit_reset'] = key_data.get('limit_reset')
    return payload


@app.get("/api/models")
async def list_available_models():
    """List all available models from OpenRouter."""
    models_data = await get_models_pricing()
    
    # Return models sorted by name
    models_list = [
        {
            'id': model_id,
            'name': info.get('name', model_id),
            'pricing': info.get('pricing', {}),
            'description': info.get('description', ''),
        }
        for model_id, info in models_data.items()
    ]
    
    # Sort by name
    models_list.sort(key=lambda x: x["name"].lower())
    
    return {"models": models_list}


class UpdateSettingsRequest(BaseModel):
    """Request to update council settings."""
    council_models: Optional[List[str]] = None
    n_samples: Optional[int] = None
    chairman_model: Optional[str] = None
    top_k: Optional[int] = None
    red_team_model: Optional[str] = None
    self_exclusion: Optional[bool] = None
    api_key: Optional[str] = None


@app.get("/api/settings")
async def get_settings():
    """Get current council settings."""
    return settings.to_dict()


@app.put("/api/settings")
async def update_settings(request: UpdateSettingsRequest):
    """Update council settings."""
    update_data = {}
    if request.council_models is not None:
        update_data['council_models'] = request.council_models
    if request.n_samples is not None:
        update_data['n_samples'] = request.n_samples
    if request.chairman_model is not None:
        update_data['chairman_model'] = request.chairman_model
    if request.top_k is not None:
        update_data['top_k'] = request.top_k
    if request.red_team_model is not None:
        update_data['red_team_model'] = request.red_team_model
    if request.self_exclusion is not None:
        update_data['self_exclusion'] = request.self_exclusion
    if request.api_key is not None:
        update_data['api_key'] = request.api_key

    council = update_data.get('council_models', settings.council_models)
    chairman = update_data.get('chairman_model', settings.chairman_model)
    red_team = update_data.get('red_team_model', settings.red_team_model)
    to_check = list(council) + [chairman]
    if red_team:
        to_check.append(red_team)
    try:
        unknown = await unknown_catalogue_ids(to_check)
    except CatalogueUnavailable:
        raise HTTPException(
            status_code=503,
            detail='Model catalogue unavailable',
        )
    if unknown:
        raise HTTPException(
            status_code=400,
            detail={'unknown_models': unknown},
        )

    settings.update_from_dict(update_data)
    return settings.to_dict()


@app.post("/api/settings/reset")
async def reset_settings():
    """Reset council settings to defaults."""
    settings.reset_to_defaults()
    return settings.to_dict()


@app.get("/api/pricing")
async def get_council_pricing():
    """Get pricing information for all council models."""
    models_pricing = await get_models_pricing()
    
    # Get all models we use (council + chairman)
    all_models = set()
    for model in settings.council_models:
        # Strip reasoning suffixes to get base model
        base_model = model.replace('-reasoning-high', '').replace('-reasoning', '')
        all_models.add(base_model)
    
    chairman_base = settings.chairman_model.replace('-reasoning-high', '').replace('-reasoning', '')
    all_models.add(chairman_base)

    red_team_id = settings.red_team_model or settings.chairman_model
    red_team_base = red_team_id.replace('-reasoning-high', '').replace('-reasoning', '')
    all_models.add(red_team_base)
    
    # Build response with pricing for each model
    pricing_data = {}
    for model_id in all_models:
        if model_id in models_pricing:
            pricing_data[model_id] = models_pricing[model_id]
    
    # Also return the council structure
    return {
        'council_models': settings.council_models,
        'chairman_model': settings.chairman_model,
        'n_samples': settings.n_samples,
        'top_k': settings.top_k,
        'self_exclusion': settings.self_exclusion,
        'red_team_model': settings.red_team_model,
        'pricing': pricing_data,
    }


@app.get("/api/conversations", response_model=List[ConversationMetadata])
async def list_conversations():
    """List all conversations (metadata only)."""
    return storage.list_conversations()


@app.post("/api/conversations", response_model=Conversation)
async def create_conversation(request: CreateConversationRequest):
    """Create a new conversation."""
    conversation_id = str(uuid.uuid4())
    conversation = storage.create_conversation(conversation_id)
    return conversation


@app.get("/api/conversations/{conversation_id}", response_model=Conversation)
async def get_conversation(conversation_id: str):
    """Get a specific conversation with all its messages."""
    conversation = storage.get_conversation(conversation_id)
    if conversation is None:
        raise HTTPException(status_code=404, detail="Conversation not found")
    return conversation


@app.delete("/api/conversations/{conversation_id}")
async def remove_conversation(conversation_id: str):
    """Remove a conversation (soft delete)."""
    try:
        storage.remove_conversation(conversation_id)
        return {"status": "ok"}
    except ValueError:
        raise HTTPException(status_code=404, detail="Conversation not found")


@app.post("/api/conversations/{conversation_id}/message")
async def send_message(conversation_id: str, request: SendMessageRequest):
    """
    Send a message and run the 3-stage council process.
    Returns the complete response with all stages.
    """
    # Check if conversation exists
    conversation = storage.get_conversation(conversation_id)
    if conversation is None:
        raise HTTPException(status_code=404, detail="Conversation not found")

    # Check if this is the first message
    is_first_message = len(conversation["messages"]) == 0

    files = _files_to_dicts(request.files)
    user_message, query_text, follow_up_to = _prepare_council_query(
        conversation,
        request.content,
        request.images,
        files,
        request.follow_up_to_message_index,
    )

    # Add user message
    storage.add_user_message(
        conversation_id,
        request.content,
        request.images,
        files,
        follow_up_to=follow_up_to,
    )

    # If this is the first message, generate a title
    if is_first_message and follow_up_to is None:
        title = await generate_conversation_title(query_text)
        storage.update_conversation_title(conversation_id, title)

    # Run the 3-stage council process
    stage1_results, stage2_results, stage3_result, metadata = await run_full_council(
        user_message
    )

    # Add assistant message with all stages and metadata
    stage1_failures = (metadata or {}).get('stage1_failures') or []
    error = None
    if not stage1_results:
        error = {'stage': 1, 'message': 'All models failed to respond in Stage 1'}
    storage.add_assistant_message(
        conversation_id,
        stage1_results,
        stage2_results,
        stage3_result,
        metadata,
        stage1_failures=stage1_failures,
        error=error,
    )

    # Return the complete response with metadata
    return {
        "stage1": stage1_results,
        "stage2": stage2_results,
        "stage3": stage3_result,
        "metadata": metadata,
        "stage1_failures": stage1_failures,
    }


@app.post("/api/conversations/{conversation_id}/message/stream")
async def send_message_stream(conversation_id: str, request: SendMessageRequest):
    """
    Send a message and stream the 3-stage council process.
    Returns Server-Sent Events as each stage completes.
    """
    # Check if conversation exists
    conversation = storage.get_conversation(conversation_id)
    if conversation is None:
        raise HTTPException(status_code=404, detail="Conversation not found")

    # Check if this is the first message
    is_first_message = len(conversation["messages"]) == 0

    async def event_generator():
        stage1_results = None
        stage2_results = None
        stage3_result = None
        label_to_model = None
        metadata = {}
        current_stage = None
        msg_index = None
        title_task = None

        try:
            files = _files_to_dicts(request.files)
            user_message, query_text, follow_up_to = _prepare_council_query(
                conversation,
                request.content,
                request.images,
                files,
                request.follow_up_to_message_index,
            )

            # Add user message
            storage.add_user_message(
                conversation_id,
                request.content,
                request.images,
                files,
                follow_up_to=follow_up_to,
            )

            # Create empty assistant message for streaming (saved to disk immediately)
            msg_index = storage.create_streaming_assistant_message(conversation_id)

            # Start title generation in parallel (don't await yet)
            if is_first_message and follow_up_to is None:
                title_task = asyncio.create_task(generate_conversation_title(query_text))

            # Stage 1: Collect responses with streaming progress
            current_stage = 1
            yield f"data: {json.dumps({'type': 'stage1_start'})}\n\n"
            try:
                collected = {}
                async for chunk in _emit_stage1_sse(
                    conversation_id, msg_index, user_message, collected
                ):
                    yield chunk
                stage1_results = collected['results']
            except Exception as e:
                failures = []
                if isinstance(e, Stage1AllFailed):
                    failures = e.failures
                elif collected.get('failures'):
                    failures = collected['failures']
                storage.update_streaming_message(
                    conversation_id, msg_index,
                    error={'stage': 1, 'message': str(e)},
                    stage1_failures=failures,
                    streaming=False
                )
                yield f"data: {json.dumps({'type': 'stage1_error', 'stage': 1, 'message': str(e), 'failures': failures})}\n\n"
                return

            # Stage 2: Collect rankings with streaming progress
            current_stage = 2
            yield f"data: {json.dumps({'type': 'stage2_start'})}\n\n"
            collected_s2 = {}
            try:
                async for chunk in _emit_stage2_sse(
                    conversation_id, msg_index, query_text, stage1_results, collected_s2
                ):
                    yield chunk
                stage2_results = collected_s2['results']
                label_to_model = collected_s2['label_to_model']
            except Exception as e:
                yield _persist_stage2_error(conversation_id, msg_index, e, collected_s2)
                return

            current_stage = 2
            yield f"data: {json.dumps({'type': 'redteam_start'})}\n\n"
            metadata, red_team_ok, red_team_error = await _run_and_save_post_ranking(
                conversation_id, msg_index, query_text,
                stage1_results, stage2_results, label_to_model,
            )
            if red_team_ok:
                yield f"data: {json.dumps({'type': 'redteam_complete', 'metadata': metadata})}\n\n"
            else:
                yield f"data: {json.dumps({'type': 'redteam_error', 'message': red_team_error or 'Red-team review unavailable', 'metadata': metadata})}\n\n"

            # Stage 3: Synthesize final answer
            current_stage = 3
            yield f"data: {json.dumps({'type': 'stage3_start'})}\n\n"
            try:
                stage3_result = await stage3_synthesize_final(
                    query_text, stage1_results, stage2_results, metadata
                )
                # Save stage3 and mark streaming complete
                storage.update_streaming_message(
                    conversation_id, msg_index,
                    stage3=stage3_result,
                    streaming=False
                )
                yield f"data: {json.dumps({'type': 'stage3_complete', 'data': stage3_result})}\n\n"
            except Exception as e:
                storage.update_streaming_message(
                    conversation_id, msg_index,
                    error={'stage': 3, 'message': str(e)},
                    streaming=False
                )
                yield f"data: {json.dumps({'type': 'stage3_error', 'stage': 3, 'message': str(e)})}\n\n"
                return

            # Wait for title generation if it was started
            if title_task:
                pending_title, title_task = title_task, None
                try:
                    title = await pending_title
                    storage.update_conversation_title(conversation_id, title)
                    yield f"data: {json.dumps({'type': 'title_complete', 'data': {'title': title}})}\n\n"
                except Exception:
                    # Title generation failed, but continue - not critical
                    pass

            # Send completion event
            yield f"data: {json.dumps({'type': 'complete'})}\n\n"

        except Exception as e:
            if msg_index is not None:
                yield _persist_generic_error(
                    conversation_id, msg_index, current_stage, e
                )
            else:
                yield (
                    f"data: {json.dumps({'type': 'error', 'stage': current_stage, 'message': str(e)})}\n\n"
                )
        finally:
            # Every stage failure returns early, so the title task would
            # otherwise be abandoned mid-flight. Keep the title when the call
            # already came back, and cancel it instead of leaking the task.
            if title_task is not None:
                _settle_title_task(conversation_id, title_task)

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
        }
    )


class RetryStageRequest(BaseModel):
    """Request to retry a failed stage."""
    message_index: int  # Index of the assistant message to retry


@app.post("/api/conversations/{conversation_id}/retry/stage1/stream")
async def retry_stage1_stream(conversation_id: str, request: RetryStageRequest):
    """
    Retry Stage 1 and continue through all stages.
    Returns Server-Sent Events as each stage completes.
    """
    conversation = storage.get_conversation(conversation_id)
    if conversation is None:
        raise HTTPException(status_code=404, detail="Conversation not found")

    messages = conversation.get("messages", [])
    if request.message_index < 0 or request.message_index >= len(messages):
        raise HTTPException(status_code=400, detail="Invalid message index")

    # Get the user message before the assistant message
    user_msg_index = request.message_index - 1
    if user_msg_index < 0 or messages[user_msg_index].get("role") != "user":
        raise HTTPException(status_code=400, detail="Could not find corresponding user message")

    user_message, query_text = _rebuild_council_query(conversation, user_msg_index)

    msg_index = request.message_index
    
    # Get existing stage1 results for resume
    existing_stage1 = messages[msg_index].get("stage1") or []
    existing_failures = messages[msg_index].get('stage1_failures') or []

    async def event_generator():
        stage1_results = None
        stage2_results = None
        stage3_result = None
        label_to_model = None
        metadata = {}
        current_stage = 1

        try:
            # Mark as streaming, clear stage2/stage3 but keep stage1 for resume.
            # The old rankings, metadata and final answer describe a run that is
            # being replaced; leaving them behind would show a finished answer
            # above a Stage 1 that has just been re-collected or has failed.
            storage.update_streaming_message(
                conversation_id, msg_index,
                stage2=None, stage3=None, metadata=None, streaming=True,
                stage1_complete=False, stage2_failures=[],
            )

            # Stage 1: Collect responses with streaming progress (resume from existing)
            yield f"data: {json.dumps({'type': 'stage1_start'})}\n\n"
            try:
                collected = {}
                async for chunk in _emit_stage1_sse(
                    conversation_id,
                    msg_index,
                    user_message,
                    collected,
                    existing_results=existing_stage1,
                    existing_failures=existing_failures,
                ):
                    yield chunk
                stage1_results = collected['results']
            except Exception as e:
                failures = []
                if isinstance(e, Stage1AllFailed):
                    failures = e.failures
                elif collected.get('failures'):
                    failures = collected['failures']
                storage.update_streaming_message(
                    conversation_id, msg_index,
                    error={'stage': 1, 'message': str(e)},
                    stage1_failures=failures,
                    streaming=False
                )
                yield f"data: {json.dumps({'type': 'stage1_error', 'stage': 1, 'message': str(e), 'failures': failures})}\n\n"
                return

            current_stage = 2
            yield f"data: {json.dumps({'type': 'stage2_start'})}\n\n"
            collected_s2 = {}
            try:
                async for chunk in _emit_stage2_sse(
                    conversation_id, msg_index, query_text, stage1_results, collected_s2
                ):
                    yield chunk
                stage2_results = collected_s2['results']
                label_to_model = collected_s2['label_to_model']
            except Exception as e:
                yield _persist_stage2_error(conversation_id, msg_index, e, collected_s2)
                return

            yield f"data: {json.dumps({'type': 'redteam_start'})}\n\n"
            metadata, red_team_ok, red_team_error = await _run_and_save_post_ranking(
                conversation_id, msg_index, query_text,
                stage1_results, stage2_results, label_to_model,
            )
            if red_team_ok:
                yield f"data: {json.dumps({'type': 'redteam_complete', 'metadata': metadata})}\n\n"
            else:
                yield f"data: {json.dumps({'type': 'redteam_error', 'message': red_team_error or 'Red-team review unavailable', 'metadata': metadata})}\n\n"

            # Stage 3: Synthesize final answer
            current_stage = 3
            yield f"data: {json.dumps({'type': 'stage3_start'})}\n\n"
            try:
                stage3_result = await stage3_synthesize_final(
                    query_text, stage1_results, stage2_results, metadata
                )
                storage.update_streaming_message(
                    conversation_id, msg_index,
                    stage3=stage3_result,
                    streaming=False
                )
                yield f"data: {json.dumps({'type': 'stage3_complete', 'data': stage3_result})}\n\n"
            except Exception as e:
                storage.update_streaming_message(
                    conversation_id, msg_index,
                    error={'stage': 3, 'message': str(e)},
                    streaming=False
                )
                yield f"data: {json.dumps({'type': 'stage3_error', 'stage': 3, 'message': str(e)})}\n\n"
                return

            # Send completion event
            yield f"data: {json.dumps({'type': 'complete'})}\n\n"

        except Exception as e:
            yield _persist_generic_error(conversation_id, msg_index, current_stage, e)

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "Connection": "keep-alive"}
    )


@app.post("/api/conversations/{conversation_id}/retry/stage2/stream")
async def retry_stage2_stream(conversation_id: str, request: RetryStageRequest):
    """
    Retry Stage 2 using existing Stage 1 results and continue through Stage 3.
    """
    conversation = storage.get_conversation(conversation_id)
    if conversation is None:
        raise HTTPException(status_code=404, detail="Conversation not found")

    messages = conversation.get("messages", [])
    if request.message_index < 0 or request.message_index >= len(messages):
        raise HTTPException(status_code=400, detail="Invalid message index")

    assistant_msg = messages[request.message_index]
    if assistant_msg.get("role") != "assistant":
        raise HTTPException(status_code=400, detail="Message is not an assistant message")

    stage1_results = assistant_msg.get("stage1")
    if not stage1_results:
        raise HTTPException(status_code=400, detail="Stage 1 results not available. Retry Stage 1 first.")

    # Get user message
    user_msg_index = request.message_index - 1
    if user_msg_index < 0 or messages[user_msg_index].get("role") != "user":
        raise HTTPException(status_code=400, detail="Could not find corresponding user message")

    _, query_text = _rebuild_council_query(conversation, user_msg_index)
    msg_index = request.message_index

    async def event_generator():
        stage2_results = None
        stage3_result = None
        label_to_model = None
        metadata = {}
        current_stage = 2

        try:
            # Mark as streaming and drop the run being replaced, so a Stage 2
            # that fails cannot leave the previous final answer on the message.
            storage.update_streaming_message(
                conversation_id, msg_index,
                stage2=None, stage3=None, metadata=None,
                streaming=True, stage2_failures=[],
            )

            yield f"data: {json.dumps({'type': 'stage2_start'})}\n\n"
            collected_s2 = {}
            try:
                async for chunk in _emit_stage2_sse(
                    conversation_id, msg_index, query_text, stage1_results, collected_s2
                ):
                    yield chunk
                stage2_results = collected_s2['results']
                label_to_model = collected_s2['label_to_model']
            except Exception as e:
                yield _persist_stage2_error(conversation_id, msg_index, e, collected_s2)
                return

            yield f"data: {json.dumps({'type': 'redteam_start'})}\n\n"
            metadata, red_team_ok, red_team_error = await _run_and_save_post_ranking(
                conversation_id, msg_index, query_text,
                stage1_results, stage2_results, label_to_model,
            )
            if red_team_ok:
                yield f"data: {json.dumps({'type': 'redteam_complete', 'metadata': metadata})}\n\n"
            else:
                yield f"data: {json.dumps({'type': 'redteam_error', 'message': red_team_error or 'Red-team review unavailable', 'metadata': metadata})}\n\n"

            # Stage 3: Synthesize final answer
            current_stage = 3
            yield f"data: {json.dumps({'type': 'stage3_start'})}\n\n"
            try:
                stage3_result = await stage3_synthesize_final(
                    query_text, stage1_results, stage2_results, metadata
                )
                storage.update_streaming_message(
                    conversation_id, msg_index,
                    stage3=stage3_result,
                    streaming=False
                )
                yield f"data: {json.dumps({'type': 'stage3_complete', 'data': stage3_result})}\n\n"
            except Exception as e:
                storage.update_streaming_message(
                    conversation_id, msg_index,
                    error={'stage': 3, 'message': str(e)},
                    streaming=False
                )
                yield f"data: {json.dumps({'type': 'stage3_error', 'stage': 3, 'message': str(e)})}\n\n"
                return

            yield f"data: {json.dumps({'type': 'complete'})}\n\n"

        except Exception as e:
            yield _persist_generic_error(conversation_id, msg_index, current_stage, e)

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "Connection": "keep-alive"}
    )


@app.post("/api/conversations/{conversation_id}/retry/stage3/stream")
async def retry_stage3_stream(conversation_id: str, request: RetryStageRequest):
    """
    Retry Stage 3 using existing Stage 1 and Stage 2 results.
    """
    conversation = storage.get_conversation(conversation_id)
    if conversation is None:
        raise HTTPException(status_code=404, detail="Conversation not found")

    messages = conversation.get("messages", [])
    if request.message_index < 0 or request.message_index >= len(messages):
        raise HTTPException(status_code=400, detail="Invalid message index")

    assistant_msg = messages[request.message_index]
    if assistant_msg.get("role") != "assistant":
        raise HTTPException(status_code=400, detail="Message is not an assistant message")

    stage1_results = assistant_msg.get("stage1")
    stage2_results = assistant_msg.get("stage2")

    if not stage1_results:
        raise HTTPException(status_code=400, detail="Stage 1 results not available. Retry Stage 1 first.")
    if not stage2_results:
        raise HTTPException(status_code=400, detail="Stage 2 results not available. Retry Stage 2 first.")

    # Get user message
    user_msg_index = request.message_index - 1
    if user_msg_index < 0 or messages[user_msg_index].get("role") != "user":
        raise HTTPException(status_code=400, detail="Could not find corresponding user message")

    _, query_text = _rebuild_council_query(conversation, user_msg_index)
    msg_index = request.message_index

    async def event_generator():
        metadata = dict(assistant_msg.get('metadata') or {})
        try:
            # Mark as streaming and drop the answer being replaced.
            storage.update_streaming_message(
                conversation_id, msg_index, stage3=None, streaming=True
            )

            label_to_model = metadata.get('label_to_model')
            yield f"data: {json.dumps({'type': 'redteam_start'})}\n\n"
            metadata, red_team_ok, red_team_error = await _run_and_save_post_ranking(
                conversation_id, msg_index, query_text,
                stage1_results, stage2_results, label_to_model,
            )
            if red_team_ok:
                yield f"data: {json.dumps({'type': 'redteam_complete', 'metadata': metadata})}\n\n"
            else:
                yield f"data: {json.dumps({'type': 'redteam_error', 'message': red_team_error or 'Red-team review unavailable', 'metadata': metadata})}\n\n"

            # Stage 3: Synthesize final answer
            yield f"data: {json.dumps({'type': 'stage3_start'})}\n\n"
            try:
                stage3_result = await stage3_synthesize_final(
                    query_text, stage1_results, stage2_results, metadata
                )
                storage.update_streaming_message(
                    conversation_id, msg_index,
                    stage3=stage3_result,
                    streaming=False
                )
                yield f"data: {json.dumps({'type': 'stage3_complete', 'data': stage3_result})}\n\n"
            except Exception as e:
                storage.update_streaming_message(
                    conversation_id, msg_index,
                    error={'stage': 3, 'message': str(e)},
                    streaming=False
                )
                yield f"data: {json.dumps({'type': 'stage3_error', 'stage': 3, 'message': str(e)})}\n\n"
                return
            yield f"data: {json.dumps({'type': 'complete'})}\n\n"

        except Exception as e:
            yield _persist_generic_error(conversation_id, msg_index, 3, e)

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "Connection": "keep-alive"}
    )


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host='127.0.0.1', port=8001)
