"""JSON-based storage for conversations."""

import json
import os
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

from .config import DATA_DIR

_CONVERSATION_ID_RE = re.compile(
    r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
    re.IGNORECASE,
)


def ensure_data_dir():
    """Ensure the data directory exists."""
    Path(DATA_DIR).mkdir(parents=True, exist_ok=True)


def get_conversation_path(conversation_id: str) -> str:
    """Return the JSON path for a conversation, or raise on an unsafe id."""
    if not isinstance(conversation_id, str) or not _CONVERSATION_ID_RE.fullmatch(
        conversation_id
    ):
        raise ValueError('Invalid conversation id')

    base = Path(DATA_DIR).resolve()
    path = (base / f'{conversation_id}.json').resolve()
    if not path.is_relative_to(base):
        raise ValueError('Invalid conversation id')
    return str(path)


def create_conversation(conversation_id: str) -> Dict[str, Any]:
    """
    Create a new conversation.

    Args:
        conversation_id: Unique identifier for the conversation

    Returns:
        New conversation dict
    """
    ensure_data_dir()

    conversation = {
        "id": conversation_id,
        'created_at': datetime.now(timezone.utc).isoformat(),
        "title": "New Conversation",
        "messages": [],
        "removed": False
    }

    save_conversation(conversation)
    return conversation


def get_conversation(conversation_id: str) -> Optional[Dict[str, Any]]:
    """
    Load a conversation from storage.

    Args:
        conversation_id: Unique identifier for the conversation

    Returns:
        Conversation dict or None if not found
    """
    try:
        path = get_conversation_path(conversation_id)
    except ValueError:
        return None

    if not os.path.exists(path):
        return None

    with open(path, 'r') as f:
        return json.load(f)


def save_conversation(conversation: Dict[str, Any]):
    """
    Save a conversation to storage.

    Args:
        conversation: Conversation dict to save
    """
    ensure_data_dir()

    path = Path(get_conversation_path(conversation['id']))
    tmp = path.with_name(f'{path.stem}.tmp.json')
    tmp.write_text(json.dumps(conversation, indent=2), encoding='utf-8')
    tmp.replace(path)


def list_conversations() -> List[Dict[str, Any]]:
    """
    List all conversations (metadata only).

    Returns:
        List of conversation metadata dicts
    """
    ensure_data_dir()

    conversations = []
    for filename in os.listdir(DATA_DIR):
        if not filename.endswith('.json'):
            continue
        data = get_conversation(filename[:-5])
        if data is None or data.get('removed'):
            continue
        conversations.append({
            'id': data['id'],
            'created_at': data['created_at'],
            'title': data.get('title', 'New Conversation'),
            'message_count': len(data['messages']),
        })

    # Sort by creation time, newest first
    conversations.sort(key=lambda x: x["created_at"], reverse=True)

    return conversations


def add_user_message(
    conversation_id: str,
    content: str,
    images: List[str] = None,
    files: List[Dict[str, str]] = None,
    follow_up_to: Optional[int] = None,
):
    """
    Add a user message to a conversation.

    Args:
        conversation_id: Conversation identifier
        content: User message content
        images: Optional list of base64 image data URLs
        files: Optional list of attached text files with name and content
    """
    conversation = get_conversation(conversation_id)
    if conversation is None:
        raise ValueError(f"Conversation {conversation_id} not found")

    message = {
        "role": "user",
        "content": content
    }

    if images:
        message["images"] = images

    if files:
        message["files"] = files

    if follow_up_to is not None:
        message["follow_up_to"] = follow_up_to

    conversation["messages"].append(message)

    save_conversation(conversation)


def add_assistant_message(
    conversation_id: str,
    stage1: List[Dict[str, Any]],
    stage2: List[Dict[str, Any]],
    stage3: Dict[str, Any],
    metadata: Optional[Dict[str, Any]] = None,
    stage1_failures: Optional[List[Dict[str, Any]]] = None,
    error: Optional[Dict[str, Any]] = None,
):
    """
    Add an assistant message with all 3 stages to a conversation.

    Args:
        conversation_id: Conversation identifier
        stage1: List of individual model responses
        stage2: List of model rankings
        stage3: Final synthesized response
        metadata: Optional metadata including label_to_model and aggregate_rankings
    """
    conversation = get_conversation(conversation_id)
    if conversation is None:
        raise ValueError(f"Conversation {conversation_id} not found")

    message = {
        "role": "assistant",
        "stage1": stage1,
        "stage2": stage2,
        "stage3": stage3
    }
    
    if metadata:
        message["metadata"] = metadata
    if stage1_failures:
        message['stage1_failures'] = stage1_failures
    if error:
        message['error'] = error

    conversation["messages"].append(message)

    save_conversation(conversation)


def update_conversation_title(conversation_id: str, title: str):
    """
    Update the title of a conversation.

    Args:
        conversation_id: Conversation identifier
        title: New title for the conversation
    """
    conversation = get_conversation(conversation_id)
    if conversation is None:
        raise ValueError(f"Conversation {conversation_id} not found")

    conversation["title"] = title
    save_conversation(conversation)


def remove_conversation(conversation_id: str):
    """Flag a conversation as removed (soft delete)."""
    conversation = get_conversation(conversation_id)
    if conversation is None:
        raise ValueError(f"Conversation {conversation_id} not found")

    conversation["removed"] = True
    save_conversation(conversation)


