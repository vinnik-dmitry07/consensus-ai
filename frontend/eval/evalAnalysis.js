// "One OpenRouter model writes, another checks" for README analysis sections,
// with a budget journal of its own. Claude does not write or edit the text:
// it is placed as the writer returned it, only after the checker found no
// problem. Used by the finish-probe summary and by later campaign reports.

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { createCampaignBudget } from './budget.js';
import { audit } from './finishProbe.js';
import { CHECKER, WRITER, checkMessages, parseCheck, poster } from './finishProbeAnalysis.js';
import { budgetedFetch } from './finishProbeV3.js';
import { sha256 } from './util.js';

const MODELS_URL = 'https://openrouter.ai/api/v1/models';
export const ROUNDS = 2;
export { CHECKER, WRITER };

function readJsonl(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

function appendJsonl(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify(value)}\n`, 'utf8');
}

export function writerMessages(instruction, rules, report, problems = null, draft = null) {
  const parts = [instruction, '', `<<<PROTOCOL\n${rules}\nPROTOCOL>>>\n\n<<<REPORT\n${report}\nREPORT>>>`];
  if (problems) parts.push('', 'Your earlier text:', `<<<TEXT\n${draft}\nTEXT>>>`, '', 'A checker found these problems. Fix them and return the whole corrected text only:', JSON.stringify(problems, null, 2));
  return [{ role: 'user', content: parts.join('\n') }];
}

// Write, check, and at most one fix. `post(model, messages, role)` returns
// { ok, content, status }. Returns the checked text or the reason there is none.
export async function writeAndCheck({ instruction, rules, report, post, writer = WRITER, checker = CHECKER, rounds = ROUNDS }) {
  let draft = null;
  let problems = null;
  for (let round = 1; round <= rounds; round += 1) {
    const written = await post(writer, writerMessages(instruction, rules, report, problems, draft), `write-${round}`);
    if (!written.ok) return { text: null, check: null, draft, reason: `writer failed: ${written.status}` };
    draft = written.content;
    const checked = await post(checker, checkMessages(rules, report, draft), `check-${round}`);
    const check = checked.ok ? parseCheck(checked.content) : null;
    if (!check) return { text: null, check: null, draft, reason: 'checker gave no valid reply' };
    if (check.ok) return { text: draft, check, rounds: round };
    problems = check.problems;
  }
  return { text: null, check: { ok: false, problems }, draft, reason: 'problems remain after the fix' };
}

async function modelPrices(ids, fetchImpl = fetch) {
  const response = await fetchImpl(MODELS_URL);
  const body = await response.json();
  const out = {};
  for (const id of ids) {
    const row = body.data.find((item) => item.id === id);
    if (!row) throw new Error(`${id} is not in the OpenRouter catalogue`);
    out[id] = row.pricing;
  }
  return out;
}

export function analysisSpend(events) {
  const budget = createCampaignBudget({ maxUsd: 1e9, maxPosts: 1e9, prices: {} });
  budget.applyJournal(events);
  return { settledUsd: budget.state.settledUsd, heldUsd: budget.state.unresolvedUsd, posts: budget.state.posts };
}

// The live run: own budget journal (`dir/budget.jsonl`), key audits before and
// after, every call in `dir/calls.jsonl`, the result in `dir/result.json`.
export async function runAnalysis({ dir, instruction, rules, report, limits, key, label = 'analysis' }) {
  if (!key) throw new Error('or_key is missing');
  mkdirSync(dir, { recursive: true });
  const budgetFile = path.join(dir, 'budget.jsonl');
  const prices = await modelPrices([WRITER, CHECKER]);
  const budget = createCampaignBudget({ ...limits, prices, onEvent: (event) => appendJsonl(budgetFile, event) });
  budget.applyJournal(readJsonl(budgetFile));
  await audit(budget, label, 'start');
  const journal = (event) => appendJsonl(path.join(dir, 'calls.jsonl'), event);
  let result;
  try {
    result = await writeAndCheck({
      instruction, rules, report,
      post: poster({ key, journal, fetchImpl: budgetedFetch({ budget, prefix: label, stamp: Date.now() }) }),
    });
  } catch (error) {
    result = { text: null, check: null, reason: error instanceof Error ? error.message : String(error) };
  }
  await audit(budget, label, 'end');
  const record = {
    ...result,
    writer: WRITER,
    checker: CHECKER,
    instructionSha: sha256(instruction),
    reportSha: sha256(report),
    rulesSha: sha256(rules),
    spend: { settledUsd: budget.state.settledUsd, heldUsd: budget.state.unresolvedUsd, posts: budget.state.posts },
  };
  writeFileSync(path.join(dir, 'result.json'), JSON.stringify(record, null, 2), 'utf8');
  return record;
}
