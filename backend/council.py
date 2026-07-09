"""3-stage LLM Council orchestration."""

from typing import Any, Dict, List, Tuple, Union

from .openrouter import query_model, query_models_parallel
from .settings import settings


def format_files_for_prompt(files: List[Dict[str, str]]) -> str:
    """Format attached text files for inclusion in LLM prompts."""
    if not files:
        return ''

    parts = []
    for file_info in files:
        name = file_info.get('name', 'file')
        content = file_info.get('content', '')
        parts.append(f'--- Attached file: {name} ---\n{content}\n--- End of {name} ---')
    return '\n\n'.join(parts)


def get_effective_text(text: str, files: List[Dict[str, str]] = None) -> str:
    """Combine user text with attached file contents for text-only stages."""
    file_section = format_files_for_prompt(files or [])
    if text.strip() and file_section:
        return f'{text}\n\n{file_section}'
    if file_section:
        return file_section
    return text


def build_user_message(
    text: str,
    images: List[str] = None,
    files: List[Dict[str, str]] = None,
) -> Union[str, List[Dict]]:
    """
    Build a user message content that can include images and text files.

    Args:
        text: The text content of the message
        images: Optional list of base64 data URLs for images
        files: Optional list of dicts with 'name' and 'content' keys

    Returns:
        Either a simple string (no images) or a list of content parts (with images)
    """
    effective_text = get_effective_text(text, files)

    if not images:
        return effective_text

    content = [{"type": "text", "text": effective_text}]

    for image_url in images:
        content.append({
            "type": "image_url",
            "image_url": {"url": image_url}
        })

    return content


async def stage1_collect_responses(user_query: Union[str, List[Dict]], n: int = None) -> List[Dict[str, Any]]:
    """
    Stage 1: Collect individual responses from all council models.

    Args:
        user_query: The user's question (string or multimodal content list)
        n: Number of samples to collect per model (default: settings.n_samples)

    Returns:
        List of dicts with 'model' and 'response' keys
    """
    if n is None:
        n = settings.n_samples

    messages = [{"role": "user", "content": user_query}]

    # Create tasks for N samples per model
    import asyncio

    tasks = []
    models_expanded = []

    for model in settings.council_models:
        for _ in range(n):
            tasks.append(query_model(model, messages))
            models_expanded.append(model)

    # Query all models in parallel
    raw_responses = await asyncio.gather(*tasks)

    # Format results
    stage1_results = []
    for model, response in zip(models_expanded, raw_responses):
        if response is not None:  # Only include successful responses
            stage1_results.append({
                "model": model,
                "response": response.get('content', ''),
                "usage": response.get('usage', {})
            })

    return stage1_results


async def stage1_collect_responses_streaming(user_query: Union[str, List[Dict]], n: int = None, existing_results: List[Dict] = None):
    """
    Stage 1 with streaming: Collect responses and yield progress events.

    Args:
        user_query: The user's question (string or multimodal content list)
        n: Number of samples to collect per model (default: settings.n_samples)
        existing_results: Optional list of existing results to resume from

    Yields:
        Tuples of (event_type, event_data)
    """
    import asyncio

    if n is None:
        n = settings.n_samples

    messages = [{"role": "user", "content": user_query}]

    # Build list of expected models
    models_expanded = []
    for model in settings.council_models:
        for _ in range(n):
            models_expanded.append(model)

    # Determine which models already have results
    existing_models = set()
    all_results = []
    if existing_results:
        for result in existing_results:
            existing_models.add(result['model'])
            all_results.append(result)

    # Filter out models that already have results
    pending_models = [m for m in models_expanded if m not in existing_models]

    # Send init event
    yield ('init', {
        'total_models': len(models_expanded),
        'pending_models': len(pending_models),
        'existing_count': len(all_results)
    })

    # Replay existing results
    for result in all_results:
        yield ('model_complete', {'result': result, 'existing': True})

    # Query pending models
    if pending_models:
        async def query_with_model(model):
            response = await query_model(model, messages)
            return model, response

        tasks = [query_with_model(model) for model in pending_models]

        for coro in asyncio.as_completed(tasks):
            model, response = await coro
            if response is not None:
                result = {
                    "model": model,
                    "response": response.get('content', ''),
                    "usage": response.get('usage', {})
                }
                all_results.append(result)
                yield ('model_complete', {'result': result, 'existing': False})

    yield ('all_complete', {'results': all_results})


