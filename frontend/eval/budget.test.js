import { describe, expect, it } from 'vitest';

import { classifyCreditResponse, classifyLimitMessage, createBudget, createCampaignBudget, createSpendBudget } from './budget.js';

const NOON = Date.parse('2026-10-27T12:00:00Z');
const NEXT_NOON = Date.parse('2026-10-28T12:00:00Z');

describe('daily post budget', () => {
  it('spends the server remaining instead of the sum of local and server counters', () => {
    const budget = createBudget({
      serverRemaining: 5,
      attemptedToday: 4,
      dailyLimit: 1000,
      utcDay: '2026-10-27',
    });
    let accepted = 0;
    for (let i = 0; i < 6; i += 1) {
      if (budget.tryReserve(NOON)) accepted += 1;
    }
    expect(accepted).toBe(5);
    expect(budget.state.serverRemaining).toBe(0);
    expect(budget.state.attemptedToday).toBe(9);
    expect(budget.state.pauseReason).toBe('platform_day');
  });

  it('uses the conservative cap only when the server counter is missing', () => {
    const budget = createBudget({
      conservativeDaily: 2,
      utcDay: '2026-10-27',
    });
    expect(budget.tryReserve(NOON)).toBe(true);
    expect(budget.tryReserve(NOON)).toBe(true);
    expect(budget.tryReserve(NOON)).toBe(false);
    expect(budget.state.pauseReason).toBe('platform_day');
  });

  it('drops yesterday remaining at the UTC boundary', () => {
    const budget = createBudget({
      serverRemaining: 20,
      attemptedToday: 80,
      dailyLimit: 1000,
      conservativeDaily: 2,
      utcDay: '2026-10-27',
    });
    expect(budget.rollDay(NEXT_NOON)).toBe(true);
    expect(budget.state.serverRemaining).toBe(null);
    expect(budget.state.dailyLimit).toBe(null);
    expect(budget.state.attemptedToday).toBe(0);
    expect(budget.tryReserve(NEXT_NOON)).toBe(true);
    expect(budget.tryReserve(NEXT_NOON)).toBe(true);
    expect(budget.tryReserve(NEXT_NOON)).toBe(false);
  });
});

describe('account limit text', () => {
  it('only treats the OpenRouter free-day slug as a platform day cap', () => {
    expect(classifyLimitMessage('Rate limit exceeded: free-models-per-min')).toBe('platform_minute');
    expect(classifyLimitMessage('Rate limit exceeded: free-models-per-day')).toBe('platform_day');
    expect(classifyLimitMessage('Provider daily limit exceeded')).toBeNull();
    expect(classifyLimitMessage('per-day quota')).toBeNull();
  });
});

describe('paid repair spend', () => {
  it('charges token prices and pauses when the usd cap is reached', () => {
    const budget = createSpendBudget({
      maxUsd: 0.01,
      maxPosts: 10,
      utcDay: '2026-10-27',
      pricing: new Map([['alpha/a', { prompt: 0.001, completion: 0.002 }]]),
    });
    expect(budget.tryReserve(NOON, 'alpha/a')).toBe(true);
    budget.charge('alpha/a', { prompt_tokens: 4, completion_tokens: 3 }, true, 100);
    expect(budget.state.usd).toBeCloseTo(0.01);
    expect(budget.state.pauseReason).toBe('spend_cap');
    expect(budget.tryReserve(NOON, 'alpha/a')).toBe(false);
  });

  it('charges max tokens times the completion price when usage is missing', () => {
    const budget = createSpendBudget({
      maxUsd: 100,
      maxPosts: 10,
      utcDay: '2026-10-27',
      pricing: new Map([['alpha/a', { prompt: 1, completion: 0.5 }]]),
    });
    budget.charge('alpha/a', null, false, 4);
    expect(budget.state.usd).toBe(2);
    expect(budget.state.usageUnknownCharged).toBe(1);
  });

  it('continues after the post cap is raised', () => {
    const budget = createSpendBudget({
      maxUsd: 10,
      maxPosts: 1,
      utcDay: '2026-10-27',
      pricing: new Map(),
    });
    expect(budget.tryReserve(NOON, 'alpha/a')).toBe(true);
    expect(budget.tryReserve(NOON, 'alpha/a')).toBe(false);
    expect(budget.state.pauseReason).toBe('spend_cap');
    budget.state.maxPosts = 5;
    budget.state.paused = false;
    budget.state.pauseReason = null;
    expect(budget.tryReserve(NOON, 'alpha/a')).toBe(true);
    expect(budget.state.posts).toBe(2);
  });
});

describe('credit response classes', () => {
  it('separates an in-flight 402 from a hard shortfall and a budget 403', () => {
    expect(classifyCreditResponse(402, 'openrouter_in_flight_budget').kind).toBe('in_flight_budget');
    expect(classifyCreditResponse(402, 'openrouter_in_flight_budget').pause).toBe(false);
    expect(classifyCreditResponse(402, 'weight_exceeds_budget').retryOnce).toBe(false);
    expect(classifyCreditResponse(402, 'unrecognized payment').pause).toBe(true);
    expect(classifyCreditResponse(403, 'guardrail budget').kind).toBe('key_budget');
    expect(classifyCreditResponse(403, 'key_limit exceeded').kind).toBe('key_budget');
    expect(classifyCreditResponse(403, 'content_filter').pause).toBe(false);
  });
});

