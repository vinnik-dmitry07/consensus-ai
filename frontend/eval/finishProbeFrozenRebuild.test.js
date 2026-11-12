import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { runRedirected } from './finishProbeFrozenRebuild.js';

let dir;
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

describe('frozen input redirect', () => {
  it('serves the frozen bytes to a named readFileSync import and leaves the live file alone', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'redirect-'));
    const live = path.join(dir, 'live.md');
    const frozen = path.join(dir, 'frozen.md');
    const other = path.join(dir, 'other.md');
    writeFileSync(live, 'live');
    writeFileSync(frozen, 'frozen');
    writeFileSync(other, 'other');
    const script = path.join(dir, 'read.mjs');
    writeFileSync(script, "import { readFileSync } from 'node:fs';\nconst [a, b] = process.argv.slice(2);\nconsole.log(readFileSync(a, 'utf8') + '|' + readFileSync(b, 'utf8'));\n");
    const child = runRedirected([script, live.toUpperCase(), other], [[live, frozen]]);
    expect(child.status).toBe(0);
    expect(child.stdout.trim()).toBe('frozen|other');
    expect(readFileSync(live, 'utf8')).toBe('live');
  });
});
