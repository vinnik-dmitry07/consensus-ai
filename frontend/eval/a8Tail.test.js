import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { settings } from '../src/engine/browser/settings.js';
import { TAIL_RULE } from './a8Profile.js';
import { cutReasoning, forwardText, runComparison } from './a8Variants.js';
import { createCampaignBudget } from './budget.js';
import { runIsolated } from './questionScope.js';
import { createSession, snapshotLocal } from './runtime.js';
import { attemptStore, installTransport } from './transport.js';
import { COUNCIL, FROZEN, PRICES, stage2Answer } from './a8TestFixtures.js';
const TASK = { id: 'test:arxiv:tail', split: 'test', block: 'arxiv', stem: 'What is 3/4 + 0?', kind: 'number', goldCanon: '3/4', choiceCount: 0 };

const HEAD_SENTINEL = 'HEAD-OF-REASONING-SHOULD-NOT-PASS';
const JUDGE_SENTINEL = 'EARLY-JUDGE-ISSUE-SHOULD-NOT-PASS';

function filler(length, seed) {
  const words = ['basis', 'orbit', 'prime', 'kernel', 'lemma', 'graph', 'torus', 'ring'];
  let state = seed;
  const out = [];
  let size = 0;
  while (size < length) {
    state = (state * 1103515245 + 12345) % 2147483648;
    const word = `${words[state % words.length]}${state % 997}`;
    out.push(word);
    size += word.length + 1;
  }
  return out.join(' ').slice(0, length);
}

