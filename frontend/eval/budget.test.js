import { describe, expect, it } from 'vitest';

import { createBudget, createSpendBudget } from './budget.js';

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
