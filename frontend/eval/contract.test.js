import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { canonicalCompletionRequest, queryModelResult, resetFreeQueueForTests } from '../src/engine/browser/openrouter.js';
import { rememberModelCooldown } from '../src/engine/browser/roster.js';
import { settings } from '../src/engine/browser/settings.js';
import { createBudget } from './budget.js';
import { gradeResponseLenient } from './grade.js';
import { runIsolated } from './questionScope.js';
import { costsFromJournal, isNetworkError, noteKeyUsage, spendFromJournal } from './run.js';
import { createSession, readSlotMap, slotKey, snapshotLocal } from './runtime.js';
import { attemptStore, installTransport } from './transport.js';
import { sha256, stableStringify } from './util.js';
import { runQuestion } from './variants.js';

const MODELS = [
  'alpha/a:free',
  'beta/b:free',
  'gamma/c:free',
  'delta/d:free',
  'epsilon/e:free',
];

const task = {
  id: 'contract-q',
  split: 'test',
  block: 'aime',
  dataset: 'aime',
  sourceId: 'q',
  kind: 'integer',
  stem: 'What is 3 + 4?',
  goldCanon: '7',
  choiceCount: 0,
};

function useFreeClock() {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'],
  });
}

function jsonBody(content, options = {}) {
  const payload = {
    choices: [{
      message: { content },
      finish_reason: options.finish || 'stop',
    }],
  };
  if (options.includeUsage !== false) {
    payload.usage = { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 };
  }
  return JSON.stringify(payload);
}

function asResponse(text, options = {}) {
  return new Response(text, {
    status: options.status || 200,
    headers: { 'content-type': options.contentType || 'application/json' },
  });
}

function stage2Answer(prompt) {
  const head = prompt.split('Your task:')[0];
  const labels = [...new Set([...head.matchAll(/Response (\d+)/g)].map((match) => `Response ${match[1]}`))];
  const reviews = labels.map((label, index) => (
    `${label}:\nReviewed.\nCorrectness: ${9 - index}/10\nIssues: none`
  ));
  const ranking = labels.map((label, index) => `${index + 1}. ${label}`).join('\n');
  return `${reviews.join('\n\n')}\n\nDISPUTED CLAIMS:\nnone\n\nFINAL RANKING:\n${ranking}`;
}

function defaultRespond(body) {
  const text = body.messages?.[0]?.content || '';
  if (text.includes('You are evaluating different responses')) {
    return asResponse(jsonBody(stage2Answer(text)));
  }
  if (text.includes('You are an adversarial reviewer')) {
    return asResponse(jsonBody('VERDICT: UPHELD\nCONFIDENCE: 4\nNo decisive error.'));
  }
  if (text.includes('You are the Chairman') || text.includes('You are aggregating independent answers')) {
    return asResponse(jsonBody('ANSWER: 7'));
  }
  return asResponse(jsonBody('Working.\nANSWER: 7'));
}

async function settle(promise) {
  let settled = null;
  const done = promise.then(
    (value) => { settled = { value }; },
    (error) => { settled = { error }; },
  );
  for (let step = 0; step < 240 && !settled; step += 1) {
    await vi.advanceTimersByTimeAsync(3000);
    await Promise.resolve();
  }
  await done;
  if (!settled) throw new Error('The logical call did not settle');
  if (settled.error) throw settled.error;
  return settled.value;
}

