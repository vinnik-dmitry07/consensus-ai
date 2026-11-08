import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { queryModelResult } from '../src/engine/browser/openrouter.js';
import { settings } from '../src/engine/browser/settings.js';
import { loopReview } from './a8.js';
import { questionWaits } from './a8Variants.js';
import { createCampaignBudget } from './budget.js';
import { createSession } from './runtime.js';
import { attemptStore, generationIdFrom, installTransport } from './transport.js';

const MODEL = 'alpha/one';
const PRICES = { [MODEL]: { prompt: '0.000001', completion: '0.000001' } };
const MESSAGES = [{ role: 'user', content: 'Count the pairs.' }];

function prose(length, seed = 3) {
  const words = ['basis', 'cyclic', 'divisor', 'graph', 'kernel', 'lemma', 'orbit', 'prime', 'ring', 'torus'];
  let state = seed;
  const out = [];
  let size = 0;
  while (size < length) {
    state = (state * 1103515245 + 12345) % 2147483648;
    const word = `${words[state % words.length]}${state % 991}`;
    out.push(word);
    size += word.length + 1;
  }
  return out.join(' ').slice(0, length);
}

// One SSE event per network chunk, delivered on demand, like a live stream:
// a reader that stops early really leaves the rest unread.
function sse(deltas, { usage = null, id = 'gen-abc123' } = {}) {
  const events = deltas.map((delta) => `data: ${JSON.stringify({ id, choices: [{ delta }] })}\n\n`);
  const last = { id, choices: [{ delta: {}, finish_reason: 'stop' }] };
  if (usage) last.usage = usage;
  events.push(`data: ${JSON.stringify(last)}\n\n`, 'data: [DONE]\n\n');
  const encoder = new TextEncoder();
  let index = 0;
  const body = new ReadableStream({
    pull(controller) {
      if (index >= events.length) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(events[index]));
      index += 1;
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function loopingStream(id) {
  const paragraph = 'Recheck the residues once more and recount every pair from the start. ';
  const text = `${prose(3000)} ${paragraph.repeat(400)}`;
  const parts = [];
  for (let index = 0; index < 30000; index += 500) parts.push({ reasoning: text.slice(index, index + 500) });
  return sse(parts, { id });
}

function finishedStream(id) {
  return sse([{ reasoning: prose(2000) }, { content: 'ANSWER: 12' }], {
    id,
    usage: { prompt_tokens: 10, completion_tokens: 600, total_tokens: 610, cost: 0.0006 },
  });
}

function upstream429() {
  const error = { message: 'Provider returned error', code: 429, metadata: { raw: `${MODEL} is temporarily rate-limited upstream. Please retry shortly.` } };
  return new Response(JSON.stringify({ error }), { status: 429, headers: { 'content-type': 'application/json', 'Retry-After': '0' } });
}

// A stream the provider closes mid-answer: text, then no finish and no [DONE].
function cutStream(id) {
  const encoder = new TextEncoder();
  const events = [{ reasoning: prose(800) }, { reasoning: prose(800, 7) }]
    .map((delta) => `data: ${JSON.stringify({ id, choices: [{ delta }] })}\n\n`);
  let index = 0;
  const body = new ReadableStream({
    pull(controller) {
      if (index >= events.length) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(events[index]));
      index += 1;
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function capacityStream(id) {
  const error = { code: 502, message: `Upstream error from Host: ${MODEL} is temporarily at capacity. Please retry shortly.` };
  const body = `: OPENROUTER PROCESSING\n\ndata: ${JSON.stringify({ id, choices: [], error })}\n\ndata: [DONE]\n\n`;
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function journal(runDir) {
  return readFileSync(path.join(runDir, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

describe('loop guard through the eval session', () => {
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
  });

  function open(fetchImpl, { runDir = null, retryLimit = 2, contextTokens = null, budget = null } = {}) {
    session?.uninstall();
    restore();
    const dir = runDir || mkdtempSync(path.join(tmpdir(), 'a8-loop-'));
    if (!runDir) dirs.push(dir);
    const ledger = budget || createCampaignBudget({ maxUsd: 10, maxPosts: 50, prices: PRICES });
    session = createSession({
      runDir: dir,
      budget: ledger,
      log() {},
      retryLimit,
      retainRoster: true,
      // As in the campaign sessions: a skipped slot is asked again once its
      // route has cooled down.
      retryAfterCooldown: true,
      prepareOptions: (model, stage, options) => ({
        ...options,
        maxTokens: 32768,
        provider: { order: ['host'], allow_fallbacks: false },
        loopGuard: true,
        evalAnnotations: true,
        ...(contextTokens ? { contextTokens } : {}),
      }),
    });
    session.install();
    const posts = [];
    restore = installTransport({
      nativeFetch: async (_url, init) => {
        posts.push({ key: attemptStore.getStore()?.key || '', body: JSON.parse(init.body || '{}') });
        return fetchImpl(posts.length);
      },
      allowModels: new Set([MODEL]),
      allowPaid: true,
      rejectFree: true,
      budget: ledger,
      onHttp: session.onHttp,
      onCooldown: session.onCooldown,
    });
    session.setContext({ questionId: 'q1', branch: 'council', stage: 'stage2', sample: 1 });
    return { runDir: dir, posts, budget: ledger };
  }

  it('retries a looping attempt once and books two posts', async () => {
    const { runDir, posts, budget } = open((n) => (n === 1 ? loopingStream('gen-first') : finishedStream('gen-second')));
    const result = await queryModelResult(MODEL, MESSAGES);
    expect(result.ok).toBe(true);
    expect(result.content).toBe('ANSWER: 12');
    expect(posts).toHaveLength(2);
    expect(budget.state.posts).toBe(2);
    const slot = session.slots()[0];
    expect(slot.state).toBe('completed');
    expect(slot.httpAttempts).toBe(2);
    const finished = journal(runDir).filter((event) => event.kind === 'http' && event.phase === 'finished');
    expect(finished.map((event) => event.generationId)).toEqual(['gen-first', 'gen-second']);
    expect(finished[0].cancelReason).toBe('loop');
    expect(finished[0].incomplete).toBe(true);
    expect(finished[1].cancelReason).toBeNull();
    // The aborted attempt has no usage, so its reserve stays unresolved.
    expect(budget.unresolvedAttempts().map((row) => row.attemptId)).toEqual([`${slot.key}#1`]);
    // The review finds the stop in the real journal and rebuilds it offline.
    const review = loopReview(runDir, true);
    expect(review).toHaveLength(1);
    expect(review[0]).toMatchObject({ attemptId: `${slot.key}#1`, channel: 'reasoning', reproduced: true, outcome: 'retried and finished' });
  });

  it('keeps the text of a second loop and never makes a third attempt', async () => {
    const { runDir, posts, budget } = open(() => loopingStream('gen-loop'));
    const result = await queryModelResult(MODEL, MESSAGES);
    expect(posts).toHaveLength(2);
    expect(result.ok).toBe(true);
    expect(result.loopCut).toBe(true);
    expect(result.contentFromReasoning).toBe(true);
    const slot = session.slots()[0];
    expect(slot.state).toBe('completed');
    expect(slot.finishReason).toBe('loop');
    expect(slot.httpAttempts).toBe(2);
    const review = loopReview(runDir, true);
    expect(review.map((row) => row.outcome)).toEqual(['kept after a second loop', 'kept after a second loop']);
    expect(review[1].position).toBe(result.loop.position);
    // A resumed run reads the stored outcome and posts nothing.
    const again = open(() => loopingStream('gen-loop'), { runDir, budget });
    const replayed = await queryModelResult(MODEL, MESSAGES);
    expect(again.posts).toHaveLength(0);
    expect(replayed.loopCut).toBe(true);
    expect(budget.state.posts).toBe(2);
  });

  it('ends a slot as failed when the last allowed attempt drops on the network', async () => {
    const { posts } = open(() => {
      throw new TypeError('fetch failed');
    }, { retryLimit: 1 });
    const result = await queryModelResult(MODEL, MESSAGES);
    expect(result.ok).toBe(false);
    expect(posts).toHaveLength(1);
    expect(session.slots()[0].state).toBe('failed');
  });

  it('spends no model attempt on an upstream 429 and settles it at $0', async () => {
    const { posts, budget } = open((n) => (n <= 2 ? upstream429() : finishedStream('gen-ok')));
    const first = await queryModelResult(MODEL, MESSAGES);
    expect(first.skipped).toBe(true);
    expect(session.slots()[0]).toMatchObject({ state: 'skipped', limitedAttempts: 1 });
    // The engine keeps its own cooldown in the question's local storage; a
    // campaign starts every pass of a question from a fresh copy of it.
    globalThis.localStorage.removeItem('llm-council-model-cooldowns');
    expect((await queryModelResult(MODEL, MESSAGES)).skipped).toBe(true);
    globalThis.localStorage.removeItem('llm-council-model-cooldowns');
    // Two refusals used to exhaust the two attempts and fail the slot for good.
    const third = await queryModelResult(MODEL, MESSAGES);
    expect(third.ok).toBe(true);
    expect(third.content).toBe('ANSWER: 12');
    expect(posts).toHaveLength(3);
    expect(session.slots()[0]).toMatchObject({ state: 'completed', httpAttempts: 3, limitedAttempts: 2 });
    // Both refusals settled at $0: nothing is held, and every POST is counted.
    expect(budget.unresolvedAttempts()).toEqual([]);
    expect(budget.state.posts).toBe(3);
  });

  it('treats an in-stream capacity error as a refusal: cooldown, no attempt spent, $0', async () => {
    const { posts, budget } = open((n) => (n === 1 ? capacityStream('gen-cap') : finishedStream('gen-ok')));
    const first = await queryModelResult(MODEL, MESSAGES);
    expect(first.skipped).toBe(true);
    expect(Math.max(...session.cooldowns.values())).toBeGreaterThan(Date.now() + 60_000);
    expect(budget.unresolvedAttempts()).toEqual([]);
    // While the route cools down, a call posts nothing.
    expect((await queryModelResult(MODEL, MESSAGES)).skipped).toBe(true);
    expect(posts).toHaveLength(1);
    // After the cooldown the call is asked again and completes.
    for (const id of session.cooldowns.keys()) session.cooldowns.set(id, 0);
    const done = await queryModelResult(MODEL, MESSAGES);
    expect(done.ok).toBe(true);
    expect(posts).toHaveLength(2);
    expect(session.slots()[0]).toMatchObject({ state: 'completed', httpAttempts: 2, limitedAttempts: 1 });
  });

  it('asks a call again after the provider closes its stream early', async () => {
    const { posts } = open((n) => (n === 1 ? cutStream('gen-cut') : finishedStream('gen-ok')));
    const first = await queryModelResult(MODEL, MESSAGES);
    expect(first).toMatchObject({ ok: false, skipped: true, retryable: true });
    expect(first.error.kind).toBe('protocol');
    expect(session.slots()[0]).toMatchObject({ state: 'skipped', httpAttempts: 1 });
    expect(session.slots()[0].skippedAt).toBeGreaterThan(0);
    const second = await queryModelResult(MODEL, MESSAGES);
    expect(second.ok).toBe(true);
    expect(second.content).toBe('ANSWER: 12');
    expect(posts).toHaveLength(2);
    expect(session.slots()[0]).toMatchObject({ state: 'completed', httpAttempts: 2 });
  });

  it('fails a call for good when its last allowed attempt is cut too', async () => {
    const { posts } = open(() => cutStream('gen-cut'));
    expect((await queryModelResult(MODEL, MESSAGES)).skipped).toBe(true);
    const last = await queryModelResult(MODEL, MESSAGES);
    expect(last.ok).toBe(false);
    expect(last.skipped).toBeFalsy();
    expect(session.slots()[0].state).toBe('failed');
    const stored = await queryModelResult(MODEL, MESSAGES);
    expect(stored.skipped).toBeFalsy();
    expect(posts).toHaveLength(2);
  });

  it('skips a stored skip again with a fresh time while its route still cools', async () => {
    const { posts } = open((n) => (n === 1 ? capacityStream('gen-cap') : finishedStream('gen-ok')));
    expect((await queryModelResult(MODEL, MESSAGES)).skipped).toBe(true);
    const firstSkip = session.slots()[0].skippedAt;
    await new Promise((resolve) => setTimeout(resolve, 5));
    const since = Date.now();
    expect((await queryModelResult(MODEL, MESSAGES)).skipped).toBe(true);
    expect(posts).toHaveLength(1);
    expect(firstSkip).toBeLessThan(since);
    expect(session.slots()[0].skippedAt).toBeGreaterThanOrEqual(since);
    // The cooldown ends before the stage does. The fresh skip still holds the
    // question, so the call is asked on the next pass instead of being lost.
    for (const id of session.cooldowns.keys()) session.cooldowns.set(id, 0);
    expect(questionWaits(session, 'q1', since)).toBe(true);
    const done = await queryModelResult(MODEL, MESSAGES);
    expect(done.ok).toBe(true);
    expect(posts).toHaveLength(2);
  });

  it('fails a call with no attempt left instead of skipping it again while its route cools', async () => {
    const { runDir, posts } = open(() => cutStream('gen-cut'));
    expect((await queryModelResult(MODEL, MESSAGES)).skipped).toBe(true);
    // The same journal under a limit of one attempt: the call is spent.
    const again = open(() => finishedStream('gen-ok'), { runDir, retryLimit: 1 });
    for (const id of ['alpha/one']) session.cooldowns.set(id, Date.now() + 1_000_000);
    const result = await queryModelResult(MODEL, MESSAGES);
    expect(result.ok).toBe(false);
    expect(result.skipped).toBeFalsy();
    expect(result.error.kind).toBe('retries');
    expect(session.slots()[0].state).toBe('failed');
    expect(posts).toHaveLength(1);
    expect(again.posts).toHaveLength(0);
  });

  it('does not count a POST cut off by a stopped runner as an attempt', async () => {
    const first = open(() => finishedStream('gen-a'));
    expect((await queryModelResult(MODEL, MESSAGES)).ok).toBe(true);
    // The journal as it stood while that POST streamed: reserved, never closed.
    const events = journal(first.runDir);
    const closed = events.findIndex((event) => event.kind === 'http' && event.phase === 'finished');
    const dir = mkdtempSync(path.join(tmpdir(), 'a8-cut-'));
    dirs.push(dir);
    writeFileSync(path.join(dir, 'events.jsonl'), `${events.slice(0, closed).map((event) => JSON.stringify(event)).join('\n')}\n`, 'utf8');
    const second = open(() => finishedStream('gen-b'), { runDir: dir, retryLimit: 1 });
    const result = await queryModelResult(MODEL, MESSAGES);
    expect(result.ok).toBe(true);
    expect(second.posts).toHaveLength(1);
    expect(session.slots()[0]).toMatchObject({ state: 'completed', httpAttempts: 2, cutAttempts: 1 });
  });

  it('refuses an oversized prompt before any post', async () => {
    const { posts, budget } = open(() => finishedStream('gen-x'), { contextTokens: 1000 });
    const result = await queryModelResult(MODEL, MESSAGES);
    expect(result.ok).toBe(false);
    expect(result.error.kind).toBe('context');
    expect(posts).toHaveLength(0);
    expect(budget.state.posts).toBe(0);
    expect(session.slots()[0].state).toBe('failed');
  });
});

describe('reconciling an unresolved reserve', () => {
  it('applies the reported cost once and replays it from the journal', () => {
    const events = [];
    const budget = createCampaignBudget({ maxUsd: 10, maxPosts: 10, prices: PRICES, onEvent: (event) => events.push(event) });
    expect(budget.admit({ attemptId: 'k#1', model: MODEL, promptTokens: 100, maxTokens: 1000 }).ok).toBe(true);
    budget.settle({ attemptId: 'k#1', incomplete: true });
    const held = budget.state.unresolvedUsd;
    expect(held).toBeGreaterThan(0);
    expect(budget.resettle({ attemptId: 'k#1', cost: 0.0002, source: 'generation' }).applied).toBe(true);
    expect(budget.resettle({ attemptId: 'k#1', cost: 0.0002, source: 'generation' }).applied).toBe(false);
    expect(budget.state.unresolvedUsd).toBeCloseTo(0, 12);
    expect(budget.state.settledUsd).toBeCloseTo(0.0002, 12);
    expect(budget.state.posts).toBe(1);
    // A cost that is unknown never becomes zero.
    expect(budget.resettle({ attemptId: 'k#1', cost: null }).applied).toBe(false);
    const replayed = createCampaignBudget({ maxUsd: 10, maxPosts: 10, prices: PRICES });
    replayed.applyJournal([...events, ...events]);
    expect(replayed.state.settledUsd).toBeCloseTo(0.0002, 12);
    expect(replayed.state.unresolvedUsd).toBeCloseTo(0, 12);
    expect(replayed.state.posts).toBe(1);
  });

  it('does not touch a reserve whose cost was already known', () => {
    const budget = createCampaignBudget({ maxUsd: 10, maxPosts: 10, prices: PRICES });
    budget.admit({ attemptId: 'k#1', model: MODEL, promptTokens: 100, maxTokens: 1000 });
    budget.settle({ attemptId: 'k#1', usage: { prompt_tokens: 10, completion_tokens: 10, cost: 0.00002 } });
    const settled = budget.state.settledUsd;
    expect(budget.resettle({ attemptId: 'k#1', cost: 1 }).applied).toBe(false);
    expect(budget.state.settledUsd).toBe(settled);
  });

  it('reads the generation id from a stream body', () => {
    expect(generationIdFrom('data: {"id":"gen-17-x","choices":[]}\n\n')).toBe('gen-17-x');
    expect(generationIdFrom('{"error":{"message":"no"}}')).toBeNull();
  });
});
