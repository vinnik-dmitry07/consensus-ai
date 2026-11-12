import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { flagValue, mdTable, median, placeAfter, placeAnalysis, rewriteFile } from './noteTools.js';

let dir;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const record = (text) => ({ text, reason: 'checker rejected', check: { problems: [] }, writer: 'w/model', checker: 'c/model', spend: { settledUsd: 0.01, heldUsd: 0, posts: 2 } });

describe('note tools', () => {
  it('reads flags, medians, and places a section once after its anchor', () => {
    expect(flagValue(['--run', 'a', '--readme'], '--run')).toBe('a');
    expect(flagValue(['--readme'], '--run')).toBeNull();
    expect(median([3, 1, 2, 10])).toBe(2.5);
    expect(median([])).toBeNull();
    const once = placeAfter('top\n<!-- a -->\nend\n', '<!-- s -->', '<!-- e -->', 'one', '<!-- a -->');
    expect(once).toBe('top\n<!-- a -->\n\n<!-- s -->\n\none\n\n<!-- e -->\nend\n');
    expect(placeAfter(once, '<!-- s -->', '<!-- e -->', 'two', '<!-- a -->')).toBe('top\n<!-- a -->\n\n<!-- s -->\n\ntwo\n\n<!-- e -->\nend\n');
    expect(() => placeAfter('no anchor', '<!-- s -->', '<!-- e -->', 'x', '<!-- a -->')).toThrow('is not in the README');
  });

  it('keeps a file in its own line endings and leaves an unchanged file alone', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'notes-'));
    const file = path.join(dir, 'README.md');
    writeFileSync(file, 'a\r\nb\r\n');
    expect(rewriteFile(file, (text) => text.replace('b', 'c'))).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe('a\r\nc\r\n');
    expect(rewriteFile(file, (text) => text)).toBe(false);
    expect(mdTable(['x', 'y'], [[1, 2]])).toEqual(['| x | y |', '|---|---|', '| 1 | 2 |']);
  });

  it('writes analysis.md and places the section, or returns 2 when no text came back', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    dir = mkdtempSync(path.join(tmpdir(), 'notes-'));
    const readme = path.join(dir, 'README.md');
    writeFileSync(readme, 'intro\n<!-- block:end -->\ntail\n');
    const args = { dir, instruction: 'i', rules: 'r', report: 'p', limits: {}, readme, start: '<!-- an:start -->', end: '<!-- an:end -->', after: '<!-- block:end -->', section: (r) => `#### A\n\n${r.text}` };
    const seen = [];
    expect(await placeAnalysis({ ...args, analyse: async (input) => { seen.push(input); return record('body'); } })).toBe(0);
    expect(seen[0]).toMatchObject({ dir, instruction: 'i', rules: 'r', report: 'p' });
    expect(readFileSync(path.join(dir, 'analysis.md'), 'utf8')).toBe('#### A\n\nbody\n');
    expect(readFileSync(readme, 'utf8')).toBe('intro\n<!-- block:end -->\n\n<!-- an:start -->\n\n#### A\n\nbody\n\n<!-- an:end -->\ntail\n');
    expect(await placeAnalysis({ ...args, analyse: async () => record(null) })).toBe(2);
  });
});
