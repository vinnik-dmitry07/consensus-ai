import { describe, expect, it } from 'vitest';

import {
  CHECKER, END, START, WRITER, checkMessages, parseCheck, placeSection, section, writeChecked, writeMessages,
} from './finishProbeAnalysis.js';

const README = 'intro\n<!-- finish-probe-v2:start -->\nblock\n<!-- finish-probe-v2:end -->\ntail\n';

describe('finish probe analysis', () => {
  it('passes the report as data and asks for a fix with the problems', () => {
    const first = writeMessages('P', 'R');
    expect(first[0].content).toContain('<<<REPORT\nR\nREPORT>>>');
    expect(first[0].content).not.toContain('Your earlier text');
    const fix = writeMessages('P', 'R', [{ quote: 'x', issue: 'y' }], 'draft');
    expect(fix[0].content).toContain('<<<TEXT\ndraft\nTEXT>>>');
    expect(fix[0].content).toContain('"issue": "y"');
    expect(checkMessages('P', 'R', 'T')[0].content).toContain('<<<TEXT\nT\nTEXT>>>');
  });

  it('reads the checker only when its reply is valid, and ok needs no problems', () => {
    expect(parseCheck('{"ok": true, "problems": []}')).toEqual({ ok: true, problems: [] });
    expect(parseCheck('```json\n{"ok": true, "problems": [{"quote": "a", "issue": "b"}]}\n```').ok).toBe(false);
    expect(parseCheck('no')).toBeNull();
    expect(parseCheck('{"ok": "yes", "problems": []}')).toBeNull();
  });

  it('places the section after the v2 block and replaces it on a second run', () => {
    const once = placeSection(README, 'A');
    expect(once.indexOf(START)).toBeGreaterThan(once.indexOf('<!-- finish-probe-v2:end -->'));
    expect(once).toContain(`${START}\n\nA\n\n${END}`);
    expect(once.endsWith('tail\n')).toBe(true);
    const twice = placeSection(once, 'B');
    expect(twice).not.toContain('\nA\n');
    expect(twice.split(START)).toHaveLength(2);
    expect(() => placeSection('no block', 'A')).toThrow(/not in the README/);
  });

  it('names both models and inserts the text unchanged', () => {
    const text = section('  Текст модели.  ', { problems: [] });
    expect(text).toContain(WRITER);
    expect(text).toContain(CHECKER);
    expect(text).toContain('замечаний: 0');
    expect(text.endsWith('Текст модели.')).toBe(true);
  });

  it('writes, checks, fixes once, and gives up when problems remain', async () => {
    const calls = [];
    const replies = {
      'write-1': 'draft one', 'check-1': '{"ok": false, "problems": [{"quote": "q", "issue": "i"}]}',
      'write-2': 'draft two', 'check-2': '{"ok": true, "problems": []}',
    };
    const post = async (model, messages, role) => { calls.push([model, role]); return { ok: true, content: replies[role] }; };
    const good = await writeChecked({ protocol: 'P', report: 'R', post });
    expect(good.text).toBe('draft two');
    expect(calls).toEqual([[WRITER, 'write-1'], [CHECKER, 'check-1'], [WRITER, 'write-2'], [CHECKER, 'check-2']]);
    const stubborn = async (model, messages, role) => ({ ok: true, content: role.startsWith('check') ? '{"ok": false, "problems": [{"quote": "q", "issue": "i"}]}' : 'draft' });
    const bad = await writeChecked({ protocol: 'P', report: 'R', post: stubborn });
    expect(bad.text).toBeNull();
    expect(bad.reason).toBe('problems remain after the fix');
  });
});
