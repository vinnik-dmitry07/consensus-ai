import { describe, expect, it } from 'vitest';

import { selectFromDev, selectSearchPool } from './select.js';

describe('dev selection', () => {
  it('keeps one general free model per vendor and ranks by published size', () => {
    const pool = selectSearchPool([
      { id: 'openrouter/free:free', name: '70b' },
      { id: 'acme/coder:free', name: '70b' },
      { id: 'acme/general:free', name: '8b' },
      { id: 'acme/bigger:free', name: '70b' },
      { id: 'beta/small:free', name: '7b' },
      { id: 'paid/model', name: '70b' },
    ]);
    expect(pool.map((model) => model.id)).toEqual(['acme/bigger:free', 'beta/small:free']);
  });

  it('breaks dev ties by completion, latency, and config id', () => {
    const rows = [
      { configId: 'b/m:free', model: 'b/m:free', vendor: 'b', baseId: 'b/m:free', reasoning: 'default', correct: 1, success: true, latencyMs: 5 },
      { configId: 'a/m:free', model: 'a/m:free', vendor: 'a', baseId: 'a/m:free', reasoning: 'default', correct: 1, success: true, latencyMs: 9 },
      { configId: 'a/m:free#high', model: 'a/m:free-reasoning-high', vendor: 'a', baseId: 'a/m:free', reasoning: 'high', correct: 0, success: true, latencyMs: 4 },
    ];
    const selected = selectFromDev(rows);
    expect(selected.b.configId).toBe('b/m:free');
    expect(selected.chairman.reasoning).toBe('default');
    expect(selected.label).toBe('dev-selected');
    expect(selected.council.map((row) => row.vendor)).toEqual(['b', 'a']);
  });
});
