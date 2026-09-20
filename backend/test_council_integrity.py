"""Tests for family-level self-exclusion, resume hygiene, and confidence caps."""

import unittest
from unittest.mock import patch

from backend.council import (
    build_judge_view,
    compute_consensus,
    pending_stage1_slots,
    retained_stage1_failures,
    usable_stage1_results,
)
from backend.openrouter import model_family, parse_retry_after


class ModelFamilyTests(unittest.TestCase):
    def test_same_vendor_is_one_family(self):
        self.assertEqual(
            model_family('anthropic/claude-opus-4.1'),
            model_family('anthropic/claude-sonnet-4.5'),
        )

    def test_reasoning_variants_and_alias_prefix_collapse(self):
        self.assertEqual(
            model_family('~openai/gpt-sol-latest-reasoning-high'),
            model_family('openai/gpt-sol-latest'),
        )

    def test_different_vendors_are_different_families(self):
        self.assertNotEqual(
            model_family('google/gemini-pro-latest'),
            model_family('x-ai/grok-latest'),
        )

    def test_id_without_author_falls_back_to_the_id(self):
        self.assertEqual(model_family('some-local-model'), 'some-local-model')


class SelfExclusionTests(unittest.TestCase):
    def test_judge_does_not_grade_a_sibling_from_its_own_vendor(self):
        stage1 = [
            {'model': 'anthropic/claude-opus-4.1', 'response': 'a'},
            {'model': 'anthropic/claude-sonnet-4.5', 'response': 'b'},
            {'model': 'google/gemini-pro-latest', 'response': 'c'},
        ]
        view = build_judge_view(
            'anthropic/claude-opus-4.1', stage1, 'q', self_exclusion=True
        )
        self.assertTrue(view['self_excluded'])
        self.assertEqual(
            sorted(view['label_to_index'].values()), [2]
        )

    def test_exclusion_is_skipped_when_it_would_leave_nothing(self):
        stage1 = [
            {'model': 'anthropic/claude-opus-4.1', 'response': 'a'},
            {'model': 'anthropic/claude-sonnet-4.5', 'response': 'b'},
        ]
        view = build_judge_view(
            'anthropic/claude-opus-4.1', stage1, 'q', self_exclusion=True
        )
        self.assertFalse(view['self_excluded'])
        self.assertEqual(len(view['candidates']), 2)


class ResumeHygieneTests(unittest.TestCase):
    def test_samples_from_a_removed_model_are_dropped(self):
        existing = [
            {'model': 'a/one', 'response': '1'},
            {'model': 'dropped/two', 'response': '2'},
            {'model': 'a/one', 'response': '3'},
        ]
        kept = usable_stage1_results(['a/one'], 2, existing)
        self.assertEqual([r['response'] for r in kept], ['1', '3'])
        self.assertEqual(pending_stage1_slots(['a/one'], 2, existing), [])

    def test_samples_beyond_the_current_n_are_dropped(self):
        existing = [{'model': 'a/one', 'response': str(i)} for i in range(4)]
        kept = usable_stage1_results(['a/one'], 2, existing)
        self.assertEqual([r['response'] for r in kept], ['0', '1'])

    def test_a_lowered_n_does_not_request_more_samples(self):
        existing = [{'model': 'a/one', 'response': str(i)} for i in range(4)]
        self.assertEqual(pending_stage1_slots(['a/one'], 2, existing), [])

    def test_failures_from_removed_models_are_dropped(self):
        failures = [
            {'model': 'a/one', 'error': {'message': 'x'}},
            {'model': 'dropped/two', 'error': {'message': 'y'}},
        ]
        self.assertEqual(
            retained_stage1_failures(failures, [], ['a/one']),
            [{'model': 'a/one', 'error': {'message': 'x'}}],
        )

    def test_council_filter_is_optional_for_old_callers(self):
        failures = [{'model': 'dropped/two', 'error': {'message': 'y'}}]
        self.assertEqual(retained_stage1_failures(failures, []), failures)


class ConfidenceCapTests(unittest.TestCase):
    RANKINGS = [
        {
            'index': 0,
            'model': 'a/one',
            'score': 0.9,
            'mean_correctness': 9.5,
            'top1_votes': 1,
        }
    ]
    STAGE2 = [
        {
            'label_to_index': {'Response 1': 0},
            'ranked_indices': [0],
            'disputed_claims': [],
        }
    ]

    def test_missing_red_team_cannot_reach_high(self):
        result = compute_consensus(self.RANKINGS, self.STAGE2, None)
        self.assertEqual(result['level'], 'MEDIUM')
        self.assertIn('Red-team review was unavailable', result['reasons'])

    def test_errored_red_team_cannot_reach_high(self):
        red_team = {'verdict': None, 'error': {'message': 'boom'}}
        result = compute_consensus(self.RANKINGS, self.STAGE2, red_team)
        self.assertEqual(result['level'], 'MEDIUM')

    def test_upheld_red_team_still_reaches_high(self):
        result = compute_consensus(
            self.RANKINGS, self.STAGE2, {'verdict': 'UPHELD'}
        )
        self.assertEqual(result['level'], 'HIGH')


class RetryAfterTests(unittest.TestCase):
    def test_seconds_are_honoured(self):
        self.assertEqual(parse_retry_after('7', 99), 7.0)

    def test_http_date_does_not_raise(self):
        # RFC 9110 allows a date here; int() used to blow up the whole stage.
        value = parse_retry_after('Wed, 21 Oct 2015 07:28:00 GMT', 4)
        self.assertGreaterEqual(value, 0.0)

    def test_garbage_falls_back_to_the_caller_backoff(self):
        self.assertEqual(parse_retry_after('soon', 4), 4.0)

    def test_missing_header_falls_back(self):
        self.assertEqual(parse_retry_after(None, 8), 8.0)

    def test_absurd_wait_is_clamped(self):
        self.assertEqual(parse_retry_after('86400', 2), 60.0)


if __name__ == '__main__':
    unittest.main()
