/**
 * Browser port of backend/council.py.
 * Judge shuffles are deterministic (SHA-256 seed) but not bit-identical to
 * Python's Mersenne Twister. Each judge stores label_to_index, so the
 * chairman never depends on the shuffle matching.
 */

import * as openrouter from './openrouter.js';
import { settings, TITLE_MODEL } from './settings.js';

const RESPONSE_N = '\\*{0,2}Response\\s+(\\d+)\\*{0,2}';

export class Stage1AllFailed extends Error {
  constructor(failures) {
    super('All models failed to respond in Stage 1');
    this.name = 'Stage1AllFailed';
    this.failures = failures;
  }
}

function headingSource(label) {
  return `\\*{0,2}${label}\\*{0,2}\\s*:\\s*\\*{0,2}`;
}

function headingRe(label) {
  return new RegExp(headingSource(label), 'i');
}

function responseHeaderRe() {
  return new RegExp(
    `^\\s*(?:\\d+\\.\\s*)?\\*{0,2}Response\\s+(\\d+)\\*{0,2}(?:\\s*:\\s*\\*{0,2}|\\s*\\*{0,2}\\s*$)`,
    'gm',
  );
}

function truncateFixed(abs, digits) {
  const probe = abs.toFixed(100);
  const [whole, frac = ''] = probe.split('.');
  if (digits === 0) return whole;
  return `${whole}.${frac.slice(0, digits).padEnd(digits, '0')}`;
}

export function pyFixed(value, digits) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return String(numeric);
  const sign = numeric < 0 ? '-' : '';
  const abs = Math.abs(numeric);
  const probe = abs.toFixed(100);
  const dot = probe.indexOf('.');
  const frac = dot === -1 ? '' : probe.slice(dot + 1);
  const guard = frac[digits] || '0';
  const rest = frac.slice(digits + 1);
  const exactTie = guard === '5' && /^0*$/.test(rest);
  if (!exactTie) return sign + abs.toFixed(digits);
  const truncated = truncateFixed(abs, digits);
  const last = truncated.replace('.', '').slice(-1);
  if (Number(last) % 2 === 0) return sign + truncated;
  return sign + abs.toFixed(digits);
}

export function round(value, digits) {
  return Number(pyFixed(value, digits));
}

function formatTenths(value) {
  return pyFixed(value, 1);
}

function formatPercent(value) {
  return `${pyFixed(value * 100, 0)}%`;
}

export function usableStage1Results(councilModels, n, existingResults = null) {
  const allowed = new Set(councilModels);
  const kept = [];
  const used = new Map();
  for (const result of existingResults || []) {
    const model = result?.model;
    const count = used.get(model) || 0;
    if (!allowed.has(model) || count >= n) continue;
    used.set(model, count + 1);
    kept.push(result);
  }
  return kept;
}

export function pendingStage1Slots(councilModels, n, existingResults = null) {
  const used = new Map();
  for (const result of usableStage1Results(councilModels, n, existingResults)) {
    used.set(result.model, (used.get(result.model) || 0) + 1);
  }
  const pending = [];
  for (const model of councilModels) {
    const remaining = Math.max(0, n - (used.get(model) || 0));
    for (let i = 0; i < remaining; i += 1) pending.push(model);
  }
  return pending;
}

export function retainedStage1Failures(existingFailures, pendingModels, councilModels = null) {
  const pending = new Set(pendingModels);
  const allowed = councilModels == null ? null : new Set(councilModels);
  return (existingFailures || []).filter((failure) => {
    if (pending.has(failure?.model)) return false;
    if (allowed && !allowed.has(failure?.model)) return false;
    return true;
  });
}

