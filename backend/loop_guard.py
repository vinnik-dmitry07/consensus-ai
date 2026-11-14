"""Detects a completion that has started repeating itself.

Port of frontend/src/engine/browser/loopGuard.js. The check runs at fixed
positions of the accumulated text of one channel, so the decision does not
depend on how the network split the stream into chunks. Shared cases in
tests/fixtures/stage2_cases.json (kind "loop_guard") keep both the same.
"""

from typing import Any, Dict, Optional

LOOP_GUARD_DEFAULTS: Dict[str, Any] = {
    'tailChars': 4000,
    'historyChars': 24000,
    'shingleChars': 40,
    'stride': 8,
    'threshold': 0.8,
    'checkEvery': 2000,
    'consecutive': 2,
}

_POSITIVE_FIELDS = (
    'tailChars', 'historyChars', 'shingleChars', 'stride', 'checkEvery', 'consecutive',
)


def loop_guard_config(config: Any) -> Optional[Dict[str, Any]]:
    if not config:
        return None
    merged = dict(LOOP_GUARD_DEFAULTS)
    if config is not True:
        merged.update(config)
    for field in _POSITIVE_FIELDS:
        value = merged[field]
        if not isinstance(value, int) or isinstance(value, bool) or value < 1:
            raise ValueError(f'loopGuard {field} must be a positive integer')
    if not (0 < merged['threshold'] <= 1):
        raise ValueError('loopGuard threshold must be in (0, 1]')
    return merged


def repeat_share(text: str, end: int, config: Any) -> Optional[float]:
    """Share of the tail's shingles already seen before the tail, or None."""
    cfg = loop_guard_config(config)
    tail_start = end - cfg['tailChars']
    if tail_start < 0:
        return None
    history = text[max(0, tail_start - cfg['historyChars']):tail_start]
    size = cfg['shingleChars']
    if len(history) < size:
        return None
    seen = {history[index:index + size] for index in range(len(history) - size + 1)}
    tail = text[tail_start:end]
    total = 0
    hits = 0
    for index in range(0, len(tail) - size + 1, cfg['stride']):
        total += 1
        if tail[index:index + size] in seen:
            hits += 1
    return hits / total if total else None


class LoopDetector:
    """Watches one growing text and fires once the tail keeps repeating."""

    def __init__(self, config: Any):
        self.config = loop_guard_config(config)
        self.next = self.config['tailChars'] + self.config['checkEvery']
        self._hot = 0
        self._fired: Optional[Dict[str, Any]] = None

    def observe(self, text: str) -> Optional[Dict[str, Any]]:
        if self._fired:
            return self._fired
        value = str(text or '')
        while self.next <= len(value):
            at = self.next
            self.next += self.config['checkEvery']
            share = repeat_share(value, at, self.config)
            if share is None:
                self._hot = 0
                continue
            self._hot = self._hot + 1 if share >= self.config['threshold'] else 0
            if self._hot >= self.config['consecutive']:
                self._fired = {'position': at, 'share': share}
                return self._fired
        return None


def create_loop_detector(config: Any) -> Optional[LoopDetector]:
    if not loop_guard_config(config):
        return None
    return LoopDetector(config)


def detect_loop(text: str, config: Any = True) -> Optional[Dict[str, Any]]:
    """Whole-text check, for tests and for replaying saved outputs."""
    return create_loop_detector(config).observe(text)
