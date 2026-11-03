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
    const runDir = mkdtempSync(path.join(tmpdir(), 'a8-'));
    const session = createSession({
      runDir,
      budget: { state: { paused: false, pauseReason: null }, lockFatal() {} },
      log() {},
    });
    const task = {
      id: 'dev:aime:1',
      split: 'dev',
      block: 'aime',
      stem: 'What is 1?',
      kind: 'integer',
      goldCanon: 'GOLD-TOKEN-99',
      choiceCount: 0,
    };
    const frozen = {
      councilModels: ['alpha/one', 'beta/two', 'gamma/three'],
      chairmanModel: 'alpha/one',
      bModel: 'alpha/one',
    };
    const outcome = await runComparison(task, session, frozen);
    expect(outcome.status).toBe('complete');
    expect(calls).toHaveLength(12);
    expect(calls.filter((call) => call.model === 'alpha/one').length).toBeGreaterThan(0);
    expect(calls.every((call) => !call.content.includes('GOLD-TOKEN-99'))).toBe(true);
    expect(outcome.arms.A8.model).toBe('alpha/one');
    expect(outcome.arms.S8.model).toBe('alpha/one');
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
    const runDir = mkdtempSync(path.join(tmpdir(), 'a8-'));
    const session = createSession({
      runDir,
      budget: { state: { paused: false, pauseReason: null }, lockFatal() {} },
      log() {},
    });
    const task = {
      id: 'dev:aime:2',
      split: 'dev',
      block: 'aime',
      stem: 'What is 1?',
      kind: 'integer',
      goldCanon: '1',
      choiceCount: 0,
    };
    const outcome = await runComparison(task, session, {
      councilModels: ['alpha/one', 'beta/two', 'gamma/three'],
      chairmanModel: 'alpha/one',
      bModel: 'alpha/one',
    });
    expect(outcome.status).toBe('complete');
    expect(outcome.arms.S8.reason).toBe('incomplete_samples');
    expect(outcome.arms.S8.correct).toBe(0);
    expect(alphaAnswers).toBeGreaterThan(1);
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

  it('pauses after a second in-flight 402', async () => {
    let calls = 0;
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
    } finally {
      restore();
    }
  });
});
