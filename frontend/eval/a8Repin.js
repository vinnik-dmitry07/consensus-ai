// A route snapshot for a new campaign whose pinned host of one model is gone.
// It copies the snapshot of another run and replaces that one route by the
// rule of finish-probe-v3 (routeCandidates): an endpoint of the same model
// that takes every parameter, holds the S8 prompt and the cap, allows the cap
// as output, and costs no more than the pinned one; the larger declared
// precision first, then the tag; unknown precision last. The choice reads only
// the endpoint list, never an answer. Only free GETs, no POST.
//
//   node frontend/eval/a8Repin.js --from a8-open-v4 --out a8-routes-v6 [--model tencent/hy4-preview]

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { maxCommonCap } from './a8Profile.js';
import { pinnedListed } from './finishProbeV2Report.js';
import { HY4, routeCandidates } from './finishProbeV3.js';

const EVAL_ROOT = path.dirname(fileURLToPath(import.meta.url));
const RUNS_ROOT = path.join(EVAL_ROOT, '.runs');
const MODELS_URL = 'https://openrouter.ai/api/v1/models';
// The S8 synthesis prompt holds five answers at the cap: 6 x cap + 8000 with
// the output, the check of a8Profile.contextProblems.
export const PROMPT_FACTOR = 5;
export const CONTEXT_RESERVE = 8000;
export const RULE = 'pinned provider when listed and fitting; otherwise endpoints of the same model that take max_tokens, temperature, top_p, and reasoning, hold 5 x cap + 8000 prompt tokens plus the cap, allow the cap as output, and cost no more than the pinned route; larger declared precision first, then tag; unknown precision last';

export function needsFor(cap) {
  return { needPrompt: PROMPT_FACTOR * cap + CONTEXT_RESERVE, cap };
}

function supportsFrom(endpoint) {
  const params = endpoint.supported_parameters || [];
  return Object.fromEntries(['temperature', 'top_p', 'reasoning', 'max_tokens'].map((name) => [name, params.includes(name)]));
}

// The new route of `model` from the endpoint `chosen` of its listing.
export function repinnedRoute(route, endpoint) {
  return {
    ...route,
    tag: endpoint.tag,
    providerName: endpoint.provider_name ?? null,
    quantization: endpoint.quantization ?? 'unknown',
    context: endpoint.context_length ?? null,
    maxCompletion: endpoint.max_completion_tokens ?? null,
    maxPrompt: endpoint.max_prompt_tokens ?? null,
    supports: supportsFrom(endpoint),
    provider: { order: [endpoint.tag], allow_fallbacks: false, max_price: route.provider.max_price },
  };
}

// listings: { [modelId]: { status, endpoints } }. Pure: the same snapshot and
// listings give the same plan.
export function repinPlan({ snapshot, listings, model = HY4 }) {
  const candidates = snapshot.candidates || [];
  if (!candidates.includes(model)) throw new Error(`${model} is not a candidate of the snapshot`);
  const byId = new Map(snapshot.routes.map((route) => [route.id, route]));
  const cap = maxCommonCap(candidates.map((id) => byId.get(id)));
  const needs = needsFor(cap);
  const problems = [];
  const checks = {};
  for (const id of candidates) {
    const route = byId.get(id);
    const listing = listings[id] || { status: null, endpoints: [] };
    const endpoints = listing.endpoints || [];
    const pinned = endpoints.filter((endpoint) => pinnedListed(route, [endpoint]));
    checks[id] = {
      status: listing.status,
      pinned: { tag: route.tag, providerName: route.providerName },
      pinnedListed: pinned.length > 0,
      pinnedTags: pinned.map((endpoint) => endpoint.tag),
      listed: endpoints.map((endpoint) => endpoint.tag),
    };
    if (id !== model && !pinned.length) problems.push(`${id}: the pinned endpoint ${route.tag} is not listed`);
  }
  const route = byId.get(model);
  const found = routeCandidates(listings[model]?.endpoints || [], route, needs);
  checks[model] = { ...checks[model], ...needs, rows: found.rows, candidates: found.candidates.map((row) => row.tag) };
  const chosen = found.candidates[0] || null;
  if (!chosen) problems.push(`${model}: no endpoint fits the rule`);
  let routes = snapshot.routes;
  if (chosen && !chosen.pinnedRoute) {
    const endpoint = listings[model].endpoints.find((row) => row.tag === chosen.tag);
    routes = snapshot.routes.map((row) => (row.id === model ? repinnedRoute(row, endpoint) : row));
    const after = maxCommonCap(candidates.map((id) => routes.find((row) => row.id === id)));
    if (after !== cap) problems.push(`the common cap moves from ${cap} to ${after}`);
  }
  return { model, cap, needs, checks, chosen, routes, problems };
}

async function listingOf(id, fetchImpl = fetch) {
  try {
    const response = await fetchImpl(`${MODELS_URL}/${id}/endpoints`);
    const body = await response.json().catch(() => null);
    return { status: response.status, endpoints: body?.data?.endpoints || [] };
  } catch (error) {
    return { status: null, endpoints: [], error: error instanceof Error ? error.message : String(error) };
  }
}

function flagValue(argv, name) {
  const index = argv.indexOf(name);
  return index < 0 ? null : (argv[index + 1] ?? null);
}

export async function runRepin(argv, { root = RUNS_ROOT, fetchImpl = fetch, expectTag = null } = {}) {
  const from = flagValue(argv, '--from') || 'a8-open-v4';
  const out = flagValue(argv, '--out');
  const model = flagValue(argv, '--model') || HY4;
  if (!out || out === from) throw new Error('--out needs a new run id');
  const outDir = path.join(root, out);
  if (existsSync(path.join(outDir, 'preflight.json'))) throw new Error(`${out} already has a route snapshot`);
  const snapshot = JSON.parse(readFileSync(path.join(root, from, 'preflight.json'), 'utf8'));
  const listings = {};
  for (const id of snapshot.candidates || []) listings[id] = await listingOf(id, fetchImpl);
  const plan = repinPlan({ snapshot, listings, model });
  const at = new Date().toISOString();
  if (expectTag && plan.chosen?.tag !== expectTag) plan.problems.push(`the rule chose ${plan.chosen?.tag ?? 'nothing'}, not ${expectTag}`);
  const record = { at, from, model, rule: RULE, cap: plan.cap, needs: plan.needs, checks: plan.checks, chosen: plan.chosen, problems: plan.problems };
  mkdirSync(outDir, { recursive: true });
  writeFileSync(path.join(outDir, 'repin.json'), JSON.stringify(record, null, 2), 'utf8');
  if (plan.problems.length) {
    console.log(`repin stopped: ${plan.problems.join('; ')}`);
    return 2;
  }
  const doc = {
    ...snapshot,
    routes: plan.routes,
    repinnedFrom: from,
    repinnedAt: at,
    repin: { model, from: snapshot.routes.find((row) => row.id === model).tag, to: plan.chosen.tag, pinnedRoute: plan.chosen.pinnedRoute },
  };
  writeFileSync(path.join(outDir, 'preflight.json'), JSON.stringify(doc, null, 2), 'utf8');
  console.log(`repin: ${model} ${doc.repin.from} -> ${doc.repin.to}; cap ${plan.cap}; candidates ${plan.checks[model].candidates.join(', ')}`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  process.exitCode = await runRepin(argv, { expectTag: flagValue(argv, '--expect') });
}
