import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as openrouter from '../src/engine/browser/openrouter.js';
import { canonicalCompletionRequest, queryModelResult } from '../src/engine/browser/openrouter.js';
import { settings } from '../src/engine/browser/settings.js';
import { createCampaignBudget } from './budget.js';
import { loadReplaySources } from './a8.js';
import { runComparison } from './a8Variants.js';
import { EvalInvariantError } from './invariant.js';
import { runIsolated } from './questionScope.js';
import { createGate, createSession, slotKey, snapshotLocal } from './runtime.js';
import { attemptStore, installTransport } from './transport.js';
import { sha256, stableStringify } from './util.js';

const COUNCIL = ['alpha/one', 'beta/two', 'gamma/three'];
const FROZEN = { councilModels: COUNCIL, chairmanModel: COUNCIL[0], bModel: COUNCIL[0] };
const PRICES = Object.fromEntries(COUNCIL.map((id) => [id, { prompt: '0.000001', completion: '0.000001' }]));
const TASK = {
  id: 'test:aime:replay',
  split: 'test',
  block: 'aime',
  stem: 'What is 3 + 4?',
  kind: 'integer',
  goldCanon: '7',
  choiceCount: 0,
};

function prepareOptions(model, stage, options) {
  return {
    ...options,
    maxTokens: stage === 'stage2' ? 4096 : 8192,
    provider: { order: [`${model.split('/')[0]}-host`], allow_fallbacks: false },
    temperature: 0.7,
    topP: 1,
  };
}

