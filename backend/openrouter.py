"""OpenRouter API client for making LLM requests."""
import asyncio
import time
import traceback
from typing import Any, Dict, List, Optional

import httpx

from .config import OPENROUTER_API_URL
from .settings import settings

OPENROUTER_CREDITS_URL = "https://openrouter.ai/api/v1/credits"
OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models"


def get_api_key() -> Optional[str]:
    """Get the current API key from settings."""
    return settings.api_key

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


async def get_credits() -> Optional[Dict[str, Any]]:
    """
    Get OpenRouter credits information.
    
    Returns:
        Dict with 'total_credits' and 'total_usage', or None if failed
    """
    api_key = get_api_key()
    if not api_key:
        print("Error fetching credits: No API key configured")
        return None
    
    headers = {
        "Authorization": f"Bearer {api_key}",
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
    api_key = get_api_key()
    if not api_key:
        print(f"Error querying model {model}: No API key configured")
        return None
    
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }

    base_model = model.replace('-reasoning-high', '').replace('-reasoning', '')
    is_anthropic = base_model.startswith('anthropic/')

    payload = {
        'model': base_model,
        'messages': messages,
    }
    if 'reasoning-high' in model:
        # Anthropic (Mythos-class) models support a 'max' effort tier; use it for R+.
        payload['reasoning'] = {'effort': 'max' if is_anthropic else 'high'}
    elif 'reasoning' in model:
        payload['reasoning'] = {'effort': 'medium'}

    max_retries = 5
    for attempt in range(max_retries):
        try:
            async with httpx.AsyncClient(timeout=timeout) as client:
                response = await client.post(OPENROUTER_API_URL, headers=headers, json=payload)
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
                    },
                }

        except httpx.HTTPStatusError as e:
            if e.response.status_code == 429 and attempt < max_retries - 1:
                wait = int(e.response.headers.get('Retry-After', 2**attempt))
                print(f'Rate limited for {model}, retrying in {wait}s...')
                await asyncio.sleep(wait)
                continue
            elif e.response.status_code == 404:
                print(f'Model {model} not found (404)')
                return None
            traceback.print_exc()
            print(f'Error querying model {model}: {e}')
            return None
        except Exception as e:
            traceback.print_exc()
            print(f'Error querying model {model}: {e}')
            return None
    return None


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