// A cut call: no visible content, the reasoning only, finish_reason length.
function cut(reasoning) {
  return new Response(JSON.stringify({
    id: 'gen-cut',
    choices: [{ message: { content: '', reasoning }, finish_reason: 'length' }],
    usage: { prompt_tokens: 10, completion_tokens: 32768, total_tokens: 32778, cost: 0.01 },
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

function done(content) {
  return new Response(JSON.stringify({
    id: 'gen-done',
    choices: [{ message: { content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30, cost: 0.0001 },
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

describe('tail rule', () => {
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

  function open(respond) {
    const runDir = mkdtempSync(path.join(tmpdir(), 'a8-tail-'));
    dirs.push(runDir);
    const budget = createCampaignBudget({ maxUsd: 10, maxPosts: 100, prices: PRICES });
    session = createSession({
      runDir,
      budget,
      log() {},
      retryLimit: 2,
      retainRoster: true,
      maxInFlight: 7,
      maxInFlightPerModel: 7,
      prepareOptions: (model, stage, options) => ({
        ...options,
        maxTokens: 32768,
        provider: { order: ['host'], allow_fallbacks: false },
        evalAnnotations: true,
      }),
    });
    session.install();
    const posts = [];
    restore = installTransport({
      nativeFetch: async (_url, init) => {
        const body = JSON.parse(init.body || '{}');
        posts.push({ model: body.model, text: body.messages?.[0]?.content || '', key: attemptStore.getStore()?.key || '' });
        return respond(body);
      },
      allowModels: new Set(COUNCIL),
      allowPaid: true,
      rejectFree: true,
      budget,
      onHttp: session.onHttp,
      onCooldown: session.onCooldown,
    });
    return posts;
  }

  it('passes a cut answer on as its marked tail and scores the full text', async () => {
    const longAnswer = `${HEAD_SENTINEL} ${filler(30000, 5)} the last thought`;
    const longJudge = `Response 1:\nIssues: ${JUDGE_SENTINEL}\n${filler(30000, 9)}\nResponse 2:\nCorrectness: 4/10\nIssues: late issue\nFINAL RANKING:\n1. Response 2\n2. Response 1`;
    const posts = open((body) => {
      const text = body.messages?.[0]?.content || '';
      if (text.includes('You are evaluating different responses')) {
        if (body.model === 'beta/two') return cut(longJudge);
        return done(stage2Answer(text));
      }
      if (text.includes('You are the Chairman') || text.includes('You are aggregating')) return done('ANSWER: 3/4');
      if (body.model === 'gamma/three') return cut(longAnswer);
      return done(`${body.model} works.\nANSWER: 3/4`);
    });
    const outcome = await runIsolated(snapshotLocal(), 0, () => runComparison(TASK, session, FROZEN, { tailRule: TAIL_RULE }));
    expect(outcome.status).toBe('complete');
    expect(outcome.tailApplied).toEqual({ stage1: 1, samples: 0, stage2: 1 });

    const judgePrompts = posts.filter((post) => post.text.includes('You are evaluating different responses'));
    const sawGamma = judgePrompts.filter((post) => post.text.includes('the last thought'));
    expect(sawGamma.length).toBeGreaterThan(0);
    for (const post of judgePrompts) {
      expect(post.text.includes(HEAD_SENTINEL)).toBe(false);
      if (post.text.includes('the last thought')) expect(post.text).toContain(TAIL_RULE.marker);
    }
    const chairman = posts.find((post) => post.text.includes('You are the Chairman'));
    expect(chairman.text.includes(HEAD_SENTINEL)).toBe(false);
    expect(chairman.text.includes(JUDGE_SENTINEL)).toBe(false);
    // Grading reads the stored full text: the cut answer has no ANSWER line.
    expect(outcome.diagnostics.councilAnswers).toEqual(['3/4', '3/4', null]);
    expect(outcome.arms.P8.extracted).toBe('3/4');
  });

  it('applies the same rule to a cut B sample on its way into S8', async () => {
    const longSample = `${HEAD_SENTINEL} ${filler(30000, 7)} sample end`;
    let samplesSeen = 0;
    const posts = open((body) => {
      const text = body.messages?.[0]?.content || '';
      if (text.includes('You are evaluating different responses')) return done(stage2Answer(text));
      if (text.includes('You are the Chairman') || text.includes('You are aggregating')) return done('ANSWER: 3/4');
      if (body.model === 'alpha/one' && text.startsWith('Answer the question.')) {
        samplesSeen += 1;
        if (samplesSeen === 3) return cut(longSample);
      }
      return done(`${body.model} works.\nANSWER: 3/4`);
    });
    const outcome = await runIsolated(snapshotLocal(), 0, () => runComparison(TASK, session, FROZEN, { tailRule: TAIL_RULE }));
    expect(outcome.tailApplied.samples + outcome.tailApplied.stage1).toBe(1);
    const synthesis = posts.find((post) => post.text.includes('You are aggregating'));
    expect(synthesis.text).toContain(TAIL_RULE.marker);
    expect(synthesis.text).toContain('sample end');
    expect(synthesis.text.includes(HEAD_SENTINEL)).toBe(false);
    expect(outcome.diagnostics.replicateTexts.some((text) => text.includes(HEAD_SENTINEL))).toBe(true);
  });

  it('leaves everything whole without the rule', async () => {
    const longAnswer = `${HEAD_SENTINEL} ${filler(12000, 3)}`;
    const posts = open((body) => {
      const text = body.messages?.[0]?.content || '';
      if (text.includes('You are evaluating different responses')) return done(stage2Answer(text));
      if (text.includes('You are the Chairman') || text.includes('You are aggregating')) return done('ANSWER: 3/4');
      if (body.model === 'gamma/three') return cut(longAnswer);
      return done('ANSWER: 3/4');
    });
    const outcome = await runIsolated(snapshotLocal(), 0, () => runComparison(TASK, session, FROZEN));
    expect(outcome.tailApplied).toBeUndefined();
    const judge = posts.find((post) => post.text.includes('You are evaluating different responses') && post.text.includes(HEAD_SENTINEL));
    expect(judge).toBeTruthy();
  });

  it('marks only a cut call whose content fell back to reasoning', () => {
    expect(cutReasoning({ ok: true, finishReason: 'length', contentFromReasoning: true })).toBe(true);
    expect(cutReasoning({ ok: true, finishReason: 'loop', contentFromReasoning: true })).toBe(true);
    expect(cutReasoning({ ok: true, finishReason: 'length' })).toBe(false);
    expect(cutReasoning({ ok: true, finishReason: 'stop', contentFromReasoning: true })).toBe(false);
    expect(cutReasoning({ ok: false, finishReason: 'length', contentFromReasoning: true })).toBe(false);
    const text = forwardText('x'.repeat(9000), TAIL_RULE);
    expect(text.startsWith(TAIL_RULE.marker)).toBe(true);
    expect(text.length).toBe(TAIL_RULE.marker.length + 1 + TAIL_RULE.chars);
  });
});
