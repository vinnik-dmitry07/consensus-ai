import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { canonicalCompletionRequest } from '../src/engine/browser/openrouter.js';
import * as openrouter from '../src/engine/browser/openrouter.js';
import { createSession } from './runtime.js';
import { attemptStore, installTransport } from './transport.js';
import { createCampaignBudget } from './budget.js';
import { EvalInvariantError } from './invariant.js';
import { finalOrder, runComparison } from './a8Variants.js';
import { compareReplayProfile, policyFrom, prepareFor } from './a8.js';
import { capsFrom, profileDocument, STAGE_CAPS, streamTimeoutFor } from './a8Profile.js';
import { FROZEN } from './a8TestFixtures.js';

function stubSession() {
  return createSession({
    runDir: mkdtempSync(path.join(tmpdir(), 'a8-')),
    budget: { state: { paused: false, pauseReason: null }, lockFatal() {} },
    log() {},
  });
}

function taskWithGold(id, goldCanon) {
  return { id, split: 'dev', block: 'aime', stem: 'What is 1?', kind: 'integer', goldCanon, choiceCount: 0 };
}

describe('A8 campaign caps', () => {
  it('builds caps from flags and scales the stream deadline with the largest cap', () => {
    expect(capsFrom({})).toEqual(STAGE_CAPS);
    const caps = capsFrom({ stage2: 16384, stage3: 16384 });
    expect(caps).toEqual({ ...STAGE_CAPS, stage2: 16384, stage3: 16384 });
    expect(() => capsFrom({ stage9: 1 })).toThrow(/Unknown stage cap/);
    expect(() => capsFrom({ stage2: 0 })).toThrow(/positive integer/);
    expect(streamTimeoutFor(STAGE_CAPS)).toBe(1144);
    expect(streamTimeoutFor(caps)).toBe(2168);
    expect(streamTimeoutFor({ stage1: 100 })).toBe(600);
    expect(profileDocument(caps).stageCaps).toEqual(caps);
    expect(profileDocument(caps).streamTimeoutSeconds).toBe(2168);
  });

  it('applies the campaign caps and deadline without touching the request hash', () => {
    const route = {
      id: 'alpha/one',
      provider: { order: ['x'], allow_fallbacks: false, max_price: { prompt: 1, completion: 1 } },
      temperature: 0.7,
      topP: 1,
    };
    const campaign = { stageCaps: capsFrom({ stage2: 16384, stage3: 16384 }), streamTimeoutSeconds: 2168 };
    const prepare = prepareFor(policyFrom({ routes: [route] }, campaign));
    const stage2 = prepare('alpha/one', 'stage2', {});
    expect(stage2.maxTokens).toBe(16384);
    expect(stage2.timeout).toBe(2168);
    const stage1 = prepare('alpha/one', 'stage1', {});
    expect(stage1.maxTokens).toBe(8192);
    const legacy = prepareFor(policyFrom({ routes: [route] }, null))('alpha/one', 'stage1', {});
    expect(legacy.maxTokens).toBe(8192);
    expect(legacy.timeout).toBeUndefined();
    const messages = [{ role: 'user', content: 'q' }];
    expect(canonicalCompletionRequest('alpha/one', messages, stage1))
      .toEqual(canonicalCompletionRequest('alpha/one', messages, legacy));
  });

  it('lets a replay source differ on caps and records it, but not on scoring fields', () => {
    const profile = profileDocument(capsFrom({ stage2: 16384 }));
    const source = profileDocument();
    const differences = compareReplayProfile('a8-open-v3', source, profile);
    expect(differences.stageCaps).toEqual(STAGE_CAPS);
    expect(differences.streamTimeoutSeconds).toBe(1144);
    expect(() => compareReplayProfile('x', { ...source, maxAttempts: 3 }, profile)).toThrow(/differs on maxAttempts/);
    expect(compareReplayProfile('same', profileDocument(), profileDocument())).toEqual({});
  });
});

