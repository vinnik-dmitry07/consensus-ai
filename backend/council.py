"""3-stage LLM Council orchestration."""

import asyncio
import hashlib
import random
import re
from collections import Counter, defaultdict
from typing import Any, Dict, List, Optional, Tuple, Union

from .config import TITLE_MODEL
from .openrouter import (
    model_family,
    query_model,
    query_model_result,
)
from .settings import settings

# Colon may sit inside or outside bold: **LABEL:** or **LABEL**:
_HEADING = r'\*{0,2}%s\*{0,2}\s*:\s*\*{0,2}'
_RESPONSE_N = r'\*{0,2}Response\s+(\d+)\*{0,2}'
# Line-start headers only. Colon-less "Response N" must be the whole line
# so in-prose mentions do not open a new block.
_RESPONSE_HEADER = re.compile(
    r'(?m)^\s*(?:\d+\.\s*)?\*{0,2}Response\s+(\d+)\*{0,2}'
    r'(?:\s*:\s*\*{0,2}|\s*\*{0,2}\s*$)'
)


class Stage1AllFailed(Exception):
    """Every Stage 1 sample failed; per-model errors are on .failures."""

    def __init__(self, failures: List[Dict[str, Any]]):
        super().__init__('All models failed to respond in Stage 1')
        self.failures = failures


def usable_stage1_results(
    council_models: List[str],
    n: int,
    existing_results: Optional[List[Dict[str, Any]]] = None,
) -> List[Dict[str, Any]]:
    """
    Prior Stage 1 samples a resume may still reuse, in their original order.

    The council can be edited between the first attempt and the retry, so drop
    answers from models that are no longer on it and any sample beyond the
    current n_samples. Keeping them would let a model the user removed win the
    ranking and reach the chairman.
    """
    allowed = set(council_models)
    kept: List[Dict[str, Any]] = []
    used: Counter = Counter()
    for result in existing_results or []:
        model = result.get('model')
        if model not in allowed or used[model] >= n:
            continue
        used[model] += 1
        kept.append(result)
    return kept


def pending_stage1_slots(
    council_models: List[str],
    n: int,
    existing_results: Optional[List[Dict[str, Any]]] = None,
) -> List[str]:
    """Remaining Stage 1 samples after counting existing successes per model."""
    used = Counter(
        result['model']
        for result in usable_stage1_results(council_models, n, existing_results)
    )
    pending = []
    for model in council_models:
        pending.extend([model] * max(0, n - used[model]))
    return pending


def retained_stage1_failures(
    existing_failures: Optional[List[Dict[str, Any]]],
    pending_models: List[str],
    council_models: Optional[List[str]] = None,
) -> List[Dict[str, Any]]:
    """Keep prior failures only for council models that will not be queried again."""
    pending_set = set(pending_models)
    allowed = set(council_models) if council_models is not None else None
    return [
        failure
        for failure in (existing_failures or [])
        if failure.get('model') not in pending_set
        and (allowed is None or failure.get('model') in allowed)
    ]


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


def compose_follow_up_query(prior_answer: str, follow_up: str) -> str:
    """Build council input when continuing an existing thread."""
    return (
        f'Previous council answer:\n\n{prior_answer}\n\n'
        f'User message:\n\n{follow_up}'
    )


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

    content = [{'type': 'text', 'text': effective_text}]

    for image_url in images:
        content.append({
            'type': 'image_url',
            'image_url': {'url': image_url},
        })

    return content


def canonical_label_to_model(stage1_results: List[Dict[str, Any]]) -> Dict[str, str]:
    """Map Response i+1 labels to Stage 1 model ids (canonical order)."""
    return {
        f'Response {i + 1}': result['model']
        for i, result in enumerate(stage1_results)
    }


def _as_int_keyed(mapping: Optional[Dict]) -> Dict[int, Any]:
    """Coerce JSON string keys back to ints; skip unparseable keys."""
    if not mapping:
        return {}
    out = {}
    for key, value in mapping.items():
        try:
            out[int(key)] = value
        except (TypeError, ValueError):
            continue
    return out


def build_judge_view(
    judge_model: str,
    stage1_results: List[Dict[str, Any]],
    query_text: str,
    self_exclusion: bool = None,
) -> Dict[str, Any]:
    """
    Build a per-judge candidate set: exclude own family, then seeded shuffle.

    Returns:
        candidates, label_to_index (judge label -> canonical Stage 1 index),
        self_excluded
    """
    if self_exclusion is None:
        self_exclusion = settings.self_exclusion

    all_indices = list(range(len(stage1_results)))
    judge_family = model_family(judge_model)

    if self_exclusion:
        eligible = [
            i for i in all_indices
            if model_family(stage1_results[i]['model']) != judge_family
        ]
        excluded = True
        if not eligible:
            eligible = all_indices
            excluded = False
    else:
        eligible = all_indices
        excluded = False

    seed_src = f'{judge_model}\0{query_text}'.encode('utf-8')
    rng = random.Random(int(hashlib.sha256(seed_src).hexdigest(), 16))
    shuffled = list(eligible)
    rng.shuffle(shuffled)

    label_to_index = {
        f'Response {i + 1}': idx
        for i, idx in enumerate(shuffled)
    }
    candidates = [
        {
            'label': f'Response {i + 1}',
            'index': idx,
            'response': stage1_results[idx].get('response', ''),
        }
        for i, idx in enumerate(shuffled)
    ]
    return {
        'candidates': candidates,
        'label_to_index': label_to_index,
        'self_excluded': excluded,
    }


def build_stage2_prompt(query_text: str, candidates: List[Dict[str, Any]]) -> str:
    """Structured Stage 2 prompt: correctness, issues, disputed claims, ranking."""
    responses_text = '\n\n'.join(
        f"{c['label']}:\n{c['response']}" for c in candidates
    )
    return f'''You are evaluating different responses to the following question.

Question: {query_text}

Here are the responses from different models (anonymized):

{responses_text}

Your task:
1. Evaluate each response independently. For each one, briefly say what it does well and poorly, then give an absolute correctness score and list concrete factual or logical issues.
2. List claims that are disputed, contradicted, or unverified across the responses. If every response shares the same error, you MUST report it — do not assume that agreement implies correctness.
3. Then, at the very end, provide a final ranking from best to worst.

IMPORTANT: Use this exact structure (markers in all caps where shown):

Response 1:
<brief evaluation>
Correctness: 8/10
Issues: <concrete factual/logical errors, or none>

Response 2:
<brief evaluation>
Correctness: 5/10
Issues: <concrete factual/logical errors, or none>

(repeat for every response)

DISPUTED CLAIMS:
- <claim> (asserted by Response x, y; contradicted by / unverified)
(or none)

FINAL RANKING:
1. Response 2
2. Response 1

Rules for FINAL RANKING:
- Start with the line "FINAL RANKING:" (all caps, with colon)
- Numbered list from best to worst
- Each line: number, period, space, then ONLY the response label (e.g., "1. Response 1")
- No extra text after the ranking section

Now provide your evaluation and ranking:'''


def parse_ranking_from_text(ranking_text: str) -> List[str]:
    """
    Parse the FINAL RANKING section from the model's response.

    Args:
        ranking_text: The full text response from the model

    Returns:
        List of response labels in ranked order
    """
    if ranking_text is None:
        return []

    header = re.search(_HEADING % 'FINAL RANKING', ranking_text, re.IGNORECASE)
    section = ranking_text[header.end():] if header else ranking_text
    numbered = re.findall(rf'\d+\.\s*{_RESPONSE_N}', section)
    if numbered:
        return [f'Response {n}' for n in numbered]
    return [f'Response {n}' for n in re.findall(_RESPONSE_N, section)]


def _evaluation_section(text: str) -> str:
    text = re.split(
        _HEADING % 'DISPUTED CLAIMS', text, maxsplit=1, flags=re.IGNORECASE
    )[0]
    return re.split(
        _HEADING % 'FINAL RANKING', text, maxsplit=1, flags=re.IGNORECASE
    )[0]


def _iter_response_blocks(text: str):
    """Yield (label, block_body) for each Response N: section."""
    section = _evaluation_section(text)
    matches = list(_RESPONSE_HEADER.finditer(section))
    for i, match in enumerate(matches):
        label = f'Response {match.group(1)}'
        start = match.end()
        end = matches[i + 1].start() if i + 1 < len(matches) else len(section)
        yield label, section[start:end]


def parse_correctness_scores(text: str) -> Dict[str, Optional[float]]:
    """Parse Correctness: N/10 per Response label. Missing score -> None."""
    scores: Dict[str, Optional[float]] = {}
    if not text:
        return scores
    for label, block in _iter_response_blocks(text):
        match = re.search(
            _HEADING % 'Correctness' + r'\s*\*{0,2}(\d+(?:\.\d+)?)\*{0,2}\s*(?:/\s*10)?',
            block,
            re.IGNORECASE,
        )
        if match:
            scores[label] = max(0.0, min(10.0, float(match.group(1))))
        else:
            scores[label] = None
    return scores


def parse_issues(text: str) -> Dict[str, List[str]]:
    """Parse Issues: lines per Response label. 'none' -> []."""
    issues: Dict[str, List[str]] = {}
    if not text:
        return issues
    none_tokens = {'none', 'none.', 'n/a', 'na', '-', '—'}
    for label, block in _iter_response_blocks(text):
        match = re.search(
            rf'{_HEADING % "Issues"}\s*(.*)',
            block,
            re.IGNORECASE | re.DOTALL,
        )
        if not match:
            issues[label] = []
            continue
        raw = match.group(1).strip()
        raw = re.split(r'\n\s*\n', raw, maxsplit=1)[0].strip()
        if not raw or raw.lower() in none_tokens:
            issues[label] = []
            continue
        items = []
        for line in re.split(r'[\n;]+', raw):
            cleaned = line.strip().lstrip('-*•').strip()
            if cleaned and cleaned.lower() not in none_tokens:
                items.append(cleaned)
        issues[label] = items
    return issues


def parse_disputed_claims(text: str) -> List[str]:
    """Parse the DISPUTED CLAIMS section. 'none' -> []."""
    if not text:
        return []
    heading = re.search(_HEADING % 'DISPUTED CLAIMS', text, re.IGNORECASE)
    if not heading:
        return []
    section = text[heading.end():]
    section = re.split(
        _HEADING % 'FINAL RANKING', section, maxsplit=1, flags=re.IGNORECASE
    )[0]
    stripped = section.strip()
    if re.match(r'^(none|n/a|na|-|—)\.?\s*$', stripped, re.IGNORECASE):
        return []
    claims = []
    none_tokens = {'none', 'none.', 'n/a', 'na', '-', '—'}
    for line in section.splitlines():
        cleaned = line.strip().lstrip('-*•').strip()
        if not cleaned or cleaned.lower() in none_tokens:
            continue
        claims.append(cleaned)
    return claims


def map_ranking_to_indices(
    parsed_labels: List[str],
    label_to_index: Dict[str, int],
) -> List[int]:
    """Map judge-facing Response labels to canonical Stage 1 indices."""
    ranked = []
    seen = set()
    for label in parsed_labels:
        idx = label_to_index.get(label)
        if idx is None:
            continue
        idx = int(idx)
        if idx in seen:
            continue
        ranked.append(idx)
        seen.add(idx)
    return ranked


def resolve_ranked_indices(ranking: Dict[str, Any]) -> List[int]:
    """Canonical ranked indices from a Stage 2 result, with fallbacks."""
    stored = ranking.get('ranked_indices')
    if stored:
        return [int(i) for i in stored]

    parsed = ranking.get('parsed_ranking') or parse_ranking_from_text(
        ranking.get('ranking', '') or ''
    )
    mapping = ranking.get('label_to_index') or {}
    if mapping:
        mapping = {k: int(v) for k, v in mapping.items()}
        return map_ranking_to_indices(parsed, mapping)

    indices = []
    seen = set()
    for label in parsed:
        match = re.search(r'(\d+)', label)
        if not match:
            continue
        idx = int(match.group(1)) - 1
        if idx in seen:
            continue
        indices.append(idx)
        seen.add(idx)
    return indices


def format_stage2_result(
    model: str,
    response: Dict[str, Any],
    view: Dict[str, Any],
) -> Dict[str, Any]:
    """Parse a judge reply into a Stage 2 result dict."""
    full_text = response.get('content', '') or ''
    parsed = parse_ranking_from_text(full_text)
    label_to_index = view['label_to_index']
    ranked_indices = map_ranking_to_indices(parsed, label_to_index)
    correctness_labels = parse_correctness_scores(full_text)
    issues_labels = parse_issues(full_text)
    correctness = {}
    issues = {}
    for label, idx in label_to_index.items():
        correctness[str(idx)] = correctness_labels.get(label)
        issues[str(idx)] = issues_labels.get(label, [])
    return {
        'model': model,
        'ranking': full_text,
        'parsed_ranking': parsed,
        'ranked_indices': ranked_indices,
        'label_to_index': label_to_index,
        'correctness': correctness,
        'issues': issues,
        'disputed_claims': parse_disputed_claims(full_text),
        'self_excluded': view['self_excluded'],
        'usage': response.get('usage', {}),
    }


async def stage1_collect_responses(
    user_query: Union[str, List[Dict]],
    n: int = None,
) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
    """
    Stage 1: Collect individual responses from all council models.

    Returns:
        (results, failures) — failures keep the structured OpenRouter error
    """
    if n is None:
        n = settings.n_samples

    messages = [{'role': 'user', 'content': user_query}]
    models_expanded = pending_stage1_slots(settings.council_models, n)

    tasks = [query_model_result(model, messages) for model in models_expanded]
    raw_responses = await asyncio.gather(*tasks)

    stage1_results = []
    failures = []
    for model, response in zip(models_expanded, raw_responses):
        if response.get('ok'):
            stage1_results.append({
                'model': model,
                'response': response.get('content', ''),
                'usage': response.get('usage', {}),
            })
        else:
            failures.append({'model': model, 'error': response['error']})

    return stage1_results, failures


async def stage1_collect_responses_streaming(
    user_query: Union[str, List[Dict]],
    n: int = None,
    existing_results: List[Dict] = None,
    existing_failures: List[Dict] = None,
):
    """
    Stage 1 with streaming: Collect responses and yield progress events.

    Resume counts successes per model against n_samples. Prior failures for
    models still being queried are dropped; the rest are replayed.
    """
    if n is None:
        n = settings.n_samples

    messages = [{'role': 'user', 'content': user_query}]
    council_models = list(settings.council_models)
    total_slots = len(council_models) * n
    all_results = usable_stage1_results(council_models, n, existing_results)
    pending_models = pending_stage1_slots(council_models, n, all_results)
    failures = retained_stage1_failures(
        existing_failures, pending_models, council_models
    )

    yield ('init', {
        'total_models': total_slots,
        'pending_models': len(pending_models),
        'existing_count': len(all_results) + len(failures),
    })

    for result in all_results:
        yield ('model_complete', {'result': result, 'existing': True})

    for failure in failures:
        yield ('model_failed', {**failure, 'existing': True})

    if pending_models:
        async def query_with_model(model):
            response = await query_model_result(model, messages)
            return model, response

        tasks = [query_with_model(model) for model in pending_models]

        for coro in asyncio.as_completed(tasks):
            model, response = await coro
            if response.get('ok'):
                result = {
                    'model': model,
                    'response': response.get('content', ''),
                    'usage': response.get('usage', {}),
                }
                all_results.append(result)
                yield ('model_complete', {'result': result, 'existing': False})
            else:
                failure = {'model': model, 'error': response['error']}
                failures.append(failure)
                yield ('model_failed', failure)

    yield ('all_complete', {'results': all_results, 'failures': failures})


async def stage2_collect_rankings_streaming(
    user_query: str,
    stage1_results: List[Dict[str, Any]],
):
    """
    Stage 2 with streaming: per-judge views, then yield progress events.

    Yields:
        Tuples of (event_type, event_data)
    """
    label_to_model = canonical_label_to_model(stage1_results)
    models = list(settings.council_models)

    yield ('init', {
        'total_models': len(models),
        'completed': 0,
    })

    stage2_results = []

    async def query_with_model(model):
        view = build_judge_view(model, stage1_results, user_query)
        prompt = build_stage2_prompt(user_query, view['candidates'])
        response = await query_model_result(model, [{'role': 'user', 'content': prompt}])
        return model, response, view

    tasks = [query_with_model(model) for model in models]
    failures = []

    for coro in asyncio.as_completed(tasks):
        model, response, view = await coro
        if response.get('ok'):
            result = format_stage2_result(model, response, view)
            stage2_results.append(result)
            yield ('model_complete', {'result': result})
        else:
            failure = {'model': model, 'error': response['error']}
            failures.append(failure)
            yield ('model_failed', failure)

    yield ('all_complete', {
        'results': stage2_results,
        'label_to_model': label_to_model,
        'failures': failures,
    })


async def stage2_collect_rankings(
    user_query: str,
    stage1_results: List[Dict[str, Any]],
) -> Tuple[List[Dict[str, Any]], Dict[str, str]]:
    """
    Stage 2: Each model ranks the anonymized responses.

    Thin wrapper around the streaming implementation.

    Returns:
        Tuple of (rankings list, canonical label_to_model mapping)
    """
    stage2_results = []
    label_to_model = canonical_label_to_model(stage1_results)
    async for event_type, event_data in stage2_collect_rankings_streaming(
        user_query, stage1_results
    ):
        if event_type == 'all_complete':
            stage2_results = event_data['results']
            label_to_model = event_data['label_to_model']
    return stage2_results, label_to_model


def calculate_aggregate_rankings(
    stage1_results: List[Dict[str, Any]],
    stage2_results: List[Dict[str, Any]],
) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]], bool]:
    """
    Aggregate per-response and per-model scores from Stage 2.

    Per-response score is the mean normalized Borda
    (M_j - pos) / (M_j - 1) over judges with M_j >= 2.

    Returns:
        (response_rankings, aggregate_rankings, ranking_fallback)
    """
    n = len(stage1_results)
    borda_scores = defaultdict(list)
    correctness_scores = defaultdict(list)
    merged_issues = defaultdict(list)
    seen_issues = defaultdict(set)
    top1_votes = defaultdict(int)

    for ranking in stage2_results:
        ranked = resolve_ranked_indices(ranking)
        shown = ranking.get('label_to_index') or {}
        # Score listed candidates against the shown set. Unranked shown
        # candidates abstain (no 0), so a lazy top-3 list inflates those
        # three scores instead of treating 3rd-of-3 as last place.
        m_j = len(shown) if shown else len(ranked)
        if m_j >= 2:
            for pos, idx in enumerate(ranked, start=1):
                if 0 <= idx < n:
                    borda_scores[idx].append((m_j - pos) / (m_j - 1))
        if ranked and 0 <= ranked[0] < n:
            top1_votes[ranked[0]] += 1

        for idx, score in _as_int_keyed(ranking.get('correctness')).items():
            if score is not None and 0 <= idx < n:
                correctness_scores[idx].append(float(score))

        for idx, items in _as_int_keyed(ranking.get('issues')).items():
            if not items or not (0 <= idx < n):
                continue
            for item in items:
                key = item.lower()
                if key in seen_issues[idx]:
                    continue
                seen_issues[idx].add(key)
                merged_issues[idx].append(item)

    response_rankings = []
    for i in range(n):
        scores = borda_scores.get(i, [])
        corr = correctness_scores.get(i, [])
        response_rankings.append({
            'index': i,
            'model': stage1_results[i]['model'],
            'score': round(sum(scores) / len(scores), 4) if scores else 0.0,
            'mean_correctness': (
                round(sum(corr) / len(corr), 2) if corr else None
            ),
            'votes': len(scores),
            'top1_votes': top1_votes.get(i, 0),
            'issues': merged_issues.get(i, []),
        })

    ranking_fallback = not any(r['votes'] > 0 for r in response_rankings)
    if ranking_fallback:
        response_rankings.sort(key=lambda row: row['index'])
    else:
        response_rankings.sort(
            key=lambda row: (
                -row['score'],
                -(
                    row['mean_correctness']
                    if row['mean_correctness'] is not None
                    else -1.0
                ),
                row['index'],
            )
        )

    by_model = defaultdict(lambda: {'scores': [], 'correctness': []})
    for row in response_rankings:
        by_model[row['model']]['scores'].append(row['score'])
        if row['mean_correctness'] is not None:
            by_model[row['model']]['correctness'].append(row['mean_correctness'])

    aggregate_rankings = []
    for model, data in by_model.items():
        scores = data['scores']
        corr = data['correctness']
        aggregate_rankings.append({
            'model': model,
            'score': round(sum(scores) / len(scores), 4) if scores else 0.0,
            'mean_correctness': (
                round(sum(corr) / len(corr), 2) if corr else None
            ),
            'rankings_count': len(scores),
        })
    aggregate_rankings.sort(
        key=lambda row: (
            -row['score'],
            -(
                row['mean_correctness']
                if row['mean_correctness'] is not None
                else -1.0
            ),
        )
    )

    return response_rankings, aggregate_rankings, ranking_fallback


def parse_red_team_verdict(text: str) -> Tuple[str, Optional[float]]:
    """Parse VERDICT and CONFIDENCE from a red-team reply."""
    verdict = 'CONTESTED'
    confidence = None
    if not text:
        return verdict, confidence
    verdict_match = re.search(
        r'VERDICT:\s*(REFUTED|CONTESTED|UPHELD)',
        text,
        re.IGNORECASE,
    )
    if verdict_match:
        verdict = verdict_match.group(1).upper()
    conf_match = re.search(
        r'CONFIDENCE:\s*(\d+(?:\.\d+)?)\s*(?:/\s*10)?',
        text,
        re.IGNORECASE,
    )
    if conf_match:
        confidence = max(0.0, min(10.0, float(conf_match.group(1))))
    return verdict, confidence


def _pick_red_team_model(
    leader_model: str,
    response_rankings: List[Dict[str, Any]],
) -> Tuple[str, bool]:
    """Choose a red-team model, avoiding the leader's family when possible."""
    requested = settings.red_team_model or settings.chairman_model
    leader_family = model_family(leader_model)
    if model_family(requested) != leader_family:
        return requested, False
    for row in response_rankings:
        candidate = row['model']
        if model_family(candidate) != leader_family:
            return candidate, False
    return requested, True


async def red_team_review(
    query_text: str,
    leader_response: str,
    leader_index: int,
    response_rankings: List[Dict[str, Any]],
    stage1_results: List[Dict[str, Any]],
) -> Optional[Dict[str, Any]]:
    """
    Adversarial review of the leading Stage 1 answer.

    Failure is non-fatal: returns None.
    """
    if not stage1_results or leader_index < 0 or leader_index >= len(stage1_results):
        return None

    leader_model = stage1_results[leader_index]['model']
    model, same_family = _pick_red_team_model(leader_model, response_rankings)

    prompt = f'''You are an adversarial reviewer. Independently verify the following answer and try to refute it. Do not assume it is correct. Look for factual errors, logical flaws, missing caveats, and confident-but-wrong claims.

Question: {query_text}

Answer under review:
{leader_response}

Write a critique that attempts to refute the answer. Then end with EXACTLY these two lines:

VERDICT: REFUTED | CONTESTED | UPHELD
CONFIDENCE: <0-10>

Meaning:
- REFUTED = you found a concrete, decisive error that invalidates the main conclusion
- CONTESTED = you found a plausible error or a serious unresolved issue, but it is not decisive
- UPHELD = you could not find a concrete refutation
'''

    result = await query_model_result(model, [{'role': 'user', 'content': prompt}])
    if not result.get('ok'):
        return {
            'model': model,
            'target_index': leader_index,
            'critique': '',
            'verdict': None,
            'confidence': None,
            'usage': {},
            'same_family': same_family,
            'error': result.get('error'),
        }

    critique = result.get('content', '') or ''
    verdict, confidence = parse_red_team_verdict(critique)
    return {
        'model': model,
        'target_index': leader_index,
        'critique': critique,
        'verdict': verdict,
        'confidence': confidence,
        'usage': result.get('usage', {}),
        'same_family': same_family,
    }


def _family_top1_agreement(
    response_rankings: List[Dict[str, Any]],
    stage2_results: List[Dict[str, Any]],
) -> float:
    """Share of sighted judges whose first pick is the leader's family."""
    leader = response_rankings[0]
    leader_family = model_family(leader.get('model') or '')
    index_to_model = {
        int(row['index']): row.get('model') or ''
        for row in response_rankings
        if row.get('index') is not None
    }

    votes = 0
    eligible = 0
    for ranking in stage2_results:
        mapping = ranking.get('label_to_index') or {}
        if mapping:
            saw_family = any(
                model_family(index_to_model.get(int(idx), '')) == leader_family
                for idx in mapping.values()
            )
        else:
            saw_family = True
        if not saw_family:
            continue
        eligible += 1
        ranked = resolve_ranked_indices(ranking)
        if not ranked:
            continue
        first_family = model_family(index_to_model.get(ranked[0], ''))
        if first_family == leader_family:
            votes += 1
    if eligible == 0:
        return 0.0
    return votes / eligible


def compute_consensus(
    response_rankings: List[Dict[str, Any]],
    stage2_results: List[Dict[str, Any]],
    red_team: Optional[Dict[str, Any]],
) -> Dict[str, Any]:
    """
    Council confidence: HIGH / MEDIUM / LOW / CONTESTED.

    Wording is confidence, never 'verified'.
    """
    if not response_rankings:
        return {
            'level': 'LOW',
            'reasons': ['No ranked responses'],
            'leader_index': None,
            'leader_score': None,
            'leader_mean_correctness': None,
            'top1_agreement': 0.0,
            'disputed_claims': [],
            'red_team_verdict': None,
        }

    leader = response_rankings[0]
    top1_agreement = _family_top1_agreement(response_rankings, stage2_results)
    leader_corr = leader.get('mean_correctness')

    disputed = []
    seen = set()
    for ranking in stage2_results:
        for claim in ranking.get('disputed_claims') or []:
            key = claim.lower()
            if key in seen:
                continue
            seen.add(key)
            disputed.append(claim)

    verdict = (red_team or {}).get('verdict')
    reasons = []

    if red_team is None or red_team.get('error'):
        reasons.append('Red-team review was unavailable')

    if verdict == 'REFUTED':
        level = 'CONTESTED'
        reasons.append('Red team found a decisive refutation of the leading answer')
    elif (
        (leader_corr is not None and leader_corr < 6)
        or top1_agreement < 0.4
        or verdict == 'CONTESTED'
    ):
        level = 'LOW'
        if leader_corr is not None and leader_corr < 6:
            reasons.append(
                f'Leading answer mean correctness is {leader_corr:.1f}/10'
            )
        if top1_agreement < 0.4:
            reasons.append(f'Top-1 agreement is {top1_agreement:.0%}')
        if verdict == 'CONTESTED':
            reasons.append('Red team contested the leading answer')
    elif (
        (leader_corr is not None and leader_corr < 8)
        or top1_agreement < 0.7
        or disputed
        or verdict is None
    ):
        # verdict is None means the red team never returned a usable verdict:
        # peer agreement alone has not survived an adversarial pass, so the
        # council cannot claim HIGH. The caveat reason is already recorded.
        level = 'MEDIUM'
        if leader_corr is not None and leader_corr < 8:
            reasons.append(
                f'Leading answer mean correctness is {leader_corr:.1f}/10'
            )
        if top1_agreement < 0.7:
            reasons.append(f'Top-1 agreement is {top1_agreement:.0%}')
        if disputed:
            reasons.append(f'{len(disputed)} disputed claim(s) remain unresolved')
    else:
        level = 'HIGH'
        reasons.append('Judges agreed on a high-correctness leader')

    return {
        'level': level,
        'reasons': reasons,
        'leader_index': leader['index'],
        'leader_score': leader['score'],
        'leader_mean_correctness': leader_corr,
        'top1_agreement': round(top1_agreement, 3),
        'disputed_claims': disputed,
        'red_team_verdict': verdict,
    }


def build_council_metadata(
    label_to_model: Dict[str, str],
    response_rankings: List[Dict[str, Any]],
    aggregate_rankings: List[Dict[str, Any]],
    top_k_indices: List[int],
    red_team: Optional[Dict[str, Any]],
    consensus: Dict[str, Any],
    ranking_fallback: bool = False,
) -> Dict[str, Any]:
    """Assemble the metadata blob persisted with an assistant message."""
    return {
        'label_to_model': label_to_model,
        'response_rankings': response_rankings,
        'aggregate_rankings': aggregate_rankings,
        'top_k_indices': top_k_indices,
        'red_team': red_team,
        'consensus': consensus,
        'ranking_fallback': ranking_fallback,
    }


async def run_post_ranking(
    query_text: str,
    stage1_results: List[Dict[str, Any]],
    stage2_results: List[Dict[str, Any]],
) -> Tuple[
    List[Dict[str, Any]],
    List[Dict[str, Any]],
    List[int],
    Optional[Dict[str, Any]],
    Dict[str, Any],
    bool,
]:
    """
    Aggregate rankings, red-team the leader, compute consensus.

    Returns:
        response_rankings, aggregate_rankings, top_k_indices,
        red_team, consensus, ranking_fallback
    """
    response_rankings, aggregate_rankings, ranking_fallback = (
        calculate_aggregate_rankings(stage1_results, stage2_results)
    )
    top_n = max(1, min(settings.top_k, len(response_rankings) or 1))
    top_k_indices = [row['index'] for row in response_rankings[:top_n]]

    red_team = None
    if response_rankings:
        leader_index = response_rankings[0]['index']
        try:
            red_team = await red_team_review(
                query_text,
                stage1_results[leader_index].get('response', ''),
                leader_index,
                response_rankings,
                stage1_results,
            )
        except Exception:
            red_team = None

    consensus = compute_consensus(response_rankings, stage2_results, red_team)
    return (
        response_rankings,
        aggregate_rankings,
        top_k_indices,
        red_team,
        consensus,
        ranking_fallback,
    )


def _format_candidate_block(
    ordinal: int,
    row: Dict[str, Any],
    response_text: str,
) -> str:
    correctness = row.get('mean_correctness')
    corr_text = f'{correctness:.1f}/10' if correctness is not None else 'n/a'
    issues = row.get('issues') or []
    issues_text = '; '.join(issues) if issues else 'none'
    return (
        f'Candidate #{ordinal} (score={row.get("score", 0):.2f}, '
        f'correctness={corr_text}):\n'
        f'Judge issues: {issues_text}\n'
        f'{response_text}'
    )