async def stage2_collect_rankings(
    user_query: str,
    stage1_results: List[Dict[str, Any]]
) -> Tuple[List[Dict[str, Any]], Dict[str, str]]:
    """
    Stage 2: Each model ranks the anonymized responses.

    Args:
        user_query: The original user query
        stage1_results: Results from Stage 1

    Returns:
        Tuple of (rankings list, label_to_model mapping)
    """
    # Create anonymized labels for responses (Response 1, Response 2, etc.)
    labels = [str(i + 1) for i in range(len(stage1_results))]  # 1, 2, 3, ...

    # Create mapping from label to model name
    label_to_model = {
        f"Response {label}": result['model']
        for label, result in zip(labels, stage1_results)
    }

    # Build the ranking prompt
    responses_text = "\n\n".join([
        f"Response {label}:\n{result['response']}"
        for label, result in zip(labels, stage1_results)
    ])

    ranking_prompt = f"""You are evaluating different responses to the following question:

Question: {user_query}

Here are the responses from different models (anonymized):

{responses_text}

Your task:
1. First, evaluate each response individually. For each response, explain what it does well and what it does poorly.
2. Then, at the very end of your response, provide a final ranking.

IMPORTANT: Your final ranking MUST be formatted EXACTLY as follows:
- Start with the line "FINAL RANKING:" (all caps, with colon)
- Then list the responses from best to worst as a numbered list
- Each line should be: number, period, space, then ONLY the response label (e.g., "1. Response 1")
- Do not add any other text or explanations in the ranking section

Example of the correct format for your ENTIRE response:

Response 1 provides good detail on X but misses Y...
Response 2 is accurate but lacks depth on Z...
Response 3 offers the most comprehensive answer...

FINAL RANKING:
1. Response 3
2. Response 1
3. Response 2

Now provide your evaluation and ranking:"""

    messages = [{"role": "user", "content": ranking_prompt}]

    # Get rankings from all council models in parallel
    responses = await query_models_parallel(settings.council_models, messages)

    # Format results
    stage2_results = []
    for model, response in responses.items():
        if response is not None:
            full_text = response.get('content', '')
            parsed = parse_ranking_from_text(full_text)
            stage2_results.append({
                "model": model,
                "ranking": full_text,
                "parsed_ranking": parsed,
                "usage": response.get('usage', {})
            })

    return stage2_results, label_to_model