describe('canonical eval options', () => {
  it('keeps the product payload unchanged until eval options are passed', () => {
    const plain = canonicalCompletionRequest('openai/gpt', [{ role: 'user', content: 'q' }]);
    expect(plain.provider).toBeUndefined();
    expect(plain.temperature).toBeUndefined();
    expect(plain.max_tokens).toBe(16000);
    const directed = canonicalCompletionRequest('openai/gpt', [{ role: 'user', content: 'q' }], {
      maxTokens: 8192,
      temperature: 0.7,
      topP: 1,
      provider: { order: ['openai'], allow_fallbacks: false, max_price: { prompt: 10, completion: 50 } },
    });
    expect(directed.max_tokens).toBe(8192);
    expect(directed.temperature).toBe(0.7);
    expect(directed.top_p).toBe(1);
    expect(directed.provider.order).toEqual(['openai']);
    expect(directed.provider.max_price.prompt).toBe(10);
    const timed = canonicalCompletionRequest('openai/gpt', [{ role: 'user', content: 'q' }], { maxTokens: 8192, timeout: 2168 });
    expect(timed.timeout).toBeUndefined();
    expect(timed).toEqual(canonicalCompletionRequest('openai/gpt', [{ role: 'user', content: 'q' }], { maxTokens: 8192 }));
  });
});

describe('A8 comparison', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('makes twelve calls, no red team, and keeps gold out of the prompt', async () => {
    const calls = [];
    vi.spyOn(openrouter, 'queryModelResult').mockImplementation(async (model, messages) => {
      calls.push({ model, content: messages?.[0]?.content || '' });
      return { ok: true, content: 'ANSWER: 1', usage: { cost: 0.01 } };
    });
    const task = taskWithGold('dev:aime:1', 'GOLD-TOKEN-99');
    const outcome = await runComparison(task, stubSession(), FROZEN);
    expect(outcome.status).toBe('complete');
    expect(calls).toHaveLength(12);
    expect(calls.filter((call) => call.model === 'alpha/one').length).toBeGreaterThan(0);
    expect(calls.every((call) => !call.content.includes('GOLD-TOKEN-99'))).toBe(true);
    // Both diagnostic votes follow P8's rule, so the council vote is P8 itself.
    expect(outcome.diagnostics.councilVote).toEqual(outcome.arms.P8);
    expect(outcome.diagnostics.replicateVote).toMatchObject({ status: 'graded', correct: 0, text: '' });
    expect(outcome.arms.A8.model).toBe('alpha/one');
    expect(outcome.arms.S8.model).toBe('alpha/one');
    expect(outcome.arms.P8.status).toBe('graded');
    expect(outcome.arms.P8.extracted).toBe('1');
    expect(outcome.arms.P8.votes).toEqual({ 1: 3 });
    expect(outcome.arms.P8.correct).toBe(0);
    expect(calls.filter((call) => call.content.startsWith('Answer the question.'))).toHaveLength(7);
    expect(calls.filter((call) => call.content.includes('You are aggregating'))).toHaveLength(1);
    expect(calls.filter((call) => call.content.includes('You are the Chairman'))).toHaveLength(1);
    expect(finalOrder(task.id, 'seed')).toEqual(finalOrder(task.id, 'seed'));
  });

  it('does not synthesize S8 from a subset of the five samples', async () => {
    let alphaAnswers = 0;
    vi.spyOn(openrouter, 'queryModelResult').mockImplementation(async (model, messages) => {
      const content = messages?.[0]?.content || '';
      if (model === 'alpha/one' && content.startsWith('Answer the question.')) {
        alphaAnswers += 1;
        if (alphaAnswers === 2) return { ok: true, content: '' };
      }
      return { ok: true, content: 'ANSWER: 1', usage: { cost: 0.01 } };
    });
    const outcome = await runComparison(taskWithGold('dev:aime:2', '1'), stubSession(), FROZEN);
    expect(outcome.status).toBe('complete');
    expect(outcome.arms.S8.reason).toBe('incomplete_samples');
    expect(outcome.arms.S8.correct).toBe(0);
    expect(alphaAnswers).toBeGreaterThan(1);
  });

  it('P8 votes over the three council answers and breaks a tie by seed', async () => {
    const answers = { 'alpha/one': 'ANSWER: 1', 'beta/two': 'ANSWER: 2', 'gamma/three': 'ANSWER: 3' };
    vi.spyOn(openrouter, 'queryModelResult').mockImplementation(async (model, messages) => {
      const content = messages?.[0]?.content || '';
      if (content.startsWith('Answer the question.')) return { ok: true, content: answers[model], usage: { cost: 0.01 } };
      return { ok: true, content: 'ANSWER: 1', usage: { cost: 0.01 } };
    });
    const task = taskWithGold('dev:aime:3', '2');
    const first = await runComparison(task, stubSession(), FROZEN);
    const second = await runComparison(task, stubSession(), FROZEN);
    expect(first.status).toBe('complete');
    expect(first.arms.P8.status).toBe('graded');
    expect(first.arms.P8.tie).toBe(true);
    expect(first.arms.P8.abstain).toBe(0);
    expect(first.arms.P8.votes).toEqual({ 1: 1, 2: 1, 3: 1 });
    expect(['1', '2', '3']).toContain(first.arms.P8.extracted);
    expect(second.arms.P8.extracted).toBe(first.arms.P8.extracted);
    expect(first.arms.P8.correct).toBe(first.arms.P8.extracted === '2' ? 1 : 0);
    expect(first.diagnostics.judgesComplete).toBe(0);
  });

  it('P8 is a method failure when a council answer is missing', async () => {
    vi.spyOn(openrouter, 'queryModelResult').mockImplementation(async (model, messages) => {
      const content = messages?.[0]?.content || '';
      if (model === 'gamma/three' && content.startsWith('Answer the question.')) return { ok: true, content: '' };
      return { ok: true, content: 'ANSWER: 1', usage: { cost: 0.01 } };
    });
    const outcome = await runComparison(taskWithGold('dev:aime:4', '1'), stubSession(), FROZEN);
    expect(outcome.status).toBe('complete');
    expect(outcome.arms.P8.status).toBe('not_run');
    expect(outcome.arms.P8.reason).toBe('incomplete_council');
    expect(outcome.arms.A8.reason).toBe('incomplete_council');
    expect(outcome.arms.B8.correct).toBe(1);
    expect(outcome.arms.S8.correct).toBe(1);
  });
});

