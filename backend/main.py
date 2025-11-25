"""FastAPI backend for LLM Council."""

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from typing import List, Dict, Any, Optional
import uuid
import json
import asyncio

from . import storage
from .council import run_full_council, generate_conversation_title, stage1_collect_responses, stage2_collect_rankings, stage3_synthesize_final, calculate_aggregate_rankings, build_user_message

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


class SendMessageRequest(BaseModel):
    """Request to send a message in a conversation."""
    content: str
    images: List[str] = []  # List of base64 data URLs (e.g., "data:image/jpeg;base64,...")


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


@app.get("/")
async def root():
    """Health check endpoint."""
    return {"status": "ok", "service": "LLM Council API"}


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

    # Add user message
    storage.add_user_message(conversation_id, request.content, request.images)

    # Build the message content for the API
    user_message = build_user_message(request.content, request.images)

    # If this is the first message, generate a title
    if is_first_message:
        title = await generate_conversation_title(request.content)
        storage.update_conversation_title(conversation_id, title)

    # Run the 3-stage council process
    stage1_results, stage2_results, stage3_result, metadata = await run_full_council(
        user_message
    )

    # Add assistant message with all stages and metadata
    storage.add_assistant_message(
        conversation_id,
        stage1_results,
        stage2_results,
        stage3_result,
        metadata
    )

    # Return the complete response with metadata
    return {
        "stage1": stage1_results,
        "stage2": stage2_results,
        "stage3": stage3_result,
        "metadata": metadata
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
        aggregate_rankings = None
        current_stage = None

        try:
            # Add user message
            storage.add_user_message(conversation_id, request.content, request.images)

            # Build the message content for the API
            user_message = build_user_message(request.content, request.images)

            # Start title generation in parallel (don't await yet)
            title_task = None
            if is_first_message:
                title_task = asyncio.create_task(generate_conversation_title(request.content))

            # Stage 1: Collect responses
            current_stage = 1
            yield f"data: {json.dumps({'type': 'stage1_start'})}\n\n"
            try:
                stage1_results = await stage1_collect_responses(user_message)
                if not stage1_results:
                    raise Exception("All models failed to respond in Stage 1")
                yield f"data: {json.dumps({'type': 'stage1_complete', 'data': stage1_results})}\n\n"
            except Exception as e:
                # Save partial message with error
                storage.add_partial_assistant_message(
                    conversation_id,
                    stage1=None,
                    stage2=None,
                    stage3=None,
                    metadata=None,
                    error={'stage': 1, 'message': str(e)}
                )
                yield f"data: {json.dumps({'type': 'stage1_error', 'stage': 1, 'message': str(e)})}\n\n"
                return

            # Stage 2: Collect rankings (text only - rankings don't need images)
            current_stage = 2
            yield f"data: {json.dumps({'type': 'stage2_start'})}\n\n"
            try:
                stage2_results, label_to_model = await stage2_collect_rankings(request.content, stage1_results)
                if not stage2_results:
                    raise Exception("All models failed to respond in Stage 2")
                aggregate_rankings = calculate_aggregate_rankings(stage2_results, label_to_model)
                yield f"data: {json.dumps({'type': 'stage2_complete', 'data': stage2_results, 'metadata': {'label_to_model': label_to_model, 'aggregate_rankings': aggregate_rankings}})}\n\n"
            except Exception as e:
                # Save partial message with stage 1 complete but stage 2 errored
                storage.add_partial_assistant_message(
                    conversation_id,
                    stage1=stage1_results,
                    stage2=None,
                    stage3=None,
                    metadata=None,
                    error={'stage': 2, 'message': str(e)}
                )
                yield f"data: {json.dumps({'type': 'stage2_error', 'stage': 2, 'message': str(e)})}\n\n"
                return

            # Stage 3: Synthesize final answer
            current_stage = 3
            yield f"data: {json.dumps({'type': 'stage3_start'})}\n\n"
            try:
                stage3_result = await stage3_synthesize_final(request.content, stage1_results, stage2_results)
                yield f"data: {json.dumps({'type': 'stage3_complete', 'data': stage3_result})}\n\n"
            except Exception as e:
                # Save partial message with stage 1 and 2 complete but stage 3 errored
                metadata = {
                    'label_to_model': label_to_model,
                    'aggregate_rankings': aggregate_rankings
                }
                storage.add_partial_assistant_message(
                    conversation_id,
                    stage1=stage1_results,
                    stage2=stage2_results,
                    stage3=None,
                    metadata=metadata,
                    error={'stage': 3, 'message': str(e)}
                )
                yield f"data: {json.dumps({'type': 'stage3_error', 'stage': 3, 'message': str(e)})}\n\n"
                return

            # Wait for title generation if it was started
            if title_task:
                try:
                    title = await title_task
                    storage.update_conversation_title(conversation_id, title)
                    yield f"data: {json.dumps({'type': 'title_complete', 'data': {'title': title}})}\n\n"
                except Exception as e:
                    # Title generation failed, but continue - not critical
                    pass

            # Save complete assistant message with metadata
            metadata = {
                'label_to_model': label_to_model,
                'aggregate_rankings': aggregate_rankings
            }
            storage.add_assistant_message(
                conversation_id,
                stage1_results,
                stage2_results,
                stage3_result,
                metadata
            )

            # Send completion event
            yield f"data: {json.dumps({'type': 'complete'})}\n\n"

        except Exception as e:
            # Send generic error event
            yield f"data: {json.dumps({'type': 'error', 'stage': current_stage, 'message': str(e)})}\n\n"

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

    user_message_content = messages[user_msg_index].get("content", "")
    user_images = messages[user_msg_index].get("images", [])
    user_message = build_user_message(user_message_content, user_images)

    async def event_generator():
        stage1_results = None
        stage2_results = None
        stage3_result = None
        label_to_model = None
        aggregate_rankings = None

        try:
            # Stage 1: Collect responses
            yield f"data: {json.dumps({'type': 'stage1_start'})}\n\n"
            try:
                stage1_results = await stage1_collect_responses(user_message)
                if not stage1_results:
                    raise Exception("All models failed to respond in Stage 1")
                yield f"data: {json.dumps({'type': 'stage1_complete', 'data': stage1_results})}\n\n"
            except Exception as e:
                storage.update_assistant_message(
                    conversation_id, request.message_index,
                    stage1=None, stage2=None, stage3=None, metadata=None,
                    error={'stage': 1, 'message': str(e)}
                )
                yield f"data: {json.dumps({'type': 'stage1_error', 'stage': 1, 'message': str(e)})}\n\n"
                return

            # Stage 2: Collect rankings
            yield f"data: {json.dumps({'type': 'stage2_start'})}\n\n"
            try:
                stage2_results, label_to_model = await stage2_collect_rankings(user_message_content, stage1_results)
                if not stage2_results:
                    raise Exception("All models failed to respond in Stage 2")
                aggregate_rankings = calculate_aggregate_rankings(stage2_results, label_to_model)
                yield f"data: {json.dumps({'type': 'stage2_complete', 'data': stage2_results, 'metadata': {'label_to_model': label_to_model, 'aggregate_rankings': aggregate_rankings}})}\n\n"
            except Exception as e:
                storage.update_assistant_message(
                    conversation_id, request.message_index,
                    stage1=stage1_results, stage2=None, stage3=None, metadata=None,
                    error={'stage': 2, 'message': str(e)}
                )
                yield f"data: {json.dumps({'type': 'stage2_error', 'stage': 2, 'message': str(e)})}\n\n"
                return

            # Stage 3: Synthesize final answer
            yield f"data: {json.dumps({'type': 'stage3_start'})}\n\n"
            try:
                stage3_result = await stage3_synthesize_final(user_message_content, stage1_results, stage2_results)
                yield f"data: {json.dumps({'type': 'stage3_complete', 'data': stage3_result})}\n\n"
            except Exception as e:
                metadata = {'label_to_model': label_to_model, 'aggregate_rankings': aggregate_rankings}
                storage.update_assistant_message(
                    conversation_id, request.message_index,
                    stage1=stage1_results, stage2=stage2_results, stage3=None, metadata=metadata,
                    error={'stage': 3, 'message': str(e)}
                )
                yield f"data: {json.dumps({'type': 'stage3_error', 'stage': 3, 'message': str(e)})}\n\n"
                return

            # Save complete assistant message
            metadata = {'label_to_model': label_to_model, 'aggregate_rankings': aggregate_rankings}
            storage.update_assistant_message(
                conversation_id, request.message_index,
                stage1=stage1_results, stage2=stage2_results, stage3=stage3_result, metadata=metadata,
                error=None
            )
            yield f"data: {json.dumps({'type': 'complete'})}\n\n"

        except Exception as e:
            yield f"data: {json.dumps({'type': 'error', 'message': str(e)})}\n\n"

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

    user_message_content = messages[user_msg_index].get("content", "")

    async def event_generator():
        stage2_results = None
        stage3_result = None
        label_to_model = None
        aggregate_rankings = None

        try:
            # Stage 2: Collect rankings
            yield f"data: {json.dumps({'type': 'stage2_start'})}\n\n"
            try:
                stage2_results, label_to_model = await stage2_collect_rankings(user_message_content, stage1_results)
                if not stage2_results:
                    raise Exception("All models failed to respond in Stage 2")
                aggregate_rankings = calculate_aggregate_rankings(stage2_results, label_to_model)
                yield f"data: {json.dumps({'type': 'stage2_complete', 'data': stage2_results, 'metadata': {'label_to_model': label_to_model, 'aggregate_rankings': aggregate_rankings}})}\n\n"
            except Exception as e:
                storage.update_assistant_message(
                    conversation_id, request.message_index,
                    stage1=stage1_results, stage2=None, stage3=None, metadata=None,
                    error={'stage': 2, 'message': str(e)}
                )
                yield f"data: {json.dumps({'type': 'stage2_error', 'stage': 2, 'message': str(e)})}\n\n"
                return

            # Stage 3: Synthesize final answer
            yield f"data: {json.dumps({'type': 'stage3_start'})}\n\n"
            try:
                stage3_result = await stage3_synthesize_final(user_message_content, stage1_results, stage2_results)
                yield f"data: {json.dumps({'type': 'stage3_complete', 'data': stage3_result})}\n\n"
            except Exception as e:
                metadata = {'label_to_model': label_to_model, 'aggregate_rankings': aggregate_rankings}
                storage.update_assistant_message(
                    conversation_id, request.message_index,
                    stage1=stage1_results, stage2=stage2_results, stage3=None, metadata=metadata,
                    error={'stage': 3, 'message': str(e)}
                )
                yield f"data: {json.dumps({'type': 'stage3_error', 'stage': 3, 'message': str(e)})}\n\n"
                return

            # Save complete assistant message
            metadata = {'label_to_model': label_to_model, 'aggregate_rankings': aggregate_rankings}
            storage.update_assistant_message(
                conversation_id, request.message_index,
                stage1=stage1_results, stage2=stage2_results, stage3=stage3_result, metadata=metadata,
                error=None
            )
            yield f"data: {json.dumps({'type': 'complete'})}\n\n"

        except Exception as e:
            yield f"data: {json.dumps({'type': 'error', 'message': str(e)})}\n\n"

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
    metadata = assistant_msg.get("metadata", {})

    if not stage1_results:
        raise HTTPException(status_code=400, detail="Stage 1 results not available. Retry Stage 1 first.")
    if not stage2_results:
        raise HTTPException(status_code=400, detail="Stage 2 results not available. Retry Stage 2 first.")

    # Get user message
    user_msg_index = request.message_index - 1
    if user_msg_index < 0 or messages[user_msg_index].get("role") != "user":
        raise HTTPException(status_code=400, detail="Could not find corresponding user message")

    user_message_content = messages[user_msg_index].get("content", "")

    async def event_generator():
        try:
            # Stage 3: Synthesize final answer
            yield f"data: {json.dumps({'type': 'stage3_start'})}\n\n"
            try:
                stage3_result = await stage3_synthesize_final(user_message_content, stage1_results, stage2_results)
                yield f"data: {json.dumps({'type': 'stage3_complete', 'data': stage3_result})}\n\n"
            except Exception as e:
                storage.update_assistant_message(
                    conversation_id, request.message_index,
                    stage1=stage1_results, stage2=stage2_results, stage3=None, metadata=metadata,
                    error={'stage': 3, 'message': str(e)}
                )
                yield f"data: {json.dumps({'type': 'stage3_error', 'stage': 3, 'message': str(e)})}\n\n"
                return

            # Save complete assistant message
            storage.update_assistant_message(
                conversation_id, request.message_index,
                stage1=stage1_results, stage2=stage2_results, stage3=stage3_result, metadata=metadata,
                error=None
            )
            yield f"data: {json.dumps({'type': 'complete'})}\n\n"

        except Exception as e:
            yield f"data: {json.dumps({'type': 'error', 'message': str(e)})}\n\n"

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "Connection": "keep-alive"}
    )


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8001)
