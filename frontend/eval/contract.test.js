import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { queryModelResult, resetFreeQueueForTests } from '../src/engine/browser/openrouter.js';
import { rememberModelCooldown } from '../src/engine/browser/roster.js';
import { settings } from '../src/engine/browser/settings.js';
import { createBudget } from './budget.js';
import { costsFromJournal } from './run.js';
import { createSession, snapshotLocal } from './runtime.js';
import { attemptStore, installTransport } from './transport.js';
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
