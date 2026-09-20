"""Tests for Stage 2 parsers, Borda, and family-level consensus."""

import unittest

from backend.council import (
    calculate_aggregate_rankings,
    compute_consensus,
    parse_correctness_scores,
    parse_disputed_claims,
    parse_ranking_from_text,
)


class ParserTests(unittest.TestCase):
    def test_bold_markdown_headers_and_scores(self):
        text = '''
**Response 1:**
**Correctness:** 8/10
Issues: none

**Response 2**
Correctness: **7**/10
Issues: none

FINAL RANKING:
1. **Response 2**
2. **Response 1**
'''
        scores = parse_correctness_scores(text)
        self.assertEqual(scores['Response 1'], 8.0)
        self.assertEqual(scores['Response 2'], 7.0)
        self.assertEqual(
            parse_ranking_from_text(text),
            ['Response 2', 'Response 1'],
        )

    def test_in_prose_response_mention_does_not_split_block(self):
        text = '''
Response 1:
This is stronger than Response 2 on facts.
Correctness: 8/10
Issues: none

Response 2:
Correctness: 4/10
Issues: none

FINAL RANKING:
1. Response 1
2. Response 2
'''
        scores = parse_correctness_scores(text)
        self.assertEqual(scores['Response 1'], 8.0)
        self.assertEqual(scores['Response 2'], 4.0)

    def test_colon_outside_bold_headings(self):
        text = '''
**Response 1:**
**Correctness**: 8/10
Issues: none

**DISPUTED CLAIMS**:
- the sky color

**FINAL RANKING**:
1. **Response 1**
'''
        self.assertEqual(parse_correctness_scores(text)['Response 1'], 8.0)
        self.assertEqual(parse_disputed_claims(text), ['the sky color'])
        self.assertEqual(parse_ranking_from_text(text), ['Response 1'])


class BordaTests(unittest.TestCase):
    def test_shown_set_beats_partial_last_place(self):
        stage1 = [{'model': f'm{i}', 'response': str(i)} for i in range(6)]
        shown = {f'Response {i + 1}': i for i in range(6)}
        full = {
            'label_to_index': shown,
            'ranked_indices': [0, 1, 2, 3, 4, 5],
        }
        partial = {
            'label_to_index': shown,
            'ranked_indices': [0, 1, 2],
        }
        rows, _, fallback = calculate_aggregate_rankings(
            stage1, [full, partial, partial]
        )
        self.assertFalse(fallback)
        by_idx = {row['index']: row['score'] for row in rows}
        self.assertGreater(by_idx[2], by_idx[3])


class ConsensusTests(unittest.TestCase):
    def test_family_top1_survives_sample_split(self):
        response_rankings = [
            {
                'index': 0,
                'model': '~openai/gpt-sol-latest',
                'score': 0.8,
                'mean_correctness': 9.0,
                'top1_votes': 3,
            },
            {
                'index': 1,
                'model': '~openai/gpt-sol-latest',
                'score': 0.7,
                'mean_correctness': 8.5,
                'top1_votes': 2,
            },
            {
                'index': 2,
                'model': '~openai/gpt-sol-latest',
                'score': 0.6,
                'mean_correctness': 8.0,
                'top1_votes': 1,
            },
            {
                'index': 3,
                'model': '~x-ai/grok-latest',
                'score': 0.1,
                'mean_correctness': 5.0,
                'top1_votes': 0,
            },
        ]
        shown = {f'Response {i + 1}': i for i in range(4)}
        stage2 = [
            {
                'label_to_index': shown,
                'ranked_indices': [first, 3],
                'disputed_claims': [],
            }
            for first in (0, 0, 0, 1, 1, 2)
        ]
        consensus = compute_consensus(
            response_rankings, stage2, {'verdict': 'UPHELD'}
        )
        self.assertEqual(consensus['top1_agreement'], 1.0)
        self.assertEqual(consensus['level'], 'HIGH')

    def test_blind_judges_excluded_from_denominator(self):
        response_rankings = [
            {
                'index': 0,
                'model': '~openai/gpt-sol-latest',
                'score': 0.9,
                'mean_correctness': 9.0,
                'top1_votes': 6,
            },
            {
                'index': 1,
                'model': '~x-ai/grok-latest',
                'score': 0.2,
                'mean_correctness': 6.0,
                'top1_votes': 2,
            },
        ]
        sighted = {
            'label_to_index': {'Response 1': 0, 'Response 2': 1},
            'ranked_indices': [0, 1],
            'disputed_claims': [],
        }
        blind = {
            'label_to_index': {'Response 1': 1},
            'ranked_indices': [1],
            'disputed_claims': [],
        }
        stage2 = [sighted] * 6 + [blind] * 2
        consensus = compute_consensus(
            response_rankings, stage2, {'verdict': 'UPHELD'}
        )
        self.assertEqual(consensus['top1_agreement'], 1.0)
        self.assertEqual(consensus['level'], 'HIGH')
