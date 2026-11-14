"""Shared Stage 2 fixtures, also executed by the browser engine's Vitest suite."""

import json
import unittest
from pathlib import Path

from backend.config import SELF_MOA_SAMPLES, SELF_MOA_TAIL_CHARS, SELF_MOA_TAIL_MARKER
from backend.loop_guard import detect_loop, repeat_share
from backend.council import (
    build_self_moa_prompt,
    forward_sample_text,
    self_moa_request_options,
    calculate_aggregate_rankings,
    compute_consensus,
    parse_correctness_scores,
    parse_disputed_claims,
    parse_ranking_from_text,
)

FIXTURES = Path(__file__).resolve().parents[1] / 'tests' / 'fixtures' / 'stage2_cases.json'


def check_case(case):
    kind = case['kind']
    if kind == 'parse':
        if 'correctness' in case:
            assert parse_correctness_scores(case['text']) == case['correctness']
        if 'ranking' in case:
            assert parse_ranking_from_text(case['text']) == case['ranking']
        if 'disputed_claims' in case:
            assert parse_disputed_claims(case['text']) == case['disputed_claims']
        return

    if kind == 'format':
        assert format(case['value'], f".{case['digits']}f") == case['expected']
        return

    if kind == 'aggregate':
        rows, _, fallback = calculate_aggregate_rankings(case['stage1'], case['stage2'])
        assert fallback is case['fallback']
        by_index = {row['index']: row['score'] for row in rows}
        left, right = case['score_greater']
        assert by_index[left] > by_index[right]
        return

    if kind == 'consensus':
        result = compute_consensus(
            case['response_rankings'],
            case['stage2'],
            case['red_team'],
        )
        assert result['level'] == case['level']
        if 'top1_agreement' in case:
            assert result['top1_agreement'] == case['top1_agreement']
        if 'reason_includes' in case:
            assert case['reason_includes'] in result['reasons']
        return

    if kind == 'self_moa_prompt':
        assert build_self_moa_prompt(case['query'], case['samples']) == case['expected']
        return

    if kind == 'self_moa_forward':
        text = build_text(case['text'])
        row = {'response': text, 'cut_reasoning': case['cut_reasoning']}
        assert forward_sample_text(row) == (
            case['expected_prefix'] + text[-case['expected_tail_chars']:]
        )
        return

    if kind == 'self_moa_settings':
        options = self_moa_request_options()
        assert SELF_MOA_SAMPLES == case['samples']
        assert options['max_tokens'] == case['max_tokens']
        assert options['temperature'] == case['temperature']
        assert options['top_p'] == case['top_p']
        assert options['total_seconds'] == case['stream_seconds']
        assert options['timeout'] == case['idle_seconds']
        assert options['max_retries'] == case['max_attempts']
        assert options['loop_guard'] == case['loop_guard']
        assert options['stream'] is True and options['annotate'] is True
        assert SELF_MOA_TAIL_CHARS == case['tail_chars']
        assert SELF_MOA_TAIL_MARKER == case['tail_marker']
        return

    if kind == 'loop_guard':
        assert detect_loop(build_text(case['text'])) == case['expected']
        return

    if kind == 'loop_guard_share':
        assert repeat_share(build_text(case['text']), case['end'], True) == case['expected']
        return

    raise AssertionError(f'unknown fixture kind {kind}')


def build_text(parts):
    """Long fixture texts, written as parts. Same rules as parity.test.js."""
    out = []
    for part in parts:
        kind = part[0]
        if kind == 'repeat':
            out.append(part[1] * part[2])
        elif kind == 'numbers':
            out.append(' '.join(str(i) for i in range(part[1], part[2])))
        elif kind == 'counted':
            out.append(''.join(f'{part[1]}{i}{part[2]}' for i in range(part[3])))
        else:
            raise AssertionError(f'unknown text part {kind}')
    return ''.join(out)


class ParityFixtureTests(unittest.TestCase):
    def test_shared_stage2_fixtures(self):
        payload = json.loads(FIXTURES.read_text(encoding='utf-8'))
        for case in payload['cases']:
            with self.subTest(case=case['name']):
                check_case(case)


if __name__ == '__main__':
    unittest.main()
