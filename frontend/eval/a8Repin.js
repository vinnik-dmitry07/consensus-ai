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

import { contextProblems, maxCommonCap } from './a8Profile.js';
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

// The state of an avoided endpoint, as the listing gives it.
function healthOf(endpoint) {
  if (!endpoint) return { listed: false };
  return {
    listed: true,
    status: endpoint.status ?? null,
    uptimeLast5m: endpoint.uptime_last_5m ?? null,
    uptimeLast30m: endpoint.uptime_last_30m ?? null,
    uptimeLast1d: endpoint.uptime_last_1d ?? null,
  };
}

// listings: { [modelId]: { status, endpoints } }. Pure: the same snapshot,
// listings, and options give the same plan.
// - model: the route to re-pin (null: none).
// - avoid: endpoint tags of that model taken as unavailable, recorded with
//   their listed state.
// - drop: candidates removed from the snapshot.
// - cap: an explicit cap. Without it the common cap of the snapshot must not
//   move; with it every candidate must carry it.
export function repinPlan({ snapshot, listings, model = HY4, avoid = [], drop = [], cap: fixedCap = null }) {
  const original = snapshot.candidates || [];
  for (const id of drop) if (!original.includes(id)) throw new Error(`${id} is not a candidate of the snapshot`);
  const candidates = original.filter((id) => !drop.includes(id));
  if (model && !candidates.includes(model)) throw new Error(`${model} is not a candidate of the snapshot`);
  const byId = new Map(snapshot.routes.map((route) => [route.id, route]));
  const commonBefore = maxCommonCap(original.map((id) => byId.get(id)));
  const cap = fixedCap ?? commonBefore;
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
  let chosen = null;
  let routes = snapshot.routes;
  const avoided = [];
  if (model) {
    const route = byId.get(model);
    const all = listings[model]?.endpoints || [];
    for (const tag of avoid) avoided.push({ tag, ...healthOf(all.find((endpoint) => endpoint.tag === tag)) });
    const usable = all.filter((endpoint) => !avoid.includes(endpoint.tag));
    // An avoided pinned host is not the pinned route any more.
    const base = avoid.includes(route.tag) ? { ...route, tag: `${route.tag} (avoided)`, providerName: null } : route;
    const found = routeCandidates(usable, base, needs);
    checks[model] = { ...checks[model], ...needs, avoided, rows: found.rows, candidates: found.candidates.map((row) => row.tag) };
    chosen = found.candidates[0] || null;
    if (!chosen) problems.push(`${model}: no endpoint fits the rule`);
    if (chosen && !chosen.pinnedRoute) {
      const endpoint = usable.find((row) => row.tag === chosen.tag);
      routes = snapshot.routes.map((row) => (row.id === model ? repinnedRoute(row, endpoint) : row));
    }
  }
  const after = candidates.map((id) => routes.find((row) => row.id === id));
  if (fixedCap == null) {
    const moved = maxCommonCap(after);
    if (moved !== commonBefore) problems.push(`the common cap moves from ${commonBefore} to ${moved}`);
  } else {
    for (const route of after) problems.push(...contextProblems(route, fixedCap));
  }
  return { model, cap, needs, checks, chosen, routes, candidates, dropped: drop, avoided, problems };
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

function listFlag(argv, name) {
  const raw = flagValue(argv, name);
  return raw ? raw.split(',').map((item) => item.trim()).filter(Boolean) : [];
}

export async function runRepin(argv, { root = RUNS_ROOT, fetchImpl = fetch, expectTag = null } = {}) {
  const from = flagValue(argv, '--from') || 'a8-open-v4';
  const out = flagValue(argv, '--out');
  const drop = listFlag(argv, '--drop');
  const avoid = listFlag(argv, '--avoid');
  const model = flagValue(argv, '--model') || (drop.length ? null : HY4);
  const capRaw = flagValue(argv, '--cap');
  const cap = capRaw == null ? null : Number(capRaw);
  if (cap != null && !(Number.isInteger(cap) && cap > 0)) throw new Error('--cap needs a positive integer');
  if (avoid.length && !model) throw new Error('--avoid needs --model');
  if (!out || out === from) throw new Error('--out needs a new run id');
  const outDir = path.join(root, out);
  if (existsSync(path.join(outDir, 'preflight.json'))) throw new Error(`${out} already has a route snapshot`);
  const snapshot = JSON.parse(readFileSync(path.join(root, from, 'preflight.json'), 'utf8'));
  const listings = {};
  for (const id of (snapshot.candidates || []).filter((id) => !drop.includes(id))) listings[id] = await listingOf(id, fetchImpl);
  const plan = repinPlan({ snapshot, listings, model, avoid, drop, cap });
  const at = new Date().toISOString();
  if (expectTag && plan.chosen?.tag !== expectTag) plan.problems.push(`the rule chose ${plan.chosen?.tag ?? 'nothing'}, not ${expectTag}`);
  const record = {
    at, from, model, avoid, drop, explicitCap: cap, rule: RULE, cap: plan.cap, needs: plan.needs,
    checks: plan.checks, chosen: plan.chosen, candidates: plan.candidates, problems: plan.problems,
  };
  mkdirSync(outDir, { recursive: true });
  writeFileSync(path.join(outDir, 'repin.json'), JSON.stringify(record, null, 2), 'utf8');
  if (plan.problems.length) {
    console.log(`repin stopped: ${plan.problems.join('; ')}`);
    return 2;
  }
  const doc = {
    ...snapshot,
    candidates: plan.candidates,
    routes: plan.routes,
    repinnedFrom: from,
    repinnedAt: at,
    repin: {
      model,
      from: model ? snapshot.routes.find((row) => row.id === model).tag : null,
      to: plan.chosen?.tag ?? null,
      pinnedRoute: plan.chosen?.pinnedRoute ?? null,
      avoided: plan.avoided,
      dropped: drop,
      cap: plan.cap,
    },
  };
  writeFileSync(path.join(outDir, 'preflight.json'), JSON.stringify(doc, null, 2), 'utf8');
  const moved = model ? `${model} ${doc.repin.from} -> ${doc.repin.to}` : 'no route moved';
  console.log(`repin: ${moved}; dropped ${drop.join(', ') || 'none'}; cap ${plan.cap}; candidates ${plan.candidates.join(', ')}`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  process.exitCode = await runRepin(argv, { expectTag: flagValue(argv, '--expect') });
}