async def stage2_collect_rankings_streaming(
    user_query: str,
    stage1_results: List[Dict[str, Any]]
):
    """
    Stage 2 with streaming: Collect rankings and yield progress events.

    Args:
        user_query: The original user query
        stage1_results: Results from Stage 1

    Yields:
        Tuples of (event_type, event_data)
    """
    import asyncio

    # Create anonymized labels for responses (Response 1, Response 2, etc.)
    labels = [str(i + 1) for i in range(len(stage1_results))]

    # Create mapping from label to model name
    label_to_model = {
        f"Response {label}": result['model']
        for label, result in zip(labels, stage1_results)
    }

    # Build the ranking prompt
    responses_text = "\n\n".join([
        f"Response {label}:\n{result['response']}"
        for label, result in zip(labels, stage1_results)
    ])

    ranking_prompt = f"""You are evaluating different responses to the following question:

Question: {user_query}

Here are the responses from different models (anonymized):

{responses_text}

Your task:
1. First, evaluate each response individually. For each response, explain what it does well and what it does poorly.
2. Then, at the very end of your response, provide a final ranking.

IMPORTANT: Your final ranking MUST be formatted EXACTLY as follows:
- Start with the line "FINAL RANKING:" (all caps, with colon)
- Then list the responses from best to worst as a numbered list
- Each line should be: number, period, space, then ONLY the response label (e.g., "1. Response 1")
- Do not add any other text or explanations in the ranking section

Example of the correct format for your ENTIRE response:

Response 1 provides good detail on X but misses Y...
Response 2 is accurate but lacks depth on Z...
Response 3 offers the most comprehensive answer...

FINAL RANKING:
1. Response 3
2. Response 1
3. Response 2

Now provide your evaluation and ranking:"""

    messages = [{"role": "user", "content": ranking_prompt}]
    models = settings.council_models

    # Send init event
    yield ('init', {
        'total_models': len(models),
        'completed': 0
    })

    # Query models and yield progress
    stage2_results = []

    async def query_with_model(model):
        response = await query_model(model, messages)
        return model, response

    tasks = [query_with_model(model) for model in models]

    for coro in asyncio.as_completed(tasks):
        model, response = await coro
        if response is not None:
            full_text = response.get('content', '')
            parsed = parse_ranking_from_text(full_text)
            result = {
                "model": model,
                "ranking": full_text,
                "parsed_ranking": parsed,
                "usage": response.get('usage', {})
            }
            stage2_results.append(result)
            yield ('model_complete', {'result': result})

    yield ('all_complete', {'results': stage2_results, 'label_to_model': label_to_model})


async def stage3_synthesize_final(
    user_query: str,
    stage1_results: List[Dict[str, Any]],
    stage2_results: List[Dict[str, Any]]
) -> Dict[str, Any]:
    """
    Stage 3: Chairman synthesizes final response.

    Args:
        user_query: The original user query
        stage1_results: Individual model responses from Stage 1
        stage2_results: Rankings from Stage 2

    Returns:
        Dict with 'model' and 'response' keys
    """
    # Build comprehensive context for chairman
    stage1_text = "\n\n".join([
        f"Model: {result['model']}\nResponse: {result['response']}"
        for result in stage1_results
    ])

    stage2_text = "\n\n".join([
        f"Model: {result['model']}\nRanking: {result['ranking']}"
        for result in stage2_results
    ])

    chairman_prompt = f"""You are the Chairman of an LLM Council. Multiple AI models have provided responses to a user's question, and then ranked each other's responses.

Original Question: {user_query}

STAGE 1 - Individual Responses:
{stage1_text}

STAGE 2 - Peer Rankings:
{stage2_text}

Your task as Chairman is to synthesize all of this information into a single, comprehensive, accurate answer to the user's original question. Consider:
- The individual responses and their insights
- The peer rankings and what they reveal about response quality
- Any patterns of agreement or disagreement

Provide a clear, well-reasoned final answer that represents the council's collective wisdom:"""

    messages = [{"role": "user", "content": chairman_prompt}]

    # Query the chairman model
    response = await query_model(settings.chairman_model, messages)

    if response is None:
        # Raise exception so the retry mechanism can handle it
        raise Exception(f'Chairman model ({settings.chairman_model}) failed to generate response')

    return {
        'model': settings.chairman_model,
        'response': response.get('content', ''),
        'usage': response.get('usage', {}),
    }


