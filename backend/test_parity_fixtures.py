"""Shared Stage 2 fixtures, also executed by the browser engine's Vitest suite."""

import json
import unittest
from pathlib import Path

from backend.council import (
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

    raise AssertionError(f'unknown fixture kind {kind}')


class ParityFixtureTests(unittest.TestCase):
    def test_shared_stage2_fixtures(self):
        payload = json.loads(FIXTURES.read_text(encoding='utf-8'))
        for case in payload['cases']:
            with self.subTest(case=case['name']):
                check_case(case)


if __name__ == '__main__':
    unittest.main()