describe('campaign reservation budget', () => {
  const pricing = {
    'alpha/a': { prompt: '0.000001', completion: '0.000001' },
    'beta/b': { prompt: '0.000001', completion: '0.000001' },
  };

  it('lets B wait while A holds a large reserve, then admits B after the real cost', async () => {
    const budget = createCampaignBudget({ maxUsd: 50, maxPosts: 10, prices: pricing });
    const first = budget.admit({ attemptId: 'a', model: 'alpha/a', promptTokens: 1, maxTokens: 40_000_000 });
    expect(first.ok).toBe(true);
    expect(first.usd).toBeCloseTo(40);
    const waiting = budget.admit({ attemptId: 'b', model: 'beta/b', promptTokens: 1, maxTokens: 20_000_000 });
    expect(waiting).toEqual({ ok: false, reason: 'wait' });
    const settled = budget.settle({
      attemptId: 'a',
      usage: { cost: 0.01 },
      pricing: pricing['alpha/a'],
    });
    expect(settled.cost).toBeCloseTo(0.01);
    const second = budget.admit({ attemptId: 'b', model: 'beta/b', promptTokens: 1, maxTokens: 20_000_000 });
    expect(second.ok).toBe(true);
  });

  it('refuses a missing price and keeps an unfinished reserve unresolved', () => {
    const events = [];
    const budget = createCampaignBudget({
      maxUsd: 10,
      maxPosts: 5,
      prices: { 'alpha/a': { prompt: '0.000001', completion: '0.000002' } },
      onEvent: (event) => events.push(event),
    });
    expect(budget.admit({ attemptId: 'missing', model: 'nope/x', promptTokens: 10, maxTokens: 10 }).reason)
      .toBe('unbounded_price');
    expect(budget.admit({ attemptId: 'a', model: 'alpha/a', promptTokens: 100, maxTokens: 50 }).ok).toBe(true);
    budget.settle({ attemptId: 'a', incomplete: true });
    expect(budget.state.unresolvedUsd).toBeGreaterThan(0);
    expect(budget.state.settledUsd).toBe(0);
    budget.settle({ attemptId: 'a', usage: { cost: 1 } });
    expect(budget.state.settledUsd).toBe(0);
    const restored = createCampaignBudget({ maxUsd: 10, maxPosts: 5, prices: pricing });
    restored.applyJournal(events);
    expect(restored.state.posts).toBe(1);
    expect(restored.state.unresolvedUsd).toBeCloseTo(budget.state.unresolvedUsd);
    expect(restored.state.settledUsd).toBe(0);
  });

  it('keeps a finished answer that lands on the cap and blocks the next reserve', () => {
    const budget = createCampaignBudget({
      maxUsd: 0.02,
      maxPosts: 5,
      prices: { 'alpha/a': { prompt: '0.000001', completion: '0.000001' } },
    });
    expect(budget.admit({ attemptId: 'a', model: 'alpha/a', promptTokens: 10, maxTokens: 10 }).ok).toBe(true);
    budget.settle({ attemptId: 'a', usage: { cost: 0.02 } });
    expect(budget.state.settledUsd).toBeCloseTo(0.02);
    expect(budget.state.pauseReason).toBe('budget_blocked');
    const next = budget.admit({ attemptId: 'b', model: 'alpha/a', promptTokens: 1, maxTokens: 1 });
    expect(next.ok).toBe(false);
  });

  it('refuses a settled attempt id and restores a durable pause', () => {
    const events = [];
    const budget = createCampaignBudget({
      maxUsd: 10,
      maxPosts: 5,
      prices: { 'alpha/a': { prompt: '0.000001', completion: '0.000001' } },
      onEvent: (event) => events.push(event),
    });
    expect(budget.admit({ attemptId: 'a', model: 'alpha/a', promptTokens: 10, maxTokens: 10 }).ok).toBe(true);
    budget.settle({ attemptId: 'a', usage: { cost: 0.01 } });
    expect(budget.admit({ attemptId: 'a', model: 'alpha/a', promptTokens: 10, maxTokens: 10 }).reason).toBe('spent-attempt');
    budget.pause('auth', null);
    budget.pause('in_flight_budget', null);
    const restored = createCampaignBudget({ maxUsd: 10, maxPosts: 5, prices: {} });
    restored.applyJournal(events);
    expect(restored.state.paused).toBe(true);
    expect(restored.state.pauseReason).toBe('auth');
    expect(events.some((event) => event.kind === 'pause' && event.reason === 'in_flight_budget')).toBe(false);
  });
});

describe('campaign transient pauses', () => {
  it('lifts a network or in-flight pause and keeps credit, cap and fatal stops', () => {
    const budget = createCampaignBudget({ maxUsd: 1, maxPosts: 5, prices: {} });
    budget.pause('network', Date.now() + 1000);
    expect(budget.isTransientPause()).toBe(true);
    expect(budget.resumeTransient()).toBe(true);
    expect(budget.state.paused).toBe(false);
    budget.pause('in_flight_budget', null);
    expect(budget.resumeTransient()).toBe(true);
    for (const reason of ['insufficient_funds', 'auth', 'key_budget', 'payment_unknown', 'budget_blocked']) {
      budget.pause(reason, null);
      expect(budget.resumeTransient()).toBe(false);
      expect(budget.state.paused).toBe(true);
      budget.state.paused = false;
      budget.state.pauseReason = null;
    }
    budget.lockFatal('broken');
    expect(budget.resumeTransient()).toBe(false);
  });
});
