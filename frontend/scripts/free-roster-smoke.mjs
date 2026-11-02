/**
 * Availability smoke for the free-roster rule.
 * One short completion per catalogue id in the union of the size preset (A)
 * and the weekly preset (B). No retries and no paid fallback.
 * Prints progress only. Does not print the API key, answer text, or question ids.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createBudget } from '../eval/budget.js';
import { attemptStore, installTransport } from '../eval/transport.js';
import { modelsFromPricing } from '../src/engine/browser/engine.js';
import {
  ENDPOINT_CONCURRENCY,
  ENDPOINT_TIMEOUT_MS,
  freeEndpointsUrl,
} from '../src/engine/browser/freeRoster.js';
import {
  OPENROUTER_API_URL,
  OPENROUTER_KEY_URL,
  OPENROUTER_MODELS_URL,
  appReferer,
  catalogueEntry,
  hasVisibleContent,
  providerErrorFields,
} from '../src/engine/browser/openrouter.js';
import {
  accountRateLimitKind,
  catalogueId,
  chooseFreeChairman,
  confirmedUpstreamLimit,
  freeTierDefaultRoster,
  selectFreeCandidateIds,
} from '../src/engine/browser/roster.js';

const PUBLISHED_KEY_SHA256 = '6960e656a6aee20c444cf942135b7495bd1a27d277ed08c7b4976ff7a35338fc';
const POST_CAP = 20;
const PROMPT = 'Reply with the single word pong.';

if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') {
  delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
}

const key = process.env.or_key || '';
if (!key) {
  console.error('Set or_key in the environment before running the free-roster smoke.');
  process.exit(1);
}
const digest = createHash('sha256').update(key).digest('hex');
if (digest === PUBLISHED_KEY_SHA256) {
  console.error('Refusing to send the published key.');
  process.exit(1);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(here, '../eval/.runs/free-smoke');
mkdirSync(outDir, { recursive: true });

function freeRemaining(info) {
  const bucket = info?.free_model_daily_requests || info?.freeModelDailyRequests || null;
  if (!bucket || typeof bucket !== 'object') return null;
  if (bucket.remaining != null) return Number(bucket.remaining);
  if (bucket.limit != null && bucket.used != null) return Number(bucket.limit) - Number(bucket.used);
  return null;
}

function summarizeBody(text) {
  let parsed = null;
  try {
    parsed = JSON.parse(text || '');
  } catch {
    parsed = null;
  }
  const err = parsed?.error;
  const fields = err && typeof err === 'object' ? providerErrorFields(err) : providerErrorFields(null);
  const raw = fields.raw || '';
  const metadata = {
    limit_source: fields.limit_source,
    raw,
  };
  const content = parsed?.choices?.[0]?.message?.content;
  const blob = `${fields.message} ${raw}`;
  return {
    nonEmpty: hasVisibleContent(content),
    limitSource: fields.limit_source,
    providerName: fields.provider_name,
    isByok: fields.is_byok,
    accountLimit: accountRateLimitKind(blob, metadata),
    upstream: confirmedUpstreamLimit(blob, metadata),
    errorStatus: fields.status,
  };
}

async function fetchJson(url, extraHeaders = {}) {
  const response = await fetch(url, { headers: extraHeaders });
  const text = await response.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  return { status: response.status, body };
}

console.log('smoke: reading the weekly catalogue');
const catalogue = await fetchJson(`${OPENROUTER_MODELS_URL}?sort=top-weekly`);
let weeklyOrder = catalogue.status === 200 && Array.isArray(catalogue.body?.data);
let rows = weeklyOrder ? catalogue.body.data : [];
if (!weeklyOrder) {
  console.log('smoke: weekly order unavailable, reading the unsorted catalogue');
  const fallback = await fetchJson(OPENROUTER_MODELS_URL);
  weeklyOrder = false;
  rows = Array.isArray(fallback.body?.data) ? fallback.body.data : [];
  if (fallback.status !== 200 || !rows.length) {
    console.error(`smoke: catalogue unavailable (http ${fallback.status})`);
    process.exit(1);
  }
}

const pricing = {};
rows.forEach((row, index) => {
  if (!row?.id || pricing[row.id]) return;
  pricing[row.id] = catalogueEntry(row, weeklyOrder ? index + 1 : null);
});
const models = modelsFromPricing(pricing);
const rosterA = freeTierDefaultRoster(models, []);
const selectedB = selectFreeCandidateIds(models, {
  blockedIds: [],
  coolingIds: [],
  quarantinedIds: [],
});
const councilB = selectedB.ids.slice(0, 10);
const chairmanB = chooseFreeChairman(councilB, models);
const idsA = new Set(rosterA.councilModels.map(catalogueId));
const idsB = new Set(councilB.map(catalogueId));
const union = [];
for (const id of [...rosterA.councilModels, ...councilB]) {
  const cid = catalogueId(id);
  if (!cid || union.includes(cid)) continue;
  union.push(cid);
  if (union.length >= POST_CAP) break;
}

console.log(`smoke: roster A ${rosterA.councilModels.length}, roster B ${councilB.length}, union ${union.length}`);

async function mapPool(items, limit, task) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await task(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

console.log('smoke: reading endpoint status');
const endpointById = new Map();
await mapPool(union, ENDPOINT_CONCURRENCY, async (id, index) => {
  const url = freeEndpointsUrl(id);
  console.log(`smoke: endpoints ${index + 1}/${union.length} ${id}`);
  if (!url) {
    endpointById.set(id, { state: 'unknown' });
    return;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ENDPOINT_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${key}` },
      signal: controller.signal,
    });
    const body = await response.json().catch(() => null);
    const endpoint = body?.data?.endpoints?.[0] || null;
    endpointById.set(id, {
      http: response.status,
      status: endpoint?.status ?? null,
      providerName: endpoint?.provider_name ?? null,
      uptime5m: endpoint?.uptime_last_5m ?? null,
      uptime30m: endpoint?.uptime_last_30m ?? null,
      uptime1d: endpoint?.uptime_last_1d ?? null,
    });
  } catch {
    endpointById.set(id, { state: 'unknown' });
  } finally {
    clearTimeout(timer);
  }
});

console.log('smoke: reading the account free-model limit');
const keyInfo = await fetchJson(OPENROUTER_KEY_URL, { Authorization: `Bearer ${key}` });
const remaining = freeRemaining(keyInfo.body?.data);
console.log(`smoke: free remaining ${remaining == null ? 'unknown' : remaining}`);

const results = [];
let stoppedForAccount = false;
if (remaining === 0) {
  stoppedForAccount = true;
  console.log('smoke: account free limit is exhausted, no completions were sent');
} else {
  const nativeFetch = globalThis.fetch;
  const budget = createBudget({ totalCap: POST_CAP, conservativeDaily: POST_CAP });
  if (remaining != null) budget.noteServer({ free_model_daily_requests: { remaining, limit: remaining } });
  const restore = installTransport({
    nativeFetch,
    allowModels: new Set(union),
    allowPaid: false,
    budget,
  });
  try {
    for (let index = 0; index < union.length; index += 1) {
      const model = union[index];
      if (index > 0) {
        console.log('smoke: waiting 4s for the shared free-model minute limit');
        await new Promise((resolve) => setTimeout(resolve, 4000));
      }
      if (budget.state.paused) {
        stoppedForAccount = true;
        console.log(`smoke: stopped before ${model} (${budget.state.pauseReason})`);
        break;
      }
      const started = Date.now();
      let status = null;
      let summary = summarizeBody('');
      let network = false;
      try {
        const response = await attemptStore.run({ key: `smoke-${index + 1}` }, () => fetch(OPENROUTER_API_URL, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${key}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': appReferer(),
            'X-Title': 'consensus.ai',
          },
          body: JSON.stringify({
            model,
            messages: [{ role: 'user', content: PROMPT }],
            max_tokens: 32,
            temperature: 0,
          }),
        }));
        status = response.status;
        const text = await response.text();
        summary = summarizeBody(text);
      } catch (exc) {
        network = true;
        summary = { ...summary, nonEmpty: false, errorStatus: exc instanceof Error ? exc.name : 'error' };
      }
      const elapsedMs = Date.now() - started;
      const row = {
        model,
        http: status,
        elapsedMs,
        nonEmpty: summary.nonEmpty === true,
        network,
        limitSource: summary.limitSource,
        providerName: summary.providerName,
        isByok: summary.isByok,
        accountLimit: summary.accountLimit,
        upstream: summary.upstream === true,
        endpoint: endpointById.get(model) || null,
        inA: idsA.has(model),
        inB: idsB.has(model),
      };
      results.push(row);
      console.log(
        `smoke ${index + 1}/${union.length} ${model} http=${status ?? 'none'} `
        + `nonempty=${row.nonEmpty} ${elapsedMs}ms `
        + `limit=${row.accountLimit || row.limitSource || '-'}`,
      );
      if (row.accountLimit) {
        stoppedForAccount = true;
        console.log('smoke: account limit reached, remaining models were not sent');
        break;
      }
    }
  } finally {
    restore();
  }
}

const sent = new Set(results.map((row) => row.model));
for (const model of union) {
  if (sent.has(model)) continue;
  results.push({
    model,
    notRun: stoppedForAccount ? 'account-limit' : 'not-sent',
    endpoint: endpointById.get(model) || null,
    inA: idsA.has(model),
    inB: idsB.has(model),
  });
}

function availability(rows) {
  const attempted = rows.filter((row) => row.notRun == null);
  const responded = attempted.filter((row) => row.nonEmpty);
  return {
    attempted: attempted.length,
    responded: responded.length,
    rate: attempted.length ? responded.length / attempted.length : null,
  };
}

const summary = {
  measuredAt: new Date().toISOString(),
  kind: 'availability-smoke',
  weeklyOrder,
  postCap: POST_CAP,
  stoppedForAccount,
  freeRemainingBefore: remaining,
  rosterA: {
    rule: 'size',
    councilModels: rosterA.councilModels,
    chairmanModel: rosterA.chairmanModel,
  },
  rosterB: {
    rule: selectedB.fallback === 'size' ? 'size-fallback' : 'weekly',
    fallback: selectedB.fallback,
    councilModels: councilB,
    chairmanModel: chairmanB.chairmanModel,
    chairmanBasis: chairmanB.basis,
    excluded: selectedB.excluded,
  },
  onlyA: rosterA.councilModels.filter((id) => !idsB.has(catalogueId(id))),
  onlyB: councilB.filter((id) => !idsA.has(catalogueId(id))),
  availability: {
    union: availability(results),
    A: availability(results.filter((row) => row.inA)),
    B: availability(results.filter((row) => row.inB)),
  },
  results,
};

writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));
const lines = [
  '# Free roster availability smoke',
  '',
  'This file records whether a short completion finished. It is not a quality measurement.',
  'The probe asks for 32 tokens and does not stream. HTTP 200 with an empty message can mean the route answered only in reasoning, or needed a longer reply.',
  'Endpoint uptime here is the first listed endpoint. A healthy listing did not predict the 429s.',
  '',
  `Weekly order: ${weeklyOrder ? 'yes' : 'no, size fallback'}`,
  `Stopped for an account limit: ${stoppedForAccount ? 'yes' : 'no'}`,
  `Union nonempty responses: ${summary.availability.union.responded} of ${summary.availability.union.attempted}`,
  `Roster A nonempty responses: ${summary.availability.A.responded} of ${summary.availability.A.attempted}`,
  `Roster B nonempty responses: ${summary.availability.B.responded} of ${summary.availability.B.attempted}`,
  '',
  'Shared models are counted in both roster rows and once in the union.',
  '',
];
for (const row of results) {
  if (row.notRun) {
    lines.push(`- ${row.model}: not run (${row.notRun})`);
    continue;
  }
  const endpoint = row.endpoint || {};
  lines.push(
    `- ${row.model}: http ${row.http ?? 'none'}, nonempty ${row.nonEmpty}, `
    + `${row.elapsedMs}ms, limit ${row.accountLimit || row.limitSource || 'none'}, `
    + `endpoint status ${endpoint.status ?? 'unknown'}, `
    + `uptime 5m/30m/1d ${endpoint.uptime5m ?? 'n/a'}/${endpoint.uptime30m ?? 'n/a'}/${endpoint.uptime1d ?? 'n/a'}`,
  );
}
writeFileSync(path.join(outDir, 'report.md'), `${lines.join('\n')}\n`);
console.log(
  `smoke done union ${summary.availability.union.responded}/${summary.availability.union.attempted} `
  + `A ${summary.availability.A.responded}/${summary.availability.A.attempted} `
  + `B ${summary.availability.B.responded}/${summary.availability.B.attempted}`,
);
console.log(`smoke wrote ${path.join(outDir, 'summary.json')}`);
