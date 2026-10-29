import { describe, expect, it } from 'vitest';

import { createBudget } from './budget.js';

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