describe('rejectFree', () => {
  it('blocks a free id before fetch when rejectFree is set', async () => {
    const posts = [];
    const budget = createCampaignBudget({
      maxUsd: 10,
      maxPosts: 5,
      prices: { 'alpha/a': { prompt: '0.000001', completion: '0.000001' } },
    });
    let restore = () => {};
    restore = installTransport({
      nativeFetch: async (_url, init) => {
        posts.push(JSON.parse(init.body));
        return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }], usage: { cost: 0.01 } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      },
      allowModels: new Set(['alpha/a', 'alpha/a:free']),
      allowPaid: true,
      rejectFree: true,
      budget,
    });
    try {
      await expect(fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        body: JSON.stringify({ model: 'alpha/a:free', messages: [{ role: 'user', content: 'q' }], max_tokens: 8 }),
      })).rejects.toBeInstanceOf(EvalInvariantError);
      expect(posts).toHaveLength(0);
    } finally {
      restore();
    }
  });

  it('pauses after a second in-flight 402, names the refusal, and counts every POST', async () => {
    let calls = 0;
    const events = [];
    const budget = createCampaignBudget({
      maxUsd: 10,
      maxPosts: 5,
      prices: { 'alpha/a': { prompt: '0.000001', completion: '0.000001' } },
    });
    const restore = installTransport({
      nativeFetch: async () => {
        calls += 1;
        return new Response('openrouter_in_flight_budget', {
          status: 402,
          headers: { 'Retry-After': '0' },
        });
      },
      allowModels: new Set(['alpha/a']),
      allowPaid: true,
      rejectFree: true,
      budget,
      onHttp: (event) => events.push(event),
    });
    try {
      const response = await attemptStore.run({ key: 'slot' }, () => fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'alpha/a',
          messages: [{ role: 'user', content: 'q' }],
          max_tokens: 8,
        }),
      }));
      expect(await response.text()).toContain('in_flight');
      expect(calls).toBe(2);
      expect(budget.state.pauseReason).toBe('in_flight_budget');
      // Both physical POSTs went through admit, and the journal names the refusal.
      expect(budget.state.posts).toBe(2);
      expect(events.filter((event) => event.phase === 'finished').map((event) => event.credit)).toEqual(['in_flight_budget', 'in_flight_budget']);
      // Only the first POST of the run is reserved as an attempt; the free retry is not.
      expect(events.filter((event) => event.phase === 'reserved')).toHaveLength(1);
    } finally {
      restore();
    }
  });
});