function reply(content, status = 200) {
  return new Response(JSON.stringify({
    choices: [{ message: { content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6, cost: 0.0001 },
  }), { status, headers: { 'content-type': 'application/json' } });
}

function stage2Answer(prompt) {
  const head = prompt.split('Your task:')[0];
  const labels = [...new Set([...head.matchAll(/Response (\d+)/g)].map((match) => `Response ${match[1]}`))];
  const reviews = labels.map((label, index) => `${label}:\nReviewed.\nCorrectness: ${9 - index}/10\nIssues: none`);
  const ranking = labels.map((label, index) => `${index + 1}. ${label}`).join('\n');
  return `${reviews.join('\n\n')}\n\nDISPUTED CLAIMS:\nnone\n\nFINAL RANKING:\n${ranking}`;
}

// Models finish in a different order from the roster, so the test notices a
// replay that reorders Stage 1.
const DELAY = { 'alpha/one': 40, 'beta/two': 5, 'gamma/three': 20 };

function respond(body) {
  const text = body.messages?.[0]?.content || '';
  const wait = DELAY[body.model] || 0;
  const make = () => {
    if (text.includes('You are evaluating different responses')) return reply(stage2Answer(text));
    if (text.includes('You are the Chairman') || text.includes('You are aggregating')) return reply('ANSWER: 7');
    return reply(`${body.model} works it out.\nANSWER: 7`);
  };
  return new Promise((resolve) => setTimeout(() => resolve(make()), wait));
}

describe('A8 replay by exact request', () => {
  const dirs = [];
  let session = null;
  let restore = () => {};

  beforeEach(() => {
    settings.apiKey = 'sk-user-test';
  });

  afterEach(() => {
    session?.uninstall();
    restore();
    session = null;
    restore = () => {};
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function open({ replay = null, fetchImpl = respond } = {}) {
    session?.uninstall();
    restore();
    const runDir = mkdtempSync(path.join(tmpdir(), 'a8-replay-'));
    dirs.push(runDir);
    const budget = createCampaignBudget({ maxUsd: 10, maxPosts: 500, prices: PRICES });
    session = createSession({
      runDir,
      budget,
      log() {},
      prepareOptions,
      retryLimit: 2,
      retainRoster: true,
      retryAfterCooldown: true,
      maxInFlight: 7,
      maxInFlightPerModel: 4,
      ...(replay ? {
        replayFrom: replay.reuse,
        priorAttempts: replay.prior,
        aliasOf: (model) => model,
        replayTerminal: true,
      } : {}),
    });
    session.install();
    const posts = [];
    restore = installTransport({
      nativeFetch: async (_url, init) => {
        const body = JSON.parse(init.body || '{}');
        const key = attemptStore.getStore()?.key || '';
        posts.push({ key, model: body.model, body });
        return fetchImpl(body, key, posts);
      },
      allowModels: new Set(COUNCIL),
      allowPaid: true,
      rejectFree: true,
      budget,
      onHttp: session.onHttp,
      onCooldown: session.onCooldown,
    });
    return { runDir, posts, budget };
  }

  const run = () => runIsolated(snapshotLocal(), 0, () => runComparison(TASK, session, FROZEN));
  const journalOf = (dir) => () => [path.join(dir, 'events.jsonl')];

  it('replays a whole question from its journal without a POST', async () => {
    const first = open();
    const original = await run();
    expect(original.status).toBe('complete');
    expect(first.posts).toHaveLength(12);
    const finished = session.slots()
      .filter((slot) => slot.meta?.stage === 'stage1')
      .sort((left, right) => left.completedOrdinal - right.completedOrdinal)
      .map((slot) => slot.meta.model);
    expect(finished).not.toEqual(COUNCIL);

    const replay = loadReplaySources(['source'], { journals: journalOf(first.runDir) });
    expect(replay.reuse.size).toBe(12);
    const second = open({ replay });
    const again = await run();
    expect(second.posts).toHaveLength(0);
    expect(again.arms.A8.text).toBe(original.arms.A8.text);
    expect(again.arms.S8.text).toBe(original.arms.S8.text);
    expect(again.diagnostics.leader).toEqual(original.diagnostics.leader);
    const reused = session.slots().filter((slot) => slot.reusedFrom);
    expect(reused).toHaveLength(12);
    expect(reused.every((slot) => slot.httpAttempts === 0 && slot.sourceOrdinal != null)).toBe(true);
    expect(second.budget.state.posts).toBe(0);
  });

  it('calls a failed slot again with only the attempts it has left, and reruns what depends on it', async () => {
    const failing = (body, key) => {
      if (key.includes('|replicates|sample|3|')) {
        return Promise.resolve(reply('', 400));
      }
      return respond(body);
    };
    const first = open({ fetchImpl: failing });
    const original = await run();
    expect(original.arms.S8.reason).toBe('incomplete_samples');
    const failedPosts = first.posts.filter((post) => post.key.includes('|replicates|sample|3|')).length;
    expect(failedPosts).toBeGreaterThan(0);

    const replay = loadReplaySources(['source'], { journals: journalOf(first.runDir) });
    const second = open({ replay });
    const again = await run();
    const retried = second.posts.filter((post) => post.key.includes('|replicates|sample|3|')).length;
    expect(failedPosts + retried).toBeLessThanOrEqual(2);
    if (failedPosts < 2) {
      expect(retried).toBe(1);
      expect(again.arms.S8.reason).toBeUndefined();
      expect(second.posts.map((post) => post.key.split('|')[1]).sort()).toEqual(['S8', 'replicates']);
      expect(again.arms.A8.text).toBe(original.arms.A8.text);
    } else {
      expect(retried).toBe(0);
      expect(again.arms.S8.reason).toBe('incomplete_samples');
    }
  });

  it('does not lend a slot whose request differs from the one about to be sent', async () => {
    const messages = [{ role: 'user', content: 'Hi' }];
    const request = canonicalCompletionRequest(COUNCIL[1], messages, prepareOptions(COUNCIL[1], 'stage1', {}));
    const requestHash = sha256(stableStringify(request));
    const meta = { questionId: 'q', branch: 'council', stage: 'stage1', sample: 1, model: COUNCIL[1], requestHash };
    const key = slotKey(meta);
    const forged = new Map([[key, {
      key,
      meta,
      request: { ...request, max_tokens: 1 },
      state: 'completed',
      result: { ok: true, content: 'ANSWER: 1' },
    }]]);
    open({ replay: { reuse: forged, prior: new Map() } });
    session.setContext({ questionId: 'q', branch: 'council', stage: 'stage1', sample: 1 });
    await expect(queryModelResult(COUNCIL[1], messages)).rejects.toBeInstanceOf(EvalInvariantError);
  });
});

describe('loadReplaySources', () => {
  it('lends answers and exhausted failures, and carries spent attempts for the rest', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'a8-sources-'));
    try {
      const file = path.join(dir, 'events.jsonl');
      const slot = (key, state, extra = {}) => appendFileSync(file, `${JSON.stringify({
        kind: 'slot',
        key,
        slot: { key, meta: { model: 'alpha/one' }, state, ...extra },
      })}\n`);
      const reserve = (key) => appendFileSync(file, `${JSON.stringify({ kind: 'http', phase: 'reserved', key })}\n`);
      slot('ok', 'completed', { result: { ok: true, content: 'x' }, httpAttempts: 1 });
      slot('once', 'failed', { result: { ok: false }, httpAttempts: 1 });
      slot('twice', 'failed', { result: { ok: false }, httpAttempts: 2 });
      slot('cool', 'skipped', { result: { ok: false, skipped: true }, httpAttempts: 0 });
      slot('cut', 'running', { httpAttempts: 0 });
      reserve('cut');
      appendFileSync(file, `${JSON.stringify({
        kind: 'slot',
        key: 'free',
        slot: { key: 'free', meta: { model: 'alpha/one:free' }, state: 'completed', result: { ok: true } },
      })}\n`);
      const { reuse, prior } = loadReplaySources(['source'], { journals: () => [file] });
      expect([...reuse.keys()].sort()).toEqual(['ok', 'twice']);
      expect(reuse.get('ok').sourceRun).toBe('source');
      expect(Object.fromEntries(prior)).toEqual({ once: 1, cut: 1 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('parallel branches', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('starts Stage 1 with every extra sample, and S8 before Stage 2 is done', async () => {
    const calls = [];
    const gates = [];
    vi.spyOn(openrouter, 'queryModelResult').mockImplementation((model, messages) => {
      const content = messages?.[0]?.content || '';
      calls.push({ model, content });
      const hold = content.includes('You are evaluating different responses');
      return new Promise((resolve) => {
        const answer = () => resolve({
          ok: true,
          content: hold ? stage2Answer(content) : 'ANSWER: 7',
          usage: { cost: 0 },
        });
        if (hold) gates.push(answer);
        else setTimeout(answer, 5);
      });
    });
    const runDir = mkdtempSync(path.join(tmpdir(), 'a8-parallel-'));
    try {
      const session = createSession({
        runDir,
        budget: { state: { paused: false, pauseReason: null }, lockFatal() {} },
        log() {},
      });
      const done = runComparison(TASK, session, FROZEN);
      await new Promise((resolve) => setTimeout(resolve, 1));
      expect(calls.filter((call) => call.content.startsWith('Answer the question.'))).toHaveLength(7);
      for (let step = 0; step < 50 && !calls.some((call) => call.content.includes('You are aggregating')); step += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      for (let step = 0; step < 50 && gates.length < 3; step += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(calls.some((call) => call.content.includes('You are aggregating'))).toBe(true);
      expect(calls.some((call) => call.content.includes('You are the Chairman'))).toBe(false);
      expect(gates).toHaveLength(3);
      for (const open of gates) open();
      const outcome = await done;
      expect(outcome.status).toBe('complete');
      expect(calls).toHaveLength(12);
    } finally {
      rmSync(runDir, { recursive: true, force: true });
    }
  });
});

describe('createGate', () => {
  it('never lets more callers in than its limit', async () => {
    const gate = createGate(2);
    let active = 0;
    let peak = 0;
    await Promise.all(Array.from({ length: 8 }, async () => {
      await gate.acquire();
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active -= 1;
      gate.release();
      await gate.acquire();
      active += 1;
      peak = Math.max(peak, active);
      active -= 1;
      gate.release();
    }));
    expect(peak).toBe(2);
    expect(gate.active).toBe(0);
  });
});
