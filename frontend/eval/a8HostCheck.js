// A capacity check of one endpoint before a campaign pins it. It sends N calls
// at once through that endpoint only (no fallback), with a neutral prompt that
// holds no question of the bank, and records how many came back with a
// generation and how fast. The rule is fixed before the calls: the host is
// used when at least MIN_ACCEPTED of N came back and the median speed is at
// least MIN_TOKENS_PER_SECOND; otherwise the model is dropped. Short calls
// only: this does not show that streams of twenty minutes hold.
//
//   node frontend/eval/a8HostCheck.js --model stepfun/step-5-preview --tag stepfun/fp8 --from a8-routes-v6 --out a8-routes-v7 --live

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createCampaignBudget } from './budget.js';
import { audit } from './finishProbe.js';
import { V3BudgetStop, budgetedFetch } from './finishProbeV3.js';

const EVAL_ROOT = path.dirname(fileURLToPath(import.meta.url));
const RUNS_ROOT = path.join(EVAL_ROOT, '.runs');
const CHAT_URL = 'https://openrouter.ai/api/v1/chat/completions';

export const CALLS = 12;
export const MIN_ACCEPTED = 10;
// The stream deadline of the campaign: 32768 tokens in 4216 s is 7.8 tokens a
// second. A host below 10 would cut answers at the deadline.
export const MIN_TOKENS_PER_SECOND = 10;
export const MAX_TOKENS = 512;
export const LIMITS = Object.freeze({ maxUsd: 0.25, maxPosts: 15 });
export const PROMPT = 'Write the whole numbers from 1 to 300 in order, separated by single spaces, and nothing else.';

export function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// Pure: the verdict from the rows of the calls.
export function hostVerdict(rows, { minAccepted = MIN_ACCEPTED, minSpeed = MIN_TOKENS_PER_SECOND } = {}) {
  const accepted = rows.filter((row) => row.accepted);
  const speeds = accepted.map((row) => row.tokensPerSecond).filter(Number.isFinite);
  const medianSpeed = median(speeds);
  const enough = accepted.length >= minAccepted;
  const fast = medianSpeed != null && medianSpeed >= minSpeed;
  return {
    calls: rows.length,
    accepted: accepted.length,
    medianTokensPerSecond: medianSpeed,
    verdict: enough && fast ? 'use' : 'drop',
    reasons: [...(enough ? [] : [`${accepted.length} of ${rows.length} came back, need ${minAccepted}`]), ...(fast ? [] : [`median speed ${medianSpeed == null ? 'n/a' : medianSpeed.toFixed(1)} tokens/s, need ${minSpeed}`])],
  };
}

export function requestBody(route, tag) {
  return {
    model: route.id,
    messages: [{ role: 'user', content: PROMPT }],
    max_tokens: MAX_TOKENS,
    temperature: route.temperature ?? 0.7,
    top_p: route.topP ?? 1,
    provider: { order: [tag], allow_fallbacks: false, max_price: route.provider.max_price },
    stream: false,
    usage: { include: true },
  };
}

function flagValue(argv, name) {
  const index = argv.indexOf(name);
  return index < 0 ? null : (argv[index + 1] ?? null);
}

function readJsonl(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

export async function runHostCheck(argv, { root = RUNS_ROOT, fetchImpl = fetch } = {}) {
  if (!argv.includes('--live')) throw new Error('a8HostCheck posts only with --live');
  const modelId = flagValue(argv, '--model');
  const tag = flagValue(argv, '--tag');
  const from = flagValue(argv, '--from') || 'a8-routes-v6';
  const out = flagValue(argv, '--out');
  if (!modelId || !tag || !out) throw new Error('--model, --tag, and --out are required');
  const key = String(process.env.or_key || process.env.OR_KEY || '').trim();
  if (!key) throw new Error('or_key is missing');
  const snapshot = JSON.parse(readFileSync(path.join(root, from, 'preflight.json'), 'utf8'));
  const route = snapshot.routes.find((row) => row.id === modelId);
  if (!route) throw new Error(`${modelId} is not in ${from}`);
  const dir = path.join(root, out);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'hostcheck.json');
  if (existsSync(file)) throw new Error(`${out} already has a host check`);
  const budgetFile = path.join(dir, 'hostcheck-budget.jsonl');
  const budget = createCampaignBudget({ ...LIMITS, prices: { [modelId]: route.pricing }, onEvent: (event) => appendFileSync(budgetFile, `${JSON.stringify(event)}\n`, 'utf8') });
  budget.applyJournal(readJsonl(budgetFile));
  await audit(budget, 'hostcheck', 'start');
  const send = budgetedFetch({ budget, prefix: 'hostcheck', stamp: Date.now(), fetchImpl });
  const body = requestBody(route, tag);
  const one = async (index) => {
    const started = Date.now();
    const row = { index, status: null, accepted: false };
    try {
      const response = await send(CHAT_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'X-Title': 'llm-council eval host check' },
        body: JSON.stringify(body),
      });
      const json = await response.json().catch(() => null);
      const seconds = (Date.now() - started) / 1000;
      const tokens = Number(json?.usage?.completion_tokens);
      Object.assign(row, {
        status: response.status,
        provider: json?.provider ?? null,
        finishReason: json?.choices?.[0]?.finish_reason ?? null,
        completionTokens: Number.isFinite(tokens) ? tokens : null,
        seconds,
        tokensPerSecond: Number.isFinite(tokens) && seconds > 0 ? tokens / seconds : null,
        cost: json?.usage?.cost ?? null,
        error: json?.error?.message ? String(json.error.message).slice(0, 200) : null,
      });
      row.accepted = response.status === 200 && !json?.error && Number.isFinite(tokens) && tokens > 0;
    } catch (error) {
      row.error = error instanceof V3BudgetStop ? `budget: ${error.message}` : (error instanceof Error ? error.message : String(error));
      row.seconds = (Date.now() - started) / 1000;
    }
    return row;
  };
  const rows = await Promise.all(Array.from({ length: CALLS }, (_, index) => one(index)));
  await audit(budget, 'hostcheck', 'end');
  const verdict = hostVerdict(rows);
  const record = {
    at: new Date().toISOString(),
    model: modelId,
    tag,
    rule: `use when at least ${MIN_ACCEPTED} of ${CALLS} calls at once come back with a generation and the median speed is at least ${MIN_TOKENS_PER_SECOND} tokens/s; otherwise drop the model`,
    request: { ...body, messages: [{ role: 'user', content: PROMPT }] },
    ...verdict,
    rows,
    spend: { settledUsd: budget.state.settledUsd, heldUsd: budget.state.unresolvedUsd, posts: budget.state.posts },
  };
  writeFileSync(file, JSON.stringify(record, null, 2), 'utf8');
  console.log(`host check ${modelId} via ${tag}: ${verdict.accepted} of ${verdict.calls} came back, median ${verdict.medianTokensPerSecond == null ? 'n/a' : verdict.medianTokensPerSecond.toFixed(1)} tokens/s -> ${verdict.verdict}${verdict.reasons.length ? ` (${verdict.reasons.join('; ')})` : ''}; spend $${budget.state.settledUsd.toFixed(4)}`);
  return verdict.verdict === 'use' ? 0 : 4;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runHostCheck(process.argv.slice(2));
}
