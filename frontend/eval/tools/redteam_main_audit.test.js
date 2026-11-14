import { describe, expect, it } from 'vitest';

import { cleanVerdict, outcomeOf, rtEnding, summarize } from './redteam_main_audit.js';

describe('redteam_main_audit', () => {
  it('names how a red-team call ended', () => {
    expect(rtEnding(null)).toBe('no call');
    expect(rtEnding({ state: 'completed', result: { ok: true, content: 'x', finishReason: 'stop' } })).toBe('stop');
    expect(rtEnding({ state: 'completed', result: { ok: true, content: 'x', finishReason: 'length' } })).toBe('cap');
    expect(rtEnding({ state: 'completed', result: { ok: true, content: 'x' } })).toBe('finish_unknown');
    expect(rtEnding({ state: 'skipped', result: { ok: false, skipped: true } })).toBe('skipped');
    expect(rtEnding({ state: 'failed', result: { ok: false, error: { kind: 'total' } } })).toBe('failed: timeout');
  });

  it('reads the verdict by the clean rule, apart from the template', () => {
    expect(cleanVerdict('')).toBe('no text');
    expect(cleanVerdict('Critique.\nVERDICT: REFUTED | CONTESTED | UPHELD')).toBe('template in text');
    expect(cleanVerdict('I must end with VERDICT: REFUTED | CONTESTED | UPHELD and then')).toBe('template in text');
    expect(cleanVerdict('Critique cut before the end')).toBe('none');
    expect(cleanVerdict('Critique.\nVERDICT: UPHELD\nCONFIDENCE: 8')).toBe('UPHELD');
  });

  it('counts A6 against A7 and the losses with the red team at the cap', () => {
    expect(outcomeOf({ correct: 1 }, { correct: 0 })).toBe('A6 only');
    expect(outcomeOf({ correct: 0 }, { correct: 1 })).toBe('A7 only');
    expect(outcomeOf(null, { correct: 1 })).toBe('A7 only');
    const rows = [
      { id: 'a', ending: 'cap', engine: 'REFUTED', engineFromText: 'REFUTED', clean: 'template in text', outcome: 'A7 only' },
      { id: 'b', ending: 'stop', engine: 'UPHELD', engineFromText: 'UPHELD', clean: 'UPHELD', outcome: 'both right' },
      { id: 'c', ending: 'no call', engine: 'missing', engineFromText: null, clean: 'no text', outcome: 'A6 only' },
      { id: 'd', ending: 'stop', engine: 'CONTESTED', engineFromText: 'UPHELD', clean: 'UPHELD', outcome: 'both wrong' },
    ];
    const summary = summarize(rows);
    expect(summary).toMatchObject({ questions: 4, wins: 1, losses: 1, capLosses: 1, readDiffers: 1, recordMismatch: ['d'] });
  });
});