def parse_ranking_from_text(ranking_text: str) -> List[str]:
    """
    Parse the FINAL RANKING section from the model's response.

    Args:
        ranking_text: The full text response from the model

    Returns:
        List of response labels in ranked order
    """
    import re

    # Look for "FINAL RANKING:" section
    if "FINAL RANKING:" in ranking_text:
        # Extract everything after "FINAL RANKING:"
        parts = ranking_text.split("FINAL RANKING:")
        if len(parts) >= 2:
            ranking_section = parts[1]
            # Try to extract numbered list format (e.g., "1. Response 1")
            # This pattern looks for: number, period, optional space, "Response X"
            numbered_matches = re.findall(r'\d+\.\s*Response \d+', ranking_section)
            if numbered_matches:
                # Extract just the "Response X" part
                return [re.search(r'Response \d+', m).group() for m in numbered_matches]

            # Fallback: Extract all "Response X" patterns in order
            matches = re.findall(r'Response \d+', ranking_section)
            return matches

    # Fallback: try to find any "Response X" patterns in order
    matches = re.findall(r'Response \d+', ranking_text)
    return matches


def calculate_aggregate_rankings(
    stage2_results: List[Dict[str, Any]],
    label_to_model: Dict[str, str]
) -> List[Dict[str, Any]]:
    """
    Calculate aggregate rankings across all models.

    Args:
        stage2_results: Rankings from each model
        label_to_model: Mapping from anonymous labels to model names

    Returns:
        List of dicts with model name and average rank, sorted best to worst
    """
    from collections import defaultdict

    # Track positions for each model
    model_positions = defaultdict(list)

    for ranking in stage2_results:
        ranking_text = ranking['ranking']

        # Parse the ranking from the structured format
        parsed_ranking = parse_ranking_from_text(ranking_text)

        for position, label in enumerate(parsed_ranking, start=1):
            if label in label_to_model:
                model_name = label_to_model[label]
                model_positions[model_name].append(position)

    # Calculate average position for each model
    aggregate = []
    for model, positions in model_positions.items():
        if positions:
            avg_rank = sum(positions) / len(positions)
            aggregate.append({
                "model": model,
                "average_rank": round(avg_rank, 2),
                "rankings_count": len(positions)
            })

    # Sort by average rank (lower is better)
    aggregate.sort(key=lambda x: x['average_rank'])

    return aggregate


async def generate_conversation_title(user_query: str) -> str:
    """
    Generate a short title for a conversation based on the first user message.

    Args:
        user_query: The first user message

    Returns:
        A short title (3-5 words)
    """
    title_prompt = f"""Generate a very short title (3-5 words maximum) that summarizes the following question.
The title should be concise and descriptive. Do not use quotes or punctuation in the title.

Question: {user_query}

Title:"""

    messages = [{"role": "user", "content": title_prompt}]

    # Use gemini-2.5-flash for title generation (fast and cheap)
    response = await query_model("google/gemini-2.5-flash", messages, timeout=30.0)

    if response is None:
        # Fallback to a generic title
        return "New Conversation"

    title = response.get('content', 'New Conversation').strip()

    # Clean up the title - remove quotes, limit length
    title = title.strip('"\'')

    # Truncate if too long
    if len(title) > 50:
        title = title[:47] + "..."

    return title


async def run_full_council(user_query: str) -> Tuple[List, List, Dict, Dict]:
    """
    Run the complete 3-stage council process.

    Args:
        user_query: The user's question

    Returns:
        Tuple of (stage1_results, stage2_results, stage3_result, metadata)
    """
    # Stage 1: Collect individual responses
    stage1_results = await stage1_collect_responses(user_query)

    # If no models responded successfully, return error
    if not stage1_results:
        return [], [], {
            "model": "error",
            "response": "All models failed to respond. Please try again."
        }, {}

    # Stage 2: Collect rankings
    stage2_results, label_to_model = await stage2_collect_rankings(user_query, stage1_results)

    # Calculate aggregate rankings
    aggregate_rankings = calculate_aggregate_rankings(stage2_results, label_to_model)

    # Stage 3: Synthesize final answer
    stage3_result = await stage3_synthesize_final(
        user_query,
        stage1_results,
        stage2_results
    )

    # Prepare metadata
    metadata = {
        "label_to_model": label_to_model,
        "aggregate_rankings": aggregate_rankings
    }

    return stage1_results, stage2_results, stage3_result, metadata