describe('eval contract', () => {
  let restore = () => {};
  let session = null;
  let runDir = '';

  beforeEach(() => {
    useFreeClock();
    resetFreeQueueForTests();
    settings.apiKey = 'sk-user-test';
    settings.councilModels = [...MODELS];
    settings.chairmanModel = MODELS[0];
    settings.redTeamModel = null;
    settings.nSamples = 1;
    settings.topK = 3;
    settings.selfExclusion = true;
  });

  afterEach(() => {
    session?.uninstall();
    restore();
    if (runDir) rmSync(runDir, { recursive: true, force: true });
    vi.useRealTimers();
  });

  function openHarness(respond, budgetOptions = {}) {
    runDir = mkdtempSync(path.join(tmpdir(), 'council-eval-'));
    const budget = createBudget({
      totalCap: 80,
      dailyLimit: 80,
      conservativeDaily: 80,
      ...budgetOptions,
    });
    session = createSession({ runDir, budget, log() {} });
    session.install();
    const posts = [];
    restore = installTransport({
      nativeFetch: async (url, init) => {
        const body = JSON.parse(init.body || '{}');
        const key = attemptStore.getStore()?.key || '';
        posts.push({
          url: String(url),
          model: body.model,
          content: body.messages?.[0]?.content || '',
          key,
          authorization: init.headers?.Authorization || init.headers?.authorization || null,
        });
        return respond(body, key, posts);
      },
      allowModels: new Set(MODELS),
      budget,
      onHttp: session.onHttp,
      onCooldown: session.onCooldown,
    });
    return { budget, posts };
  }

  function frozenCouncil() {
    return {
      councilModels: [...MODELS],
      chairmanModel: MODELS[0],
      bModel: MODELS[0],
    };
  }

  it('stores five identical requests as five sample slots and replays them', async () => {
    let calls = 0;
    const { posts } = openHarness(() => {
      calls += 1;
      return asResponse(jsonBody(`ANSWER: ${calls}`));
    });
    const messages = [{ role: 'user', content: 'Same prompt' }];
    for (let sample = 1; sample <= 5; sample += 1) {
      session.setContext({ questionId: 'q', branch: 'replicates', stage: 'sample', sample });
      await settle(queryModelResult(MODELS[0], messages));
    }
    const slots = session.slots().filter((slot) => slot.meta?.stage === 'sample');
    expect(slots).toHaveLength(5);
    expect(new Set(slots.map((slot) => slot.meta.requestHash)).size).toBe(1);
    expect(new Set(slots.map((slot) => slot.result.content)).size).toBe(5);
    expect(posts).toHaveLength(5);
    expect(readFileSync(path.join(runDir, 'events.jsonl'), 'utf8')).not.toContain('sk-user-test');

    session.uninstall();
    restore();
    const replay = createSession({ runDir, budget: createBudget({ dailyLimit: 80, conservativeDaily: 80 }), log() {} });
    replay.install();
    session = replay;
    posts.length = 0;
    session.onCooldown(MODELS[0], Date.now() + 60_000);
    for (let sample = 1; sample <= 5; sample += 1) {
      session.setContext({ questionId: 'q', branch: 'replicates', stage: 'sample', sample });
      const result = await settle(queryModelResult(MODELS[0], messages));
      expect(result.content).toBe(`ANSWER: ${sample}`);
    }
    expect(posts).toHaveLength(0);
  });

  it('keeps a failed first sample distinct from later samples of the same model', async () => {
    const { posts } = openHarness((body, key) => {
      if (key.includes('|council|stage1|1|') && key.includes(MODELS[0])) {
        return asResponse(JSON.stringify({ error: { message: 'down' } }), { status: 500 });
      }
      return defaultRespond(body);
    });
    const outcome = await settle(runQuestion(task, session, frozenCouncil(), snapshotLocal()));
    expect(outcome.status).toBe('complete');
    expect(outcome.arms.A1.correct).toBe(0);
    expect(posts.filter((post) => post.key.includes('|council|stage1|1|') && post.key.includes(MODELS[0]))).toHaveLength(1);
    expect(posts.some((post) => post.key.includes('|replicates|sample|2|'))).toBe(true);
  });

  it('does not let one replicate failure cool the model used by the council', async () => {
    const { posts } = openHarness((body, key) => {
      if (key.includes('|replicates|sample|4|')) {
        return asResponse(JSON.stringify({ error: { message: 'down' } }), { status: 500 });
      }
      return defaultRespond(body);
    });
    const outcome = await settle(runQuestion(task, session, frozenCouncil(), snapshotLocal()));
    expect(outcome.status).toBe('complete');
    expect(posts.some((post) => post.key.includes('|council|stage1|1|') && post.model === MODELS[0])).toBe(true);
    expect(posts.some((post) => post.key.includes('|A6|stage3|'))).toBe(true);
  });

  it('skips a cooling model without posting and still admits the others', async () => {
    const { posts, budget } = openHarness(defaultRespond);
    session.onCooldown(MODELS[1], Date.now() + 60_000);
    session.setContext({ questionId: 'q', branch: 'direct', stage: 'A0', sample: 1 });
    const cooled = await settle(queryModelResult(MODELS[1], [{ role: 'user', content: 'Hi' }]));
    expect(cooled.ok).toBe(false);
    expect(cooled.skipped).toBe(true);
    expect(posts).toHaveLength(0);
    expect(budget.state.paused).toBe(false);
    session.setContext({ questionId: 'q', branch: 'direct', stage: 'A0', sample: 2 });
    const other = await settle(queryModelResult(MODELS[0], [{ role: 'user', content: 'Hi' }]));
    expect(other.ok).toBe(true);
    expect(posts).toHaveLength(1);
  });

  it('skips Stage 2 and the chairman when Stage 1 produces nothing', async () => {
    const { posts } = openHarness((body, key) => {
      if (key.includes('|council|stage1|')) {
        return asResponse(JSON.stringify({ error: { message: 'down' } }), { status: 500 });
      }
      return defaultRespond(body);
    });
    const outcome = await settle(runQuestion(task, session, frozenCouncil(), snapshotLocal()));
    expect(outcome.status).toBe('complete');
    expect(outcome.arms.A6.status).toBe('not_run');
    expect(posts.some((post) => post.content.includes('You are evaluating different responses'))).toBe(false);
    expect(posts.some((post) => post.content.includes('You are the Chairman'))).toBe(false);
  });

  it('skips synthesis when every Stage 2 judge fails', async () => {
    const { posts } = openHarness((body) => {
      const text = body.messages?.[0]?.content || '';
      if (text.includes('You are evaluating different responses')) {
        return asResponse(JSON.stringify({ error: { message: 'down' } }), { status: 500 });
      }
      return defaultRespond(body);
    });
    const outcome = await settle(runQuestion(task, session, frozenCouncil(), snapshotLocal()));
    expect(outcome.arms.A5.status).toBe('not_run');
    expect(outcome.arms.A7.status).toBe('not_run');
    expect(posts.some((post) => post.content.includes('You are the Chairman'))).toBe(false);
  });

  it('keeps an unparseable ranking and still calls the chairman', async () => {
    const { posts } = openHarness((body) => {
      const text = body.messages?.[0]?.content || '';
      if (text.includes('You are evaluating different responses')) return asResponse(jsonBody('No ranking.'));
      return defaultRespond(body);
    });
    const outcome = await settle(runQuestion(task, session, frozenCouncil(), snapshotLocal()));
    expect(outcome.rankingFallback).toBe(true);
    expect(posts.some((post) => post.content.includes('You are the Chairman'))).toBe(true);
  });

  it('describes the unavailable red team in A7 and does not inherit a local cooldown', async () => {
    const { posts } = openHarness((body) => {
      const text = body.messages?.[0]?.content || '';
      if (text.includes('You are an adversarial reviewer')) {
        rememberModelCooldown(MODELS[0], 600);
        return asResponse(jsonBody('VERDICT: REFUTED\nCONFIDENCE: 9\nThe sum is wrong.'));
      }
      return defaultRespond(body);
    });
    const outcome = await settle(runQuestion(task, session, frozenCouncil(), snapshotLocal()));
    expect(outcome.a7Metadata.redTeam).toBeNull();
    expect(outcome.a7Metadata.verdict).toBeNull();
    expect(outcome.a7Metadata.reasons.join('\n')).toContain('Red-team review was unavailable');
    const a7 = posts.find((post) => post.key.includes('|A7|stage3|'));
    expect(a7.content).toContain('Red-team review was unavailable.');
    expect(a7.content).not.toContain('Red-team critique:');
    expect(outcome.a6Model).not.toBe(MODELS[0]);
    expect(outcome.a7Model).toBe(MODELS[0]);
    expect(outcome.arms.A6.fallback).toBe(true);
    expect(outcome.arms.A7.fallback).toBe(false);
  });

  it('does not finalize A6 when the red team hits the pause', async () => {
    const { posts, budget } = openHarness((body) => {
      const text = body.messages?.[0]?.content || '';
      if (text.includes('You are an adversarial reviewer')) {
        budget.pause('platform_day', Date.now() + 86_400_000);
        return asResponse(JSON.stringify({ error: { message: 'stopped' } }), { status: 500 });
      }
      return defaultRespond(body);
    });
    const outcome = await settle(runQuestion(task, session, frozenCouncil(), snapshotLocal()));
    expect(outcome.status).toBe('paused');
    expect(outcome.pending).toBe(true);
    expect(outcome.arms).toBeUndefined();
    expect(posts.some((post) => post.key.includes('|A6|stage3|'))).toBe(false);
  });

  it('keeps a network failure unknown and counts the resumed call as another attempt', async () => {
    useFreeClock();
    let tries = 0;
    const { budget, posts } = openHarness(() => {
      tries += 1;
      if (tries === 1) throw new TypeError('fetch failed');
      return asResponse(jsonBody('ANSWER: 7'));
    });
    session.setContext({ questionId: 'q', branch: 'direct', stage: 'A0', sample: 1 });
    const messages = [{ role: 'user', content: 'Hi' }];
    const failed = await settle(queryModelResult(MODELS[0], messages));
    expect(failed.ok).toBe(false);
    expect(session.slots()[0].state).toBe('unknown');
    expect(budget.state.pauseReason).toBe('network');
    expect(posts).toHaveLength(1);
    budget.state.paused = false;
    budget.state.pauseReason = null;
    budget.state.resumeAfter = null;
    const again = await settle(queryModelResult(MODELS[0], messages));
    expect(again.ok).toBe(true);
    expect(posts).toHaveLength(2);
    expect(session.slots()[0].state).toBe('completed');
    expect(session.slots()[0].httpAttempts).toBe(2);
  });

  it('reuses a completed free slot for the paid alias and re-executes a failed one', async () => {
    const messages = [{ role: 'user', content: 'Hi' }];
    const sourceModel = MODELS[0];
    const paidModel = 'alpha/a';
    const requestHash = sha256(stableStringify(canonicalCompletionRequest(sourceModel, messages, {})));
    const sourceFor = (questionId) => slotKey({
      questionId, branch: 'direct', stage: 'A0', sample: 1, model: sourceModel, requestHash,
    });
    const replayFrom = new Map([
      [sourceFor('q-ok'), { state: 'completed', result: { ok: true, content: 'ANSWER: 7' } }],
      [sourceFor('q-bad'), { state: 'failed', result: { ok: false, error: { message: 'total' } } }],
      [sourceFor('q-free'), { state: 'skipped', result: { ok: false, skipped: true } }],
    ]);
    runDir = mkdtempSync(path.join(tmpdir(), 'council-eval-'));
    const budget = createBudget({ dailyLimit: 20, conservativeDaily: 20, totalCap: 20 });
    session = createSession({
      runDir,
      budget,
      log() {},
      replayFrom,
      aliasOf: (model) => (model === paidModel ? sourceModel : model),
    });
    session.install();
    const posts = [];
    restore = installTransport({
      nativeFetch: async (_url, init) => {
        posts.push(JSON.parse(init.body || '{}'));
        return asResponse(jsonBody('ANSWER: 7'));
      },
      allowModels: new Set([sourceModel, paidModel]),
      allowPaid: true,
      budget,
      onHttp: session.onHttp,
      onCooldown: session.onCooldown,
    });
    session.setContext({ questionId: 'q-ok', branch: 'direct', stage: 'A0', sample: 1 });
    const reused = await settle(queryModelResult(paidModel, messages));
    expect(reused.content).toBe('ANSWER: 7');
    expect(posts).toHaveLength(0);
    expect(session.slots().find((slot) => slot.meta?.questionId === 'q-ok').reusedFrom).toBe(sourceFor('q-ok'));

    session.setContext({ questionId: 'q-bad', branch: 'direct', stage: 'A0', sample: 1 });
    const live = await settle(queryModelResult(paidModel, messages));
    expect(live.ok).toBe(true);
    expect(posts).toHaveLength(1);
    expect(posts[0].model).toBe(paidModel);

    session.setContext({ questionId: 'q-free', branch: 'direct', stage: 'A0', sample: 1 });
    await settle(queryModelResult(sourceModel, messages));
    expect(posts).toHaveLength(2);
    expect(posts[1].model).toBe(sourceModel);

    session.setContext({ questionId: 'q-block', branch: 'direct', stage: 'A0', sample: 1 });
    const blocked = await settle(queryModelResult('openai/gpt-4.1', messages));
    expect(blocked.ok).toBe(false);
    expect(blocked.error.message).toMatch(/Blocked model/);
    expect(posts).toHaveLength(2);
  });

  it('rejects a paid model before the network and stops after a harness 403', async () => {
    const { posts } = openHarness((body, key) => {
      if (key.includes(MODELS[4]) && key.includes('|council|stage1|')) {
        return asResponse(JSON.stringify({
          error: { message: `${MODELS[4]} is only available on agentic harnesses.` },
        }), { status: 403 });
      }
      return defaultRespond(body);
    });
    session.setContext({ questionId: 'q', branch: 'direct', stage: 'A0', sample: 1 });
    const blocked = await settle(queryModelResult('openai/gpt-4.1', [{ role: 'user', content: 'Hi' }]));
    expect(blocked.ok).toBe(false);
    expect(blocked.error.message).toMatch(/Blocked model/);
    expect(posts).toHaveLength(0);
    const outcome = await settle(runQuestion(task, session, frozenCouncil(), snapshotLocal()));
    expect(outcome.status).toBe('stopped');
    expect(settings.councilModels).not.toContain(MODELS[4]);
    expect(posts.some((post) => post.content.includes('You are the Chairman'))).toBe(false);
  });

  it('records an HTTP 200 stream error as a failure without a known cost', async () => {
    openHarness(() => asResponse(
      'data: {"error":{"message":"boom"}}\n\n',
      { contentType: 'text/event-stream' },
    ));
    session.setContext({ questionId: 'q', branch: 'direct', stage: 'A0', sample: 1 });
    const failed = await settle(queryModelResult(MODELS[2], [{ role: 'user', content: 'Hi' }]));
    expect(failed.ok).toBe(false);
    expect(session.slots()[0].usageKnown).toBe(false);
    expect(costsFromJournal(runDir).usageUnknown).toBeGreaterThan(0);
  });

  it('records a stream that never reaches DONE as truncated', async () => {
    openHarness(() => asResponse(
      'data: {"choices":[{"delta":{"content":"ANSWER: 7"}}]}\n\n',
      { contentType: 'text/event-stream' },
    ));
    session.setContext({ questionId: 'q', branch: 'direct', stage: 'A0', sample: 1 });
    const truncated = await settle(queryModelResult(MODELS[2], [{ role: 'user', content: 'Hi' }]));
    expect(truncated.ok).toBe(false);
    expect(session.slots().some((slot) => slot.incompleteHttp)).toBe(true);
  });

  it('grades a completion whose usage block is missing without treating it as zero cost', async () => {
    openHarness(() => asResponse(jsonBody('ANSWER: 7', { includeUsage: false })));
    session.setContext({ questionId: 'q', branch: 'direct', stage: 'A0', sample: 1 });
    const result = await settle(queryModelResult(MODELS[0], [{ role: 'user', content: 'Hi\nANSWER: 7' }]));
    expect(result.ok).toBe(true);
    expect(result.content).toContain('ANSWER: 7');
    const slot = session.slots()[0];
    expect(slot.usageKnown).toBe(false);
    const costs = costsFromJournal(runDir);
    expect(costs.usageUnknown).toBeGreaterThan(0);
    expect(costs.usageKnown).toBe(0);
  });

  it('pauses at the daily cap and resumes completed slots without another post', async () => {
    const messages = [{ role: 'user', content: 'Hi' }];
    const { budget, posts } = openHarness(defaultRespond, { dailyLimit: 2, conservativeDaily: 2, totalCap: 30 });
    for (let sample = 1; sample <= 2; sample += 1) {
      session.setContext({ questionId: 'q', branch: 'replicates', stage: 'sample', sample });
      await settle(queryModelResult(MODELS[0], messages));
    }
    session.setContext({ questionId: 'q', branch: 'replicates', stage: 'sample', sample: 3 });
    const paused = await settle(queryModelResult(MODELS[0], messages));
    expect(paused.ok).toBe(false);
    expect(posts).toHaveLength(2);
    const done = session.slots().filter((slot) => slot.state === 'completed');
    expect(done).toHaveLength(2);
    expect(session.slots().some((slot) => slot.state === 'pending')).toBe(true);
    session.uninstall();
    restore();
    budget.state.dailyLimit = 80;
    budget.state.conservativeDaily = 80;
    budget.state.paused = false;
    budget.state.pauseReason = null;
    budget.state.attemptedToday = 0;
    const resumed = createSession({ runDir, budget, log() {} });
    resumed.install();
    session = resumed;
    const postsAfter = [];
    restore = installTransport({
      nativeFetch: async (_url, init) => {
        const body = JSON.parse(init.body || '{}');
        postsAfter.push(attemptStore.getStore()?.key || '');
        return defaultRespond(body);
      },
      allowModels: new Set(MODELS),
      budget,
      onHttp: session.onHttp,
      onCooldown: session.onCooldown,
    });
    for (let sample = 1; sample <= 2; sample += 1) {
      session.setContext({ questionId: 'q', branch: 'replicates', stage: 'sample', sample });
      const result = await settle(queryModelResult(MODELS[0], messages));
      expect(result.ok).toBe(true);
    }
    expect(postsAfter).toHaveLength(0);
  });

  it('keeps concurrent questions on their own council and slot keys', async () => {
    const seen = [];
    openHarness((body) => {
      seen.push({
        council: settings.councilModels[0],
        chairman: settings.chairmanModel,
        key: attemptStore.getStore()?.key || '',
      });
      return defaultRespond(body);
    });
    const councilA = [...MODELS];
    const councilB = [MODELS[1], MODELS[0], MODELS[2], MODELS[3], MODELS[4]];
    function snapFor(council, chairman) {
      settings.councilModels = council;
      settings.chairmanModel = chairman;
      settings.redTeamModel = null;
      settings.nSamples = 1;
      settings.topK = 3;
      settings.selfExclusion = true;
      settings.apiKey = 'sk-user-test';
      return snapshotLocal();
    }
    const snapA = snapFor(councilA, MODELS[0]);
    const snapB = snapFor(councilB, MODELS[1]);
    const taskA = { ...task, id: 'contract-a' };
    const taskB = { ...task, id: 'contract-b' };
    const frozenA = { councilModels: councilA, chairmanModel: MODELS[0], bModel: MODELS[0] };
    const frozenB = { councilModels: councilB, chairmanModel: MODELS[1], bModel: MODELS[1] };
    const [outA, outB] = await settle(Promise.all([
      runIsolated(snapA, 0, () => runQuestion(taskA, session, frozenA, snapA)),
      runIsolated(snapB, 1, () => runQuestion(taskB, session, frozenB, snapB)),
    ]));
    expect(outA.status).toBe('complete');
    expect(outB.status).toBe('complete');
    expect(settings.councilModels[0]).toBe(MODELS[1]);
    expect(settings.chairmanModel).toBe(MODELS[1]);
    const rowsA = seen.filter((row) => row.key.includes('contract-a|'));
    const rowsB = seen.filter((row) => row.key.includes('contract-b|'));
    expect(rowsA.length).toBeGreaterThan(0);
    expect(rowsB.length).toBeGreaterThan(0);
    expect(rowsA.every((row) => row.council === MODELS[0] && row.chairman === MODELS[0])).toBe(true);
    expect(rowsB.every((row) => row.council === MODELS[1] && row.chairman === MODELS[1])).toBe(true);
    const slots = readFileSync(path.join(runDir, 'events.jsonl'), 'utf8')
      .split(/\n/)
      .filter((line) => line.includes('"kind":"slot"'))
      .map((line) => JSON.parse(line));
    const slotA = slots.filter((event) => event.slot?.meta?.questionId === 'contract-a');
    const slotB = slots.filter((event) => event.slot?.meta?.questionId === 'contract-b');
    expect(slotA.length).toBeGreaterThan(0);
    expect(slotB.length).toBeGreaterThan(0);
    expect(slotA.every((event) => event.key.startsWith('contract-a|'))).toBe(true);
    expect(slotB.every((event) => event.key.startsWith('contract-b|'))).toBe(true);
  });

  it('rebuilds repair spend from the journal, charging calls left open by a kill', () => {
    runDir = mkdtempSync(path.join(tmpdir(), 'council-eval-'));
    const http = (event) => JSON.stringify({ kind: 'http', ...event });
    const lines = [
      http({ phase: 'reserved', key: 'a', model: 'paid/p', body: { max_tokens: 100 } }),
      http({ phase: 'finished', key: 'a', model: 'paid/p', usageKnown: true, usage: { prompt_tokens: 4, completion_tokens: 3 } }),
      http({ phase: 'reserved', key: 'b', model: 'paid/p', body: { max_tokens: 100 } }),
      http({ phase: 'finished', key: 'b', model: 'paid/p', usageKnown: false, usage: null }),
      http({ phase: 'reserved', key: 'c', model: 'paid/p', body: { max_tokens: 100 } }),
      http({ phase: 'error', key: 'c', model: 'paid/p', error: 'fetch failed' }),
      http({ phase: 'reserved', key: 'd', model: 'paid/p-reasoning-high', body: { max_tokens: 50 } }),
      JSON.stringify({ kind: 'slot', key: 'a', slot: { state: 'completed' } }),
    ];
    const file = path.join(runDir, 'events.jsonl');
    writeFileSync(file, `${lines.join('\n')}\n`, 'utf8');
    const spent = spendFromJournal(file, { 'paid/p': { prompt: 0.001, completion: 0.01 } });
    expect(spent.posts).toBe(4);
    expect(spent.unknown).toBe(2);
    expect(spent.usd).toBeCloseTo(4 * 0.001 + 3 * 0.01 + 100 * 0.01 + 50 * 0.01, 10);
  });

  it('carries spend from a replaced paid key into the total', () => {
    const state = {};
    noteKeyUsage(state, 'old', 0);
    noteKeyUsage(state, 'old', 14.5);
    noteKeyUsage(state, 'new', 0);
    noteKeyUsage(state, 'new', 2);
    expect(state.priorKeySpend).toBeCloseTo(14.5, 10);
    expect(state.priorKeySpend + state.keyUsageLast - state.keyUsageAtStart).toBeCloseTo(16.5, 10);
  });

  it('treats a startup DNS failure as a network pause, not a protocol error', () => {
    const dns = new TypeError('fetch failed', { cause: Object.assign(new Error('getaddrinfo ENOTFOUND openrouter.ai'), { code: 'ENOTFOUND' }) });
    expect(isNetworkError(dns)).toBe(true);
    expect(isNetworkError(new Error('OpenRouter /api/v1/key HTTP 401'))).toBe(false);
  });

  it('keeps attempt 0 keys unchanged and suffixes later draws', () => {
    const base = {
      questionId: 'q',
      branch: 'council',
      stage: 'stage1',
      sample: 1,
      model: MODELS[0],
      requestHash: 'abc',
    };
    expect(slotKey(base)).toBe('q|council|stage1|1|alpha/a:free|abc');
    expect(slotKey({ ...base, attempt: 0 })).toBe(slotKey(base));
    expect(slotKey({ ...base, attempt: 2 })).toBe(`${slotKey(base)}|a2`);
  });

  it('replays a failed source slot when the layer asks for every terminal result', async () => {
    const messages = [{ role: 'user', content: 'Hi' }];
    const requestHash = sha256(stableStringify(canonicalCompletionRequest(MODELS[0], messages, {})));
    const sourceKey = slotKey({
      questionId: 'q-bad', branch: 'direct', stage: 'A0', sample: 1, model: MODELS[0], requestHash,
    });
    const replayFrom = new Map([
      [sourceKey, { state: 'failed', result: { ok: false, error: { message: 'down' } } }],
    ]);
    runDir = mkdtempSync(path.join(tmpdir(), 'council-eval-'));
    const budget = createBudget({ dailyLimit: 20, conservativeDaily: 20, totalCap: 20 });
    session = createSession({
      runDir,
      budget,
      log() {},
      replayFrom,
      aliasOf: (model) => model,
      replayTerminal: true,
    });
    session.install();
    const posts = [];
    restore = installTransport({
      nativeFetch: async (_url, init) => {
        posts.push(JSON.parse(init.body || '{}'));
        return asResponse(jsonBody('ANSWER: 7'));
      },
      allowModels: new Set(MODELS),
      budget,
      onHttp: session.onHttp,
      onCooldown: session.onCooldown,
    });
    session.setContext({ questionId: 'q-bad', branch: 'direct', stage: 'A0', sample: 1 });
    const replayed = await settle(queryModelResult(MODELS[0], messages));
    expect(replayed.ok).toBe(false);
    expect(posts).toHaveLength(0);
    const slot = session.slots().find((item) => item.meta?.questionId === 'q-bad');
    expect(slot.state).toBe('failed');
    expect(slot.reusedFrom).toBe(sourceKey);

    session.setContext({ questionId: 'q-bad', branch: 'direct', stage: 'A0', sample: 1, attempt: 1 });
    const redraw = await settle(queryModelResult(MODELS[0], messages));
    expect(redraw.ok).toBe(true);
    expect(posts).toHaveLength(1);
    expect(session.slots().some((item) => item.key?.endsWith('|a1'))).toBe(true);
  });

  it('calls a cooled redraw again after the cooldown instead of keeping the skip', async () => {
    const messages = [{ role: 'user', content: 'Hi' }];
    const { posts } = openHarness(() => asResponse(jsonBody('ANSWER: 7')));
    session.cooldowns.set(MODELS[0], Date.now() + 60_000);
    session.setContext({ questionId: 'q', branch: 'direct', stage: 'A0', sample: 1, attempt: 1 });
    const skipped = await settle(queryModelResult(MODELS[0], messages));
    expect(skipped.skipped).toBe(true);
    expect(posts).toHaveLength(0);
    session.cooldowns.set(MODELS[0], 0);
    const again = await settle(queryModelResult(MODELS[0], messages));
    expect(again.ok).toBe(true);
    expect(posts).toHaveLength(1);
    expect(session.slots().find((slot) => (slot.key || '').endsWith('|a1')).state).toBe('completed');
  });

  it('reads a bold answer line without a new draw', async () => {
    const { posts } = openHarness((body) => {
      const text = body.messages?.[0]?.content || '';
      if (
        text.includes('You are evaluating different responses')
        || text.includes('You are an adversarial reviewer')
        || text.includes('You are the Chairman')
        || text.includes('You are aggregating independent answers')
      ) {
        return defaultRespond(body);
      }
      return asResponse(jsonBody('**ANSWER: 7**'));
    });
    const outcome = await settle(runQuestion(task, session, frozenCouncil(), snapshotLocal(), {
      grader: gradeResponseLenient,
      attempts: 2,
    }));
    expect(outcome.status).toBe('complete');
    expect(outcome.arms.A1).toMatchObject({ correct: 1, lenient: true, via: 'answer_line' });
    expect(outcome.exhaustedCells).toBe(0);
    expect(outcome.resamplePosts).toBe(0);
    expect(posts.some((post) => /\|a\d/.test(post.key))).toBe(false);
  });

  it('finishes when a cooling model already has an answer', async () => {
    openHarness(defaultRespond);
    const first = await settle(runQuestion(task, session, frozenCouncil(), snapshotLocal()));
    expect(first.status).toBe('complete');
    const source = readSlotMap(path.join(runDir, 'events.jsonl'));
    const firstDir = runDir;
    session.uninstall();
    restore();
    resetFreeQueueForTests();
    try {
      runDir = mkdtempSync(path.join(tmpdir(), 'council-eval-'));
      const budget = createBudget({ dailyLimit: 80, conservativeDaily: 80, totalCap: 80 });
      session = createSession({
        runDir,
        budget,
        log() {},
        replayFrom: source,
        aliasOf: (model) => model,
        replayTerminal: true,
      });
      session.install();
      session.cooldowns.set(MODELS[4], Date.now() + 60_000);
      const redraws = [];
      restore = installTransport({
        nativeFetch: async (_url, init) => {
          redraws.push(JSON.parse(init.body || '{}').model);
          return defaultRespond(JSON.parse(init.body || '{}'));
        },
        allowModels: new Set(MODELS),
        budget,
        onHttp: session.onHttp,
        onCooldown: session.onCooldown,
      });
      const outcome = await settle(runQuestion(task, session, frozenCouncil(), snapshotLocal(), {
        grader: gradeResponseLenient,
        attempts: 2,
      }));
      expect(outcome.status).toBe('complete');
      expect(redraws).toHaveLength(0);
    } finally {
      rmSync(firstDir, { recursive: true, force: true });
    }
  });

  it('defers a missing answer while that model is cooling and does not post', async () => {
    const respond = (body, key) => {
      if (key.includes(MODELS[4]) && key.includes('|stage1|')) return asResponse(jsonBody('still thinking'));
      return defaultRespond(body);
    };
    openHarness(respond);
    const first = await settle(runQuestion(task, session, frozenCouncil(), snapshotLocal()));
    expect(first.status).toBe('complete');
    const source = readSlotMap(path.join(runDir, 'events.jsonl'));
    const firstDir = runDir;
    session.uninstall();
    restore();
    resetFreeQueueForTests();
    try {
      runDir = mkdtempSync(path.join(tmpdir(), 'council-eval-'));
      const budget = createBudget({ dailyLimit: 80, conservativeDaily: 80, totalCap: 80 });
      session = createSession({
        runDir,
        budget,
        log() {},
        replayFrom: source,
        aliasOf: (model) => model,
        replayTerminal: true,
      });
      session.install();
      session.cooldowns.set(MODELS[4], Date.now() + 60_000);
      const redraws = [];
      restore = installTransport({
        nativeFetch: async (_url, init) => {
          redraws.push(attemptStore.getStore()?.key || '');
          return asResponse(jsonBody('ANSWER: 7'));
        },
        allowModels: new Set(MODELS),
        budget,
        onHttp: session.onHttp,
        onCooldown: session.onCooldown,
      });
      const outcome = await settle(runQuestion(task, session, frozenCouncil(), snapshotLocal(), {
        grader: gradeResponseLenient,
        attempts: 2,
      }));
      expect(outcome.status).toBe('paused');
      expect(outcome.reason).toBe('cooldown');
      expect(redraws).toHaveLength(0);
    } finally {
      rmSync(firstDir, { recursive: true, force: true });
    }
  });

  it('redraws only the cell with no answer and replays Stage 2 and Stage 3', async () => {
    const respond = (body, key) => {
      if (/\|a\d/.test(key)) return asResponse(jsonBody('ANSWER: 7'));
      if (key.includes(MODELS[4]) && key.includes('|stage1|')) return asResponse(jsonBody('still thinking'));
      return defaultRespond(body);
    };
    openHarness(respond);
    const first = await settle(runQuestion(task, session, frozenCouncil(), snapshotLocal()));
    expect(first.status).toBe('complete');
    expect(first.arms.A1.correct).toBe(1);
    const source = readSlotMap(path.join(runDir, 'events.jsonl'));
    const firstDir = runDir;
    session.uninstall();
    restore();
    resetFreeQueueForTests();
    try {
      runDir = mkdtempSync(path.join(tmpdir(), 'council-eval-'));
      const budget = createBudget({ dailyLimit: 80, conservativeDaily: 80, totalCap: 80 });
      session = createSession({
        runDir,
        budget,
        log() {},
        replayFrom: source,
        aliasOf: (model) => model,
        replayTerminal: true,
      });
      session.install();
      const redraws = [];
      restore = installTransport({
        nativeFetch: async (_url, init) => {
          const body = JSON.parse(init.body || '{}');
          const key = attemptStore.getStore()?.key || '';
          redraws.push({ key, model: body.model });
          return respond(body, key);
        },
        allowModels: new Set(MODELS),
        budget,
        onHttp: session.onHttp,
        onCooldown: session.onCooldown,
      });
      const outcome = await settle(runQuestion(task, session, frozenCouncil(), snapshotLocal(), {
        grader: gradeResponseLenient,
        attempts: 2,
      }));
      expect(outcome.status).toBe('complete');
      expect(outcome.resampledCells).toBe(1);
      expect(outcome.exhaustedCells).toBe(0);
      expect(redraws).toHaveLength(1);
      expect(redraws[0].key).toContain('|a1');
      expect(redraws[0].key).toContain(MODELS[4]);
      expect(redraws.some((post) => /\|(stage2|stage3|redteam|selfmoa)\|/.test(post.key))).toBe(false);
      const replayed = session.slots().filter((slot) => slot.meta?.stage === 'stage2' || slot.meta?.stage === 'stage3');
      expect(replayed.length).toBeGreaterThan(0);
      expect(replayed.every((slot) => slot.reusedFrom)).toBe(true);
      const again = await settle(runQuestion(task, session, frozenCouncil(), snapshotLocal(), {
        grader: gradeResponseLenient,
        attempts: 2,
      }));
      expect(again.status).toBe('complete');
      expect(redraws).toHaveLength(1);
    } finally {
      rmSync(firstDir, { recursive: true, force: true });
    }
  });

  it('scores a cell wrong after the last draw still has no answer', async () => {
    openHarness((body, key) => {
      if (key.includes(MODELS[4]) && (key.includes('|stage1|') || /\|a\d/.test(key))) {
        return asResponse(jsonBody('still thinking'));
      }
      return defaultRespond(body);
    });
    const outcome = await settle(runQuestion(task, session, frozenCouncil(), snapshotLocal(), {
      grader: gradeResponseLenient,
      attempts: 1,
    }));
    expect(outcome.status).toBe('complete');
    expect(outcome.exhaustedCells).toBe(1);
    expect(outcome.resamplePosts).toBe(1);
    const keys = session.slots().map((slot) => slot.key || '');
    expect(keys.some((key) => key.includes(MODELS[4]) && key.endsWith('|a1'))).toBe(true);
    expect(keys.some((key) => key.endsWith('|a2'))).toBe(false);
  });

  it('counts a retry as another reserved post', async () => {
    let tries = 0;
    const { budget } = openHarness(() => {
      tries += 1;
      if (tries === 1) {
        return asResponse(JSON.stringify({ error: { message: 'busy' } }), { status: 429 });
      }
      return asResponse(jsonBody('ANSWER: 7'));
    });
    session.setContext({ questionId: 'q', branch: 'direct', stage: 'A0', sample: 1 });
    const result = await settle(queryModelResult(MODELS[3], [{ role: 'user', content: 'Hi' }]));
    expect(result.ok).toBe(true);
    expect(budget.state.attempted).toBe(2);
  });
});
