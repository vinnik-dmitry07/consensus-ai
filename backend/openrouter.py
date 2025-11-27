"""OpenRouter API client for making LLM requests."""
import traceback
from typing import Any, Dict, List, Optional

import httpx

from .config import OPENROUTER_API_KEY, OPENROUTER_API_URL

OPENROUTER_CREDITS_URL = "https://openrouter.ai/api/v1/credits"
OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models"

# Cache for model pricing data
_models_cache: Optional[Dict[str, Dict[str, Any]]] = None


async def get_models_pricing() -> Dict[str, Dict[str, Any]]:
    """
    Fetch and cache model pricing data from OpenRouter.
    
    Returns:
        Dict mapping model ID to pricing info
    """
    global _models_cache
    
    if _models_cache is not None:
        return _models_cache
    
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            response = await client.get(OPENROUTER_MODELS_URL)
            response.raise_for_status()
            data = response.json()
            
            # Build cache: model_id -> pricing info
            _models_cache = {}
            for model in data.get('data', []):
                model_id = model.get('id')
                if model_id:
                    _models_cache[model_id] = {
                        'name': model.get('name'),
                        'pricing': model.get('pricing', {})
                    }
            
            return _models_cache
    except Exception as e:
        print(f"Error fetching models: {e}")
        return {}


async def get_credits() -> Optional[Dict[str, Any]]:
    """
    Get OpenRouter credits information.
    
    Returns:
        Dict with 'total_credits' and 'total_usage', or None if failed
    """
    headers = {
        "Authorization": f"Bearer {OPENROUTER_API_KEY}",
    }
    
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.get(
                OPENROUTER_CREDITS_URL,
                headers=headers
            )
            response.raise_for_status()
            data = response.json()
            return data.get('data')
    except Exception as e:
        print(f"Error fetching credits: {e}")
        return None


async def query_model(
    model: str,
    messages: List[Dict[str, str]],
    timeout: float = 120.0
) -> Optional[Dict[str, Any]]:
    """
    Query a single model via OpenRouter API.

    Args:
        model: OpenRouter model identifier (e.g., "openai/gpt-4o")
        messages: List of message dicts with 'role' and 'content'
        timeout: Request timeout in seconds

    Returns:
        Response dict with 'content' and optional 'reasoning_details', or None if failed
    """
    headers = {
        "Authorization": f"Bearer {OPENROUTER_API_KEY}",
        "Content-Type": "application/json",
    }

    payload = {
        'model': model.replace('-reasoning-high', '').replace('-reasoning', ''),
        'messages': messages,
    }
    if 'reasoning-high' in model:
        payload['reasoning'] = {'effort': 'high'}
    elif 'reasoning' in model:
        payload['reasoning'] = {'effort': 'medium'}

    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            response = await client.post(
                OPENROUTER_API_URL,
                headers=headers,
                json=payload
            )
            response.raise_for_status()

            data = response.json()
            message = data['choices'][0]['message']
            usage = data.get('usage', {})

            return {
                'content': message.get('content'),
                'reasoning_details': message.get('reasoning_details'),
                'usage': {
                    'prompt_tokens': usage.get('prompt_tokens', 0),
                    'completion_tokens': usage.get('completion_tokens', 0),
                    'total_tokens': usage.get('total_tokens', 0),
                }
            }

    except Exception as e:
        traceback.print_exc()
        print(f"Error querying model {model}: {e}")
        return None


async def query_models_parallel(
    models: List[str],
    messages: List[Dict[str, str]]
) -> Dict[str, Optional[Dict[str, Any]]]:
    """
    Query multiple models in parallel.

    Args:
        models: List of OpenRouter model identifiers
        messages: List of message dicts to send to each model

    Returns:
        Dict mapping model identifier to response dict (or None if failed)
    """
    import asyncio

    # Create tasks for all models
    tasks = [query_model(model, messages) for model in models]

    # Wait for all to complete
    responses = await asyncio.gather(*tasks)

    # Map models to their responses
    return {model: response for model, response in zip(models, responses)}