def add_partial_assistant_message(
    conversation_id: str,
    stage1: Optional[List[Dict[str, Any]]] = None,
    stage2: Optional[List[Dict[str, Any]]] = None,
    stage3: Optional[Dict[str, Any]] = None,
    metadata: Optional[Dict[str, Any]] = None,
    error: Optional[Dict[str, Any]] = None
):
    """
    Add a partial assistant message (when a stage fails).

    Args:
        conversation_id: Conversation identifier
        stage1: List of individual model responses (or None if failed)
        stage2: List of model rankings (or None if failed/not reached)
        stage3: Final synthesized response (or None if failed/not reached)
        metadata: Optional metadata
        error: Error information with 'stage' and 'message' keys
    """
    conversation = get_conversation(conversation_id)
    if conversation is None:
        raise ValueError(f"Conversation {conversation_id} not found")

    message = {
        "role": "assistant",
        "stage1": stage1,
        "stage2": stage2,
        "stage3": stage3
    }
    
    if metadata:
        message["metadata"] = metadata
    
    if error:
        message["error"] = error

    conversation["messages"].append(message)
    save_conversation(conversation)


def create_streaming_assistant_message(conversation_id: str) -> int:
    """
    Create an empty assistant message for streaming.
    Returns the message index.
    """
    conversation = get_conversation(conversation_id)
    if conversation is None:
        raise ValueError(f"Conversation {conversation_id} not found")

    message = {
        "role": "assistant",
        "stage1": [],
        "stage1_failures": [],
        "stage2": None,
        "stage3": None,
        "streaming": True  # Mark as in-progress
    }
    conversation["messages"].append(message)
    save_conversation(conversation)
    return len(conversation["messages"]) - 1


def _append_message_list_item(
    conversation_id: str,
    message_index: int,
    field: str,
    item: Dict[str, Any],
):
    conversation = get_conversation(conversation_id)
    if conversation is None:
        raise ValueError(f'Conversation {conversation_id} not found')

    message = conversation['messages'][message_index]
    if message.get(field) is None:
        message[field] = []
    message[field].append(item)
    save_conversation(conversation)


def append_stage1_result(conversation_id: str, message_index: int, result: Dict[str, Any]):
    """Append a single stage1 result to an assistant message."""
    _append_message_list_item(conversation_id, message_index, 'stage1', result)


def append_stage1_failure(conversation_id: str, message_index: int, failure: Dict[str, Any]):
    """Append a Stage 1 per-model failure as it happens."""
    _append_message_list_item(
        conversation_id, message_index, 'stage1_failures', failure
    )


def update_streaming_message(
    conversation_id: str,
    message_index: int,
    stage2: Optional[List[Dict[str, Any]]] = None,
    stage3: Optional[Dict[str, Any]] = None,
    metadata: Optional[Dict[str, Any]] = None,
    error: Optional[Dict[str, Any]] = None,
    streaming: bool = True,
    stage1_complete: bool = None,
    stage1_failures: Optional[List[Dict[str, Any]]] = None,
    stage2_failures: Optional[List[Dict[str, Any]]] = None,
):
    """
    Update a streaming assistant message with stage2/stage3 results.
    """
    conversation = get_conversation(conversation_id)
    if conversation is None:
        raise ValueError(f"Conversation {conversation_id} not found")

    message = conversation["messages"][message_index]
    
    if stage1_complete is not None:
        message["stage1_complete"] = stage1_complete
    if stage1_failures is not None:
        message['stage1_failures'] = stage1_failures
    if stage2_failures is not None:
        message['stage2_failures'] = stage2_failures
    if stage2 is not None:
        message["stage2"] = stage2
    if stage3 is not None:
        message["stage3"] = stage3
    if metadata is not None:
        message["metadata"] = metadata
    if error is not None:
        message["error"] = error
    elif "error" in message:
        del message["error"]
    
    message["streaming"] = streaming
    save_conversation(conversation)


def update_assistant_message(
    conversation_id: str,
    message_index: int,
    stage1: Optional[List[Dict[str, Any]]] = None,
    stage2: Optional[List[Dict[str, Any]]] = None,
    stage3: Optional[Dict[str, Any]] = None,
    metadata: Optional[Dict[str, Any]] = None,
    error: Optional[Dict[str, Any]] = None
):
    """
    Update an existing assistant message (for retries).

    Args:
        conversation_id: Conversation identifier
        message_index: Index of the message to update
        stage1: List of individual model responses
        stage2: List of model rankings
        stage3: Final synthesized response
        metadata: Optional metadata
        error: Error information (None if no error)
    """
    conversation = get_conversation(conversation_id)
    if conversation is None:
        raise ValueError(f"Conversation {conversation_id} not found")

    if message_index < 0 or message_index >= len(conversation["messages"]):
        raise ValueError(f"Invalid message index: {message_index}")

    message = conversation["messages"][message_index]
    if message.get("role") != "assistant":
        raise ValueError(f"Message at index {message_index} is not an assistant message")

    # Update fields
    message["stage1"] = stage1
    message["stage2"] = stage2
    message["stage3"] = stage3
    
    if metadata:
        message["metadata"] = metadata
    elif "metadata" in message and metadata is None and stage3 is not None:
        # Keep existing metadata if completing successfully
        pass
    
    # Handle error field
    if error:
        message["error"] = error
    elif "error" in message:
        # Remove error if retry succeeded
        del message["error"]

    save_conversation(conversation)