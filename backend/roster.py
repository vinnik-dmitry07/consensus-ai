"""Drop council models OpenRouter will not serve."""

import asyncio
import time

HARNESS_ONLY = 'only available on agentic harnesses'
UPSTREAM_LIMIT = 'temporarily rate-limited upstream'
PROVIDER_RETURNED = 'provider returned error'
FREE_START_GAP_SECONDS = 3.0
FREE_MINUTE_SECONDS = 60.0
FREE_MAX_STARTS_PER_MINUTE = 16
MODEL_COOLDOWN_SECONDS = 600.0
MODEL_COOLDOWN_MAX_SECONDS = 3600.0

_blocked = set()
_cooled_until = {}
_free_lock = None
_free_lock_loop = None
_free_starts = []
_free_paused_until = 0.0


def catalogue_id(model: str) -> str:
    from .openrouter import catalogue_model_id
    return catalogue_model_id(str(model or '').strip())


def is_free_model(model: str) -> bool:
    return catalogue_id(model).endswith(':free')


def is_all_free_council(council_models) -> bool:
    models = list(council_models or [])
    if not models:
        return False
    return all(is_free_model(model) for model in models)


def stage1_sample_limit(council_models, requested: int) -> int:
    if is_all_free_council(council_models):
        return 1
    return requested


def roster_requires_user_key(council_models, chairman_model, red_team_model) -> bool:
    """Personal key is required unless every configured model is free.

    A blank red-team value means the chairman, matching settings. A blank
    council or chairman is not a free roster. This does not change the
    Stage 1 sample cap.
    """
    if not is_all_free_council(council_models):
        return True
    if not is_free_model(chairman_model):
        return True
    if str(red_team_model or '').strip() and not is_free_model(red_team_model):
        return True
    return False


def is_harness_only_message(text: str) -> bool:
    return HARNESS_ONLY in str(text or '').lower()


def is_upstream_limited(text: str) -> bool:
    """A provider 429 for this model, not the shared free-model minute cap."""
    lowered = str(text or '').lower()
    if 'free-models-per-min' in lowered:
        return False
    if UPSTREAM_LIMIT in lowered:
        return True
    return PROVIDER_RETURNED in lowered


def remember_model_cooldown(model: str, seconds: float) -> None:
    """Leave this catalogue id alone until the upstream limit can lift."""
    cid = catalogue_id(model)
    if not cid:
        return
    wait = min(
        max(float(seconds), MODEL_COOLDOWN_SECONDS),
        MODEL_COOLDOWN_MAX_SECONDS,
    )
    deadline = time.monotonic() + wait
    previous = _cooled_until.get(cid, 0.0)
    if deadline > previous:
        _cooled_until[cid] = deadline


def model_is_cooling(model: str) -> bool:
    cid = catalogue_id(model)
    until = _cooled_until.get(cid)
    if until is None:
        return False
    if time.monotonic() >= until:
        _cooled_until.pop(cid, None)
        return False
    return True


def model_unavailable(model: str) -> bool:
    cid = catalogue_id(model)
    if not cid:
        return False
    return cid in _blocked or model_is_cooling(model)


def remember_blocked_id(model: str) -> None:
    cid = catalogue_id(model)
    if cid:
        _blocked.add(cid)


def blocked_ids():
    return set(_blocked)


def clear_blocked_ids() -> None:
    _blocked.clear()


def reset_free_queue_for_tests() -> None:
    global _free_lock, _free_lock_loop, _free_paused_until
    _free_lock = None
    _free_lock_loop = None
    _free_starts.clear()
    _free_paused_until = 0.0
    _cooled_until.clear()


class RosterEmpty(Exception):
    def __init__(self, removed):
        self.removed = list(removed)
        listed = ', '.join(self.removed)
        super().__init__(
            f'OpenRouter will not serve {listed}. Pick the council again.'
        )


def _variant_of(model: str) -> str:
    text = str(model or '')
    if text.endswith('-reasoning-high'):
        return 'reasoning-high'
    if text.endswith('-reasoning'):
        return 'reasoning'
    return 'base'


def _with_variant(base_id: str, variant: str) -> str:
    if not base_id:
        return ''
    if variant == 'reasoning-high':
        return f'{base_id}-reasoning-high'
    if variant == 'reasoning':
        return f'{base_id}-reasoning'
    return base_id


def prune_roster(
    council_models,
    chairman_model,
    red_team_model,
    known_ids,
    blocked=None,
):
    """Return the selection with unusable ids removed.

    An id is unusable when its catalogue id is blocked or missing from
    known_ids. A dropped chairman or red-team model is retargeted at the
    first remaining council model, keeping its reasoning suffix.
    """
    known = set(known_ids)
    blocked_set = set(_blocked if blocked is None else blocked)
    removed = []
    seen = set()

    def unusable(model) -> bool:
        if not model or not str(model).strip():
            return False
        cid = catalogue_id(model)
        if cid not in blocked_set and cid in known:
            return False
        if cid not in seen:
            seen.add(cid)
            removed.append(cid)
        return True

    next_council = [model for model in council_models if not unusable(model)]

    def retarget(model, empty):
        if not model or not unusable(model):
            return model or empty
        if not next_council:
            return empty
        return _with_variant(catalogue_id(next_council[0]), _variant_of(model))

    return {
        'council_models': next_council,
        'chairman_model': retarget(chairman_model, ''),
        'red_team_model': retarget(red_team_model, None),
        'removed': removed,
    }


def _selected_catalogue_ids() -> set:
    from .settings import settings
    known = {catalogue_id(model) for model in settings.council_models}
    if settings.chairman_model:
        known.add(catalogue_id(settings.chairman_model))
    if settings.red_team_model:
        known.add(catalogue_id(settings.red_team_model))
    return known


def _store_pruned(settings, pruned) -> None:
    settings.council_models = pruned['council_models']
    settings.chairman_model = pruned['chairman_model']
    settings.red_team_model = pruned['red_team_model']


def drop_blocked_model(model: str) -> None:
    """Remember a harness-only id and take it off the current selection."""
    from .settings import settings
    remember_blocked_id(model)
    pruned = prune_roster(
        settings.council_models,
        settings.chairman_model,
        settings.red_team_model,
        _selected_catalogue_ids(),
    )
    _store_pruned(settings, pruned)
    if not pruned['council_models']:
        return
    capped = stage1_sample_limit(
        pruned['council_models'], settings.n_samples
    )
    if capped != settings.n_samples:
        settings.n_samples = capped


async def ensure_servable_roster():
    """Prune the live selection and cap samples for an all-free council.

    An empty catalogue means the list could not be loaded, so the council
    ids are left unchanged. A non-empty all-free council still drops to one
    sample. Raise when the catalogue is loaded and nothing usable remains.
    """
    from .openrouter import get_models_pricing
    from .settings import settings
    pricing = await get_models_pricing()
    if pricing:
        pruned = prune_roster(
            settings.council_models,
            settings.chairman_model,
            settings.red_team_model,
            pricing.keys(),
        )
        if not pruned['council_models']:
            raise RosterEmpty(pruned['removed'] or ['the selected models'])
        roster_changed = (
            list(pruned['council_models']) != list(settings.council_models)
            or (pruned['chairman_model'] or '') != (settings.chairman_model or '')
            or pruned['red_team_model'] != settings.red_team_model
        )
        if roster_changed:
            _store_pruned(settings, pruned)
    capped = stage1_sample_limit(settings.council_models, settings.n_samples)
    if capped != settings.n_samples:
        settings.n_samples = capped


def _lock_for_loop():
    global _free_lock, _free_lock_loop
    loop = asyncio.get_running_loop()
    if _free_lock is None or _free_lock_loop is not loop:
        _free_lock = asyncio.Lock()
        _free_lock_loop = loop
    return _free_lock


def _drop_expired_starts(now: float) -> None:
    cutoff = now - FREE_MINUTE_SECONDS
    while _free_starts and _free_starts[0] <= cutoff:
        _free_starts.pop(0)


def pause_free_queue(seconds: float) -> None:
    """Hold later :free calls until this wait has elapsed."""
    global _free_paused_until
    _free_paused_until = max(
        _free_paused_until, time.monotonic() + max(0.0, seconds)
    )


async def admit_free_post(extra_wait: float = 0.0) -> None:
    """Reserve one :free HTTP start. Caller must already hold the free lock.

    The start is recorded on the monotonic clock immediately before the
    caller posts. A retry calls this again and does not re-enter the lock.
    """
    backoff_until = time.monotonic() + max(0.0, extra_wait)
    while True:
        now = time.monotonic()
        _drop_expired_starts(now)
        earliest = now
        if _free_starts:
            earliest = max(
                earliest, _free_starts[-1] + FREE_START_GAP_SECONDS
            )
        if len(_free_starts) >= FREE_MAX_STARTS_PER_MINUTE:
            earliest = max(earliest, _free_starts[0] + FREE_MINUTE_SECONDS)
        if _free_paused_until:
            earliest = max(earliest, _free_paused_until)
        earliest = max(earliest, backoff_until)
        if earliest > now:
            await asyncio.sleep(earliest - now)
            continue
        _free_starts.append(now)
        return


async def run_free_call(task):
    """Run one :free chat call at a time, including its retries.

    Each HTTP attempt admits itself. Holding the lock here keeps the
    previous one-at-a-time limit and lets a retry wait without queueing
    behind its own unfinished call.
    """
    lock = _lock_for_loop()
    async with lock:
        return await task()