async function sha256Bytes(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return new Uint8Array(digest);
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function seededShuffle(items, seedText) {
  const bytes = await sha256Bytes(seedText);
  const seed = ((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 0;
  const next = mulberry32(seed);
  const shuffled = [...items];
  for (let i = shuffled.length - 1; i > 0; i -= 1) {
    const j = Math.floor(next() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

export function canonicalLabelToModel(stage1Results) {
  const mapping = {};
  stage1Results.forEach((result, i) => {
    mapping[`Response ${i + 1}`] = result.model;
  });
  return mapping;
}

function asIntKeyed(mapping) {
  if (!mapping) return new Map();
  const out = new Map();
  for (const [key, value] of Object.entries(mapping)) {
    const index = Number(key);
    if (!Number.isInteger(index)) continue;
    out.set(index, value);
  }
  return out;
}

export async function buildJudgeView(judgeModel, stage1Results, queryText, selfExclusion = null) {
  const exclude = selfExclusion == null ? settings.selfExclusion : selfExclusion;
  const allIndices = stage1Results.map((_, index) => index);
  const judgeFamily = openrouter.modelFamily(judgeModel);
  let eligible = allIndices;
  let excluded = false;
  if (exclude) {
    eligible = allIndices.filter(
      (index) => openrouter.modelFamily(stage1Results[index].model) !== judgeFamily,
    );
    excluded = true;
    if (!eligible.length) {
      eligible = allIndices;
      excluded = false;
    }
  }

  const shuffled = await seededShuffle(eligible, `${judgeModel}\0${queryText}`);
  const labelToIndex = {};
  const candidates = shuffled.map((idx, i) => {
    const label = `Response ${i + 1}`;
    labelToIndex[label] = idx;
    return {
      label,
      index: idx,
      response: stage1Results[idx].response || '',
    };
  });
  return {
    candidates,
    label_to_index: labelToIndex,
    self_excluded: excluded,
  };
}

export function buildStage2Prompt(queryText, candidates) {
  const responsesText = candidates
    .map((candidate) => `${candidate.label}:\n${candidate.response}`)
    .join('\n\n');
  return `You are evaluating different responses to the following question.

Question: ${queryText}

Here are the responses from different models (anonymized):

${responsesText}

Your task:
1. Evaluate each response independently. For each one, briefly say what it does well and poorly, then give an absolute correctness score and list concrete factual or logical issues.
2. List claims that are disputed, contradicted, or unverified across the responses. If every response shares the same error, you MUST report it — do not assume that agreement implies correctness.
3. Then, at the very end, provide a final ranking from best to worst.

IMPORTANT: Use this exact structure (markers in all caps where shown):

Response 1:
<brief evaluation>
Correctness: 8/10
Issues: <concrete factual/logical errors, or none>

Response 2:
<brief evaluation>
Correctness: 5/10
Issues: <concrete factual/logical errors, or none>

(repeat for every response)

DISPUTED CLAIMS:
- <claim> (asserted by Response x, y; contradicted by / unverified)
(or none)

FINAL RANKING:
1. Response 2
2. Response 1

Rules for FINAL RANKING:
- Start with the line "FINAL RANKING:" (all caps, with colon)
- Numbered list from best to worst
- Each line: number, period, space, then ONLY the response label (e.g., "1. Response 1")
- No extra text after the ranking section

Now provide your evaluation and ranking:`;
}

export function parseRankingFromText(rankingText) {
  if (rankingText == null) return [];
  if (typeof rankingText !== 'string') return [];
  const header = rankingText.match(headingRe('FINAL RANKING'));
  const section = header
    ? rankingText.slice(header.index + header[0].length)
    : rankingText;
  const numbered = [...section.matchAll(new RegExp(`\\d+\\.\\s*${RESPONSE_N}`, 'g'))];
  if (numbered.length) return numbered.map((match) => `Response ${match[1]}`);
  return [...section.matchAll(new RegExp(RESPONSE_N, 'g'))].map(
    (match) => `Response ${match[1]}`,
  );
}

function evaluationSection(text) {
  let section = text;
  const disputed = section.match(headingRe('DISPUTED CLAIMS'));
  if (disputed) section = section.slice(0, disputed.index);
  const ranking = section.match(headingRe('FINAL RANKING'));
  if (ranking) section = section.slice(0, ranking.index);
  return section;
}

function* iterResponseBlocks(text) {
  const section = evaluationSection(text);
  const matches = [...section.matchAll(responseHeaderRe())];
  for (let i = 0; i < matches.length; i += 1) {
    const match = matches[i];
    const label = `Response ${match[1]}`;
    const start = match.index + match[0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index : section.length;
    yield [label, section.slice(start, end)];
  }
}

export function parseCorrectnessScores(text) {
  const scores = {};
  if (!text) return scores;
  const pattern = new RegExp(
    `${headingSource('Correctness')}\\s*\\*{0,2}(\\d+(?:\\.\\d+)?)\\*{0,2}\\s*(?:/\\s*10)?`,
    'i',
  );
  for (const [label, block] of iterResponseBlocks(text)) {
    const match = block.match(pattern);
    if (match) {
      scores[label] = Math.max(0, Math.min(10, Number(match[1])));
    } else {
      scores[label] = null;
    }
  }
  return scores;
}

export function parseIssues(text) {
  const issues = {};
  if (!text) return issues;
  const noneTokens = new Set(['none', 'none.', 'n/a', 'na', '-', '—']);
  const pattern = new RegExp(`${headingSource('Issues')}\\s*([\\s\\S]*)`, 'i');
  for (const [label, block] of iterResponseBlocks(text)) {
    const match = block.match(pattern);
    if (!match) {
      issues[label] = [];
      continue;
    }
    let raw = match[1].trim();
    const blank = raw.search(/\n\s*\n/);
    if (blank >= 0) raw = raw.slice(0, blank).trim();
    if (!raw || noneTokens.has(raw.toLowerCase())) {
      issues[label] = [];
      continue;
    }
    const items = [];
    for (const line of raw.split(/[\n;]+/)) {
      const cleaned = line.trim().replace(/^[-*•]+/, '').trim();
      if (cleaned && !noneTokens.has(cleaned.toLowerCase())) items.push(cleaned);
    }
    issues[label] = items;
  }
  return issues;
}

export function parseDisputedClaims(text) {
  if (!text) return [];
  const heading = text.match(headingRe('DISPUTED CLAIMS'));
  if (!heading) return [];
  let section = text.slice(heading.index + heading[0].length);
  const ranking = section.match(headingRe('FINAL RANKING'));
  if (ranking) section = section.slice(0, ranking.index);
  const stripped = section.trim();
  if (/^(none|n\/a|na|-|—)\.?\s*$/i.test(stripped)) return [];
  const noneTokens = new Set(['none', 'none.', 'n/a', 'na', '-', '—']);
  const claims = [];
  for (const line of section.split('\n')) {
    const cleaned = line.trim().replace(/^[-*•]+/, '').trim();
    if (!cleaned || noneTokens.has(cleaned.toLowerCase())) continue;
    claims.push(cleaned);
  }
  return claims;
}

export function mapRankingToIndices(parsedLabels, labelToIndex) {
  const ranked = [];
  const seen = new Set();
  for (const label of parsedLabels) {
    if (!(label in labelToIndex)) continue;
    const idx = Number(labelToIndex[label]);
    if (seen.has(idx)) continue;
    ranked.push(idx);
    seen.add(idx);
  }
  return ranked;
}

export function resolveRankedIndices(ranking) {
  const stored = ranking.ranked_indices;
  if (stored && stored.length) return stored.map((index) => Number(index));

  const parsed = ranking.parsed_ranking
    || parseRankingFromText(ranking.ranking || '');
  const mapping = ranking.label_to_index || {};
  if (Object.keys(mapping).length) {
    const coerced = {};
    for (const [key, value] of Object.entries(mapping)) coerced[key] = Number(value);
    return mapRankingToIndices(parsed, coerced);
  }

  const indices = [];
  const seen = new Set();
  for (const label of parsed) {
    const match = String(label).match(/(\d+)/);
    if (!match) continue;
    const idx = Number(match[1]) - 1;
    if (seen.has(idx)) continue;
    indices.push(idx);
    seen.add(idx);
  }
  return indices;
}

export function formatStage2Result(model, response, view) {
  const fullText = response.content || '';
  const parsed = parseRankingFromText(fullText);
  const labelToIndex = view.label_to_index;
  const rankedIndices = mapRankingToIndices(parsed, labelToIndex);
  const correctnessLabels = parseCorrectnessScores(fullText);
  const issuesLabels = parseIssues(fullText);
  const correctness = {};
  const issues = {};
  for (const [label, idx] of Object.entries(labelToIndex)) {
    correctness[String(idx)] = label in correctnessLabels ? correctnessLabels[label] : null;
    issues[String(idx)] = issuesLabels[label] || [];
  }
  return {
    model,
    ranking: fullText,
    parsed_ranking: parsed,
    ranked_indices: rankedIndices,
    label_to_index: labelToIndex,
    correctness,
    issues,
    disputed_claims: parseDisputedClaims(fullText),
    self_excluded: view.self_excluded,
    usage: response.usage || {},
  };
}

async function* asCompleted(factories) {
  const pending = new Set(factories.map((factory) => Promise.resolve().then(factory)));
  while (pending.size) {
    const winner = await Promise.race(
      [...pending].map((promise) => promise.then(
        (value) => ({ promise, value }),
        (reason) => ({ promise, reason, failed: true }),
      )),
    );
    pending.delete(winner.promise);
    if (winner.failed) throw winner.reason;
    yield winner.value;
  }
}

export async function* stage1CollectResponsesStreaming(userQuery, options = {}) {
  const n = options.n ?? settings.nSamples;
  const existingResults = options.existingResults ?? null;
  const existingFailures = options.existingFailures ?? null;
  const messages = [{ role: 'user', content: userQuery }];
  const councilModels = [...settings.councilModels];
  const totalSlots = councilModels.length * n;
  const allResults = usableStage1Results(councilModels, n, existingResults);
  const pendingModels = pendingStage1Slots(councilModels, n, allResults);
  const failures = retainedStage1Failures(existingFailures, pendingModels, councilModels);

  yield ['init', {
    total_models: totalSlots,
    pending_models: pendingModels.length,
    existing_count: allResults.length + failures.length,
  }];

  for (const result of allResults) {
    yield ['model_complete', { result, existing: true }];
  }
  for (const failure of failures) {
    yield ['model_failed', { ...failure, existing: true }];
  }

  if (pendingModels.length) {
    const tasks = pendingModels.map((model) => async () => {
      const response = await openrouter.queryModelResult(model, messages);
      return { model, response };
    });
    for await (const { model, response } of asCompleted(tasks)) {
      if (response.ok) {
        const result = {
          model,
          response: response.content || '',
          usage: response.usage || {},
        };
        allResults.push(result);
        yield ['model_complete', { result, existing: false }];
      } else {
        const failure = { model, error: response.error };
        failures.push(failure);
        yield ['model_failed', failure];
      }
    }
  }

  yield ['all_complete', { results: allResults, failures }];
}

export async function* stage2CollectRankingsStreaming(userQuery, stage1Results) {
  const labelToModel = canonicalLabelToModel(stage1Results);
  const models = [...settings.councilModels];
  yield ['init', { total_models: models.length, completed: 0 }];

  const stage2Results = [];
  const failures = [];
  const tasks = models.map((model) => async () => {
    const view = await buildJudgeView(model, stage1Results, userQuery);
    const prompt = buildStage2Prompt(userQuery, view.candidates);
    const response = await openrouter.queryModelResult(model, [{ role: 'user', content: prompt }]);
    return { model, response, view };
  });

  for await (const { model, response, view } of asCompleted(tasks)) {
    if (response.ok) {
      const result = formatStage2Result(model, response, view);
      stage2Results.push(result);
      yield ['model_complete', { result }];
    } else {
      const failure = { model, error: response.error };
      failures.push(failure);
      yield ['model_failed', failure];
    }
  }

  yield ['all_complete', {
    results: stage2Results,
    label_to_model: labelToModel,
    failures,
  }];
}

export function calculateAggregateRankings(stage1Results, stage2Results) {
  const n = stage1Results.length;
  const bordaScores = new Map();
  const correctnessScores = new Map();
  const mergedIssues = new Map();
  const seenIssues = new Map();
  const top1Votes = new Map();

  const push = (map, key, value) => {
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(value);
  };

  for (const ranking of stage2Results) {
    const ranked = resolveRankedIndices(ranking);
    const shown = ranking.label_to_index || {};
    const shownCount = Object.keys(shown).length;
    const mJ = shownCount ? shownCount : ranked.length;
    if (mJ >= 2) {
      ranked.forEach((idx, position) => {
        const pos = position + 1;
        if (idx >= 0 && idx < n) push(bordaScores, idx, (mJ - pos) / (mJ - 1));
      });
    }
    if (ranked.length && ranked[0] >= 0 && ranked[0] < n) {
      top1Votes.set(ranked[0], (top1Votes.get(ranked[0]) || 0) + 1);
    }

    for (const [idx, score] of asIntKeyed(ranking.correctness)) {
      if (score != null && idx >= 0 && idx < n) push(correctnessScores, idx, Number(score));
    }

    for (const [idx, items] of asIntKeyed(ranking.issues)) {
      if (!items || idx < 0 || idx >= n) continue;
      if (!seenIssues.has(idx)) seenIssues.set(idx, new Set());
      if (!mergedIssues.has(idx)) mergedIssues.set(idx, []);
      for (const item of items) {
        const key = String(item).toLowerCase();
        if (seenIssues.get(idx).has(key)) continue;
        seenIssues.get(idx).add(key);
        mergedIssues.get(idx).push(item);
      }
    }
  }

  const responseRankings = [];
  for (let i = 0; i < n; i += 1) {
    const scores = bordaScores.get(i) || [];
    const corr = correctnessScores.get(i) || [];
    responseRankings.push({
      index: i,
      model: stage1Results[i].model,
      score: scores.length ? round(scores.reduce((sum, value) => sum + value, 0) / scores.length, 4) : 0,
      mean_correctness: corr.length
        ? round(corr.reduce((sum, value) => sum + value, 0) / corr.length, 2)
        : null,
      votes: scores.length,
      top1_votes: top1Votes.get(i) || 0,
      issues: mergedIssues.get(i) || [],
    });
  }

  const rankingFallback = !responseRankings.some((row) => row.votes > 0);
  if (rankingFallback) {
    responseRankings.sort((a, b) => a.index - b.index);
  } else {
    responseRankings.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const aCorr = a.mean_correctness == null ? -1 : a.mean_correctness;
      const bCorr = b.mean_correctness == null ? -1 : b.mean_correctness;
      if (bCorr !== aCorr) return bCorr - aCorr;
      return a.index - b.index;
    });
  }

  const byModel = new Map();
  for (const row of responseRankings) {
    if (!byModel.has(row.model)) byModel.set(row.model, { scores: [], correctness: [] });
    const bucket = byModel.get(row.model);
    bucket.scores.push(row.score);
    if (row.mean_correctness != null) bucket.correctness.push(row.mean_correctness);
  }

  const aggregateRankings = [];
  for (const [model, data] of byModel) {
    const scores = data.scores;
    const corr = data.correctness;
    aggregateRankings.push({
      model,
      score: scores.length ? round(scores.reduce((sum, value) => sum + value, 0) / scores.length, 4) : 0,
      mean_correctness: corr.length
        ? round(corr.reduce((sum, value) => sum + value, 0) / corr.length, 2)
        : null,
      rankings_count: scores.length,
    });
  }
  aggregateRankings.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const aCorr = a.mean_correctness == null ? -1 : a.mean_correctness;
    const bCorr = b.mean_correctness == null ? -1 : b.mean_correctness;
    return bCorr - aCorr;
  });

  return { responseRankings, aggregateRankings, rankingFallback };
}

export function parseRedTeamVerdict(text) {
  let verdict = 'CONTESTED';
  let confidence = null;
  if (!text) return { verdict, confidence };
  const verdictMatch = text.match(/VERDICT:\s*(REFUTED|CONTESTED|UPHELD)/i);
  if (verdictMatch) verdict = verdictMatch[1].toUpperCase();
  const confMatch = text.match(/CONFIDENCE:\s*(\d+(?:\.\d+)?)\s*(?:\/\s*10)?/i);
  if (confMatch) confidence = Math.max(0, Math.min(10, Number(confMatch[1])));
  return { verdict, confidence };
}

function pickRedTeamModel(leaderModel, responseRankings) {
  const requested = settings.redTeamModel || settings.chairmanModel;
  const leaderFamily = openrouter.modelFamily(leaderModel);
  if (openrouter.modelFamily(requested) !== leaderFamily) return { model: requested, sameFamily: false };
  for (const row of responseRankings) {
    if (openrouter.modelFamily(row.model) !== leaderFamily) {
      return { model: row.model, sameFamily: false };
    }
  }
  return { model: requested, sameFamily: true };
}

export async function redTeamReview(
  queryText,
  leaderResponse,
  leaderIndex,
  responseRankings,
  stage1Results,
) {
  if (!stage1Results.length || leaderIndex < 0 || leaderIndex >= stage1Results.length) {
    return null;
  }
  const leaderModel = stage1Results[leaderIndex].model;
  const { model, sameFamily } = pickRedTeamModel(leaderModel, responseRankings);
  const prompt = `You are an adversarial reviewer. Independently verify the following answer and try to refute it. Do not assume it is correct. Look for factual errors, logical flaws, missing caveats, and confident-but-wrong claims.

Question: ${queryText}

Answer under review:
${leaderResponse}

Write a critique that attempts to refute the answer. Then end with EXACTLY these two lines:

VERDICT: REFUTED | CONTESTED | UPHELD
CONFIDENCE: <0-10>

Meaning:
- REFUTED = you found a concrete, decisive error that invalidates the main conclusion
- CONTESTED = you found a plausible error or a serious unresolved issue, but it is not decisive
- UPHELD = you could not find a concrete refutation
`;
  const result = await openrouter.queryModelResult(model, [{ role: 'user', content: prompt }]);
  if (!result.ok) {
    return {
      model,
      target_index: leaderIndex,
      critique: '',
      verdict: null,
      confidence: null,
      usage: {},
      same_family: sameFamily,
      error: result.error,
    };
  }
  const critique = result.content || '';
  const { verdict, confidence } = parseRedTeamVerdict(critique);
  return {
    model,
    target_index: leaderIndex,
    critique,
    verdict,
    confidence,
    usage: result.usage || {},
    same_family: sameFamily,
  };
}

function familyTop1Agreement(responseRankings, stage2Results) {
  const leader = responseRankings[0];
  const leaderFamily = openrouter.modelFamily(leader.model || '');
  const indexToModel = new Map();
  for (const row of responseRankings) {
    if (row.index != null) indexToModel.set(Number(row.index), row.model || '');
  }

  let votes = 0;
  let eligible = 0;
  for (const ranking of stage2Results) {
    const mapping = ranking.label_to_index || {};
    const mappingValues = Object.values(mapping);
    let sawFamily;
    if (mappingValues.length) {
      sawFamily = mappingValues.some(
        (idx) => openrouter.modelFamily(indexToModel.get(Number(idx)) || '') === leaderFamily,
      );
    } else {
      sawFamily = true;
    }
    if (!sawFamily) continue;
    eligible += 1;
    const ranked = resolveRankedIndices(ranking);
    if (!ranked.length) continue;
    const firstFamily = openrouter.modelFamily(indexToModel.get(ranked[0]) || '');
    if (firstFamily === leaderFamily) votes += 1;
  }
  if (!eligible) return 0;
  return votes / eligible;
}

export function computeConsensus(responseRankings, stage2Results, redTeam) {
  if (!responseRankings.length) {
    return {
      level: 'LOW',
      reasons: ['No ranked responses'],
      leader_index: null,
      leader_score: null,
      leader_mean_correctness: null,
      top1_agreement: 0,
      disputed_claims: [],
      red_team_verdict: null,
    };
  }

  const leader = responseRankings[0];
  const top1Agreement = familyTop1Agreement(responseRankings, stage2Results);
  const leaderCorr = leader.mean_correctness;
  const disputed = [];
  const seen = new Set();
  for (const ranking of stage2Results) {
    for (const claim of ranking.disputed_claims || []) {
      const key = claim.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      disputed.push(claim);
    }
  }

  const verdict = redTeam ? redTeam.verdict : null;
  const reasons = [];
  if (redTeam == null || redTeam.error) reasons.push('Red-team review was unavailable');

  let level;
  if (verdict === 'REFUTED') {
    level = 'CONTESTED';
    reasons.push('Red team found a decisive refutation of the leading answer');
  } else if (
    (leaderCorr != null && leaderCorr < 6)
    || top1Agreement < 0.4
    || verdict === 'CONTESTED'
  ) {
    level = 'LOW';
    if (leaderCorr != null && leaderCorr < 6) {
      reasons.push(`Leading answer mean correctness is ${formatTenths(leaderCorr)}/10`);
    }
    if (top1Agreement < 0.4) reasons.push(`Top-1 agreement is ${formatPercent(top1Agreement)}`);
    if (verdict === 'CONTESTED') reasons.push('Red team contested the leading answer');
  } else if (
    (leaderCorr != null && leaderCorr < 8)
    || top1Agreement < 0.7
    || disputed.length
    || verdict == null
  ) {
    level = 'MEDIUM';
    if (leaderCorr != null && leaderCorr < 8) {
      reasons.push(`Leading answer mean correctness is ${formatTenths(leaderCorr)}/10`);
    }
    if (top1Agreement < 0.7) reasons.push(`Top-1 agreement is ${formatPercent(top1Agreement)}`);
    if (disputed.length) {
      reasons.push(`${disputed.length} disputed claim(s) remain unresolved`);
    }
  } else {
    level = 'HIGH';
    reasons.push('Judges agreed on a high-correctness leader');
  }

  return {
    level,
    reasons,
    leader_index: leader.index,
    leader_score: leader.score,
    leader_mean_correctness: leaderCorr,
    top1_agreement: round(top1Agreement, 3),
    disputed_claims: disputed,
    red_team_verdict: verdict,
  };
}

export function buildCouncilMetadata(
  labelToModel,
  responseRankings,
  aggregateRankings,
  topKIndices,
  redTeam,
  consensus,
  rankingFallback = false,
) {
  return {
    label_to_model: labelToModel,
    response_rankings: responseRankings,
    aggregate_rankings: aggregateRankings,
    top_k_indices: topKIndices,
    red_team: redTeam,
    consensus,
    ranking_fallback: rankingFallback,
  };
}

export async function runPostRanking(queryText, stage1Results, stage2Results) {
  const { responseRankings, aggregateRankings, rankingFallback } = calculateAggregateRankings(
    stage1Results,
    stage2Results,
  );
  const topN = Math.max(1, Math.min(settings.topK, responseRankings.length || 1));
  const topKIndices = responseRankings.slice(0, topN).map((row) => row.index);

  let redTeam = null;
  if (responseRankings.length) {
    const leaderIndex = responseRankings[0].index;
    try {
      redTeam = await redTeamReview(
        queryText,
        stage1Results[leaderIndex].response || '',
        leaderIndex,
        responseRankings,
        stage1Results,
      );
    } catch {
      redTeam = null;
    }
  }

  const consensus = computeConsensus(responseRankings, stage2Results, redTeam);
  return {
    responseRankings,
    aggregateRankings,
    topKIndices,
    redTeam,
    consensus,
    rankingFallback,
  };
}

function formatCandidateBlock(ordinal, row, responseText) {
  const correctness = row.mean_correctness;
  const corrText = correctness == null ? 'n/a' : `${formatTenths(correctness)}/10`;
  const issues = row.issues || [];
  const issuesText = issues.length ? issues.join('; ') : 'none';
  const score = pyFixed(row.score || 0, 2);
  return (
    `Candidate #${ordinal} (score=${score}, `
    + `correctness=${corrText}):\n`
    + `Judge issues: ${issuesText}\n`
    + `${responseText}`
  );
}

export async function stage3SynthesizeFinal(
  userQuery,
  stage1Results,
  stage2Results = null,
  metadata = null,
) {
  void stage2Results;
  const meta = metadata || {};
  const consensus = meta.consensus || {};
  const redTeam = meta.red_team;
  let topKIndices = meta.top_k_indices || [];
  const responseRankings = meta.response_rankings || [];
  const byIndex = new Map(responseRankings.map((row) => [row.index, row]));

  if (!topKIndices.length && stage1Results.length) {
    const count = Math.min(settings.topK, stage1Results.length);
    topKIndices = Array.from({ length: count }, (_, index) => index);
  }

  const level = consensus.level || 'MEDIUM';
  const reasons = consensus.reasons || [];
  const disputed = consensus.disputed_claims || [];
  const reasonsText = reasons.length ? reasons.map((reason) => `- ${reason}`).join('\n') : '- none';
  const disputedText = disputed.length ? disputed.map((claim) => `- ${claim}`).join('\n') : '- none';

  let redTeamBlock;
  if (redTeam) {
    const verdict = redTeam.verdict || 'n/a';
    const conf = redTeam.confidence;
    const confText = conf == null ? 'n/a' : `${pyFixed(conf, 1)}/10`;
    redTeamBlock = (
      `Red-team verdict: ${verdict} (confidence ${confText})\n`
      + `Red-team critique:\n${redTeam.critique || ''}`
    );
  } else {
    redTeamBlock = 'Red-team review was unavailable.';
  }

  const candidateBlocks = [];
  topKIndices.forEach((idx, ordinal) => {
    if (idx < 0 || idx >= stage1Results.length) return;
    const row = byIndex.get(idx) || {
      index: idx,
      score: 0,
      mean_correctness: null,
      issues: [],
    };
    candidateBlocks.push(formatCandidateBlock(
      ordinal + 1,
      row,
      stage1Results[idx].response || '',
    ));
  });
  const candidatesText = candidateBlocks.join('\n\n') || '(no candidates)';

  const chairmanPrompt = `You are the Chairman of an LLM Council. Peer judges ranked anonymized answers and graded correctness. A red-team reviewer then tried to refute the leading answer.

Original Question: ${userQuery}

COUNCIL CONFIDENCE: ${level}
Reasons:
${reasonsText}

Disputed claims:
${disputedText}

${redTeamBlock}

CANDIDATES (ordered by peer score, best first). Candidate #1 is the base draft.

${candidatesText}

Your task:
- Treat Candidate #1 as the base draft.
- Apply edits from later candidates only where they correct an error or add verified content.
- Address every disputed claim: resolve it or flag it as unresolved.
- If the red-team verdict is REFUTED, present the refutation and a corrected answer instead of the leader's conclusion.
- If council confidence is LOW or CONTESTED, open with a one-line caveat.
- Do not mention model names.

Provide a clear, well-reasoned final answer:`;

  const result = await openrouter.queryModelResult(
    settings.chairmanModel,
    [{ role: 'user', content: chairmanPrompt }],
  );
  if (!result.ok) {
    const detail = result.error?.message || 'failed to generate response';
    throw new Error(`Chairman model (${settings.chairmanModel}) failed: ${detail}`);
  }

  let leaderIndex = consensus.leader_index;
  if (leaderIndex == null && topKIndices.length) leaderIndex = topKIndices[0];

  return {
    model: settings.chairmanModel,
    response: result.content || '',
    usage: result.usage || {},
    based_on_index: leaderIndex,
    top_k_indices: topKIndices,
    consensus_level: level,
  };
}

export async function generateConversationTitle(userQuery, signal = null) {
  const titlePrompt = `Generate a very short title (3-5 words maximum) that summarizes the following question.
The title should be concise and descriptive. Do not use quotes or punctuation in the title.

Question: ${userQuery}

Title:`;
  const response = await openrouter.queryModel(
    TITLE_MODEL,
    [{ role: 'user', content: titlePrompt }],
    { timeout: 30, signal },
  );
  if (signal?.aborted) return null;
  if (!response) return 'New Conversation';

  let title = String(response.content || 'New Conversation').trim().replace(/^["']+|["']+$/g, '');
  if (title.length > 50) title = `${title.slice(0, 47)}...`;
  return title;
}