async def stage3_synthesize_final(
    user_query: str,
    stage1_results: List[Dict[str, Any]],
    stage2_results: List[Dict[str, Any]] = None,
    metadata: Dict[str, Any] = None,
) -> Dict[str, Any]:
    """
    Stage 3: Chairman synthesizes from anonymized top-K plus consensus.

    Candidate #1 is the base draft. Raw Stage 2 text and model names are omitted.
    """
    del stage2_results  # rankings are consumed via metadata, not raw text
    metadata = metadata or {}
    consensus = metadata.get('consensus') or {}
    red_team = metadata.get('red_team')
    top_k_indices = metadata.get('top_k_indices') or []
    response_rankings = metadata.get('response_rankings') or []
    by_index = {row['index']: row for row in response_rankings}

    if not top_k_indices and stage1_results:
        top_k_indices = list(range(min(settings.top_k, len(stage1_results))))

    level = consensus.get('level', 'MEDIUM')
    reasons = consensus.get('reasons') or []
    disputed = consensus.get('disputed_claims') or []
    reasons_text = '\n'.join(f'- {r}' for r in reasons) or '- none'
    disputed_text = '\n'.join(f'- {c}' for c in disputed) or '- none'

    if red_team:
        verdict = red_team.get('verdict', 'n/a')
        conf = red_team.get('confidence')
        conf_text = f'{conf}/10' if conf is not None else 'n/a'
        red_team_block = (
            f'Red-team verdict: {verdict} (confidence {conf_text})\n'
            f'Red-team critique:\n{red_team.get("critique", "")}'
        )
    else:
        red_team_block = 'Red-team review was unavailable.'

    candidate_blocks = []
    for ordinal, idx in enumerate(top_k_indices, start=1):
        if idx < 0 or idx >= len(stage1_results):
            continue
        row = by_index.get(idx, {
            'index': idx,
            'score': 0.0,
            'mean_correctness': None,
            'issues': [],
        })
        candidate_blocks.append(
            _format_candidate_block(
                ordinal,
                row,
                stage1_results[idx].get('response', ''),
            )
        )
    candidates_text = '\n\n'.join(candidate_blocks) or '(no candidates)'

    chairman_prompt = f'''You are the Chairman of an LLM Council. Peer judges ranked anonymized answers and graded correctness. A red-team reviewer then tried to refute the leading answer.

Original Question: {user_query}

COUNCIL CONFIDENCE: {level}
Reasons:
{reasons_text}

Disputed claims:
{disputed_text}

{red_team_block}

CANDIDATES (ordered by peer score, best first). Candidate #1 is the base draft.

{candidates_text}

Your task:
- Treat Candidate #1 as the base draft.
- Apply edits from later candidates only where they correct an error or add verified content.
- Address every disputed claim: resolve it or flag it as unresolved.
- If the red-team verdict is REFUTED, present the refutation and a corrected answer instead of the leader's conclusion.
- If council confidence is LOW or CONTESTED, open with a one-line caveat.
- Do not mention model names.

Provide a clear, well-reasoned final answer:'''

    messages = [{'role': 'user', 'content': chairman_prompt}]
    result = await query_model_result(settings.chairman_model, messages)

    if not result.get('ok'):
        err = result.get('error') or {}
        detail = err.get('message') or 'failed to generate response'
        raise Exception(
            f'Chairman model ({settings.chairman_model}) failed: {detail}'
        )

    leader_index = consensus.get('leader_index')
    if leader_index is None and top_k_indices:
        leader_index = top_k_indices[0]

    return {
        'model': settings.chairman_model,
        'response': result.get('content', ''),
        'usage': result.get('usage', {}),
        'based_on_index': leader_index,
        'top_k_indices': top_k_indices,
        'consensus_level': level,
    }


async def generate_conversation_title(user_query: str) -> str:
    """
    Generate a short title for a conversation based on the first user message.

    Args:
        user_query: The first user message

    Returns:
        A short title (3-5 words)
    """
    title_prompt = f'''Generate a very short title (3-5 words maximum) that summarizes the following question.
The title should be concise and descriptive. Do not use quotes or punctuation in the title.

Question: {user_query}

Title:'''

    messages = [{'role': 'user', 'content': title_prompt}]

    response = await query_model(TITLE_MODEL, messages, timeout=30.0)

    if response is None:
        return 'New Conversation'

    title = response.get('content', 'New Conversation').strip()
    title = title.strip('"\'')

    if len(title) > 50:
        title = title[:47] + '...'

    return title


async def run_full_council(user_query: str) -> Tuple[List, List, Optional[Dict], Dict]:
    """
    Run the complete 3-stage council process.

    Args:
        user_query: The user's question

    Returns:
        Tuple of (stage1_results, stage2_results, stage3_result, metadata)
    """
    stage1_results, stage1_failures = await stage1_collect_responses(user_query)

    if not stage1_results:
        return [], [], None, {'stage1_failures': stage1_failures}

    stage2_results, label_to_model = await stage2_collect_rankings(
        user_query, stage1_results
    )

    (
        response_rankings,
        aggregate_rankings,
        top_k_indices,
        red_team,
        consensus,
        ranking_fallback,
    ) = await run_post_ranking(user_query, stage1_results, stage2_results)

    metadata = build_council_metadata(
        label_to_model,
        response_rankings,
        aggregate_rankings,
        top_k_indices,
        red_team,
        consensus,
        ranking_fallback,
    )
    metadata['stage1_failures'] = stage1_failures

    stage3_result = await stage3_synthesize_final(
        user_query,
        stage1_results,
        stage2_results,
        metadata,
    )

    return stage1_results, stage2_results, stage3_result, metadata
