// Preload (`node --import`) that serves chosen files from other paths when read
// with readFileSync. FROZEN_REDIRECT holds a JSON list of [live, frozen] pairs.
// Nothing on disk is moved or written; only reads of exactly those paths in
// this process see the frozen bytes. Named ESM imports of node:fs see the patch
// through syncBuiltinESMExports.

import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const key = (file) => path.resolve(file instanceof URL ? fileURLToPath(file) : String(file)).toLowerCase();
const pairs = JSON.parse(process.env.FROZEN_REDIRECT || '[]');
const redirect = new Map(pairs.map(([live, frozen]) => [key(live), frozen]));
const readFileSync = fs.readFileSync;

if (redirect.size) {
  fs.readFileSync = function patchedReadFileSync(file, ...rest) {
    const target = (typeof file === 'string' || file instanceof URL) ? redirect.get(key(file)) : undefined;
    return readFileSync.call(this, target ?? file, ...rest);
  };
  syncBuiltinESMExports();
}
