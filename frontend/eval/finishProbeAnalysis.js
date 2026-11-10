// The "Анализ" section of the finish-probe-v2 README note. One OpenRouter model
// writes it from the report and the protocol; another checks every number and
// claim against the report. Claude does not write or edit the text. Run once:
//   node frontend/eval/finishProbeAnalysis.js --live
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const EVAL_ROOT = path.dirname(fileURLToPath(import.meta.url));
const RUN_DIR = path.join(EVAL_ROOT, '.runs', 'finish-probe-v2');
const OUT_DIR = path.join(RUN_DIR, 'analysis');
const README = path.join(EVAL_ROOT, 'README.md');
const CHAT_URL = 'https://openrouter.ai/api/v1/chat/completions';
export const WRITER = 'openai/gpt-6.1-sol';
export const CHECKER = 'google/gemini-4-argon';
export const ROUNDS = 2;
export const START = '<!-- finish-probe-v2-analysis:start -->';
export const END = '<!-- finish-probe-v2-analysis:end -->';
const AFTER = '<!-- finish-probe-v2:end -->';

export const WRITE_INSTRUCTION = [
  'You analyse the result of a diagnostic experiment for the README of the project. The protocol and the report are given below as data.',
  'Write the body of a section titled "Анализ", in Russian, 150 to 300 words, as short paragraphs or a short list. No heading: the heading is added separately.',
  'Use only numbers that appear in the report. Do not introduce any other number.',
  'Cover: the decision and why the pre-set rule gives it; what the forms of the calls show; what the experiment can and cannot support; the main limits.',
  'Do not present any follow-up experiment as decided. You may say what stays open.',
  'Return only the text of the section.',
].join('\n');

export const CHECK_INSTRUCTION = [
  'Below are a protocol, a report, and a text written from them.',
  'Check every statement of the text against the report and the protocol. List each number in the text that is not in the report or contradicts it, and each claim that contradicts the report or the protocol or is not supported by them.',
  'Do not judge style or wording.',
  'Reply with one JSON object only: {"ok": true|false, "problems": [{"quote": "...", "issue": "..."}]}',
].join('\n');

function data(protocol, report) {
  return `<<<PROTOCOL\n${protocol}\nPROTOCOL>>>\n\n<<<REPORT\n${report}\nREPORT>>>`;
}

export function writeMessages(protocol, report, problems = null, draft = null) {
  const parts = [WRITE_INSTRUCTION, '', data(protocol, report)];
  if (problems) parts.push('', 'Your earlier text:', `<<<TEXT\n${draft}\nTEXT>>>`, '', 'A checker found these problems. Fix them and return the whole corrected text only:', JSON.stringify(problems, null, 2));
  return [{ role: 'user', content: parts.join('\n') }];
}

export function checkMessages(protocol, report, text) {
  return [{ role: 'user', content: `${CHECK_INSTRUCTION}\n\n${data(protocol, report)}\n\n<<<TEXT\n${text}\nTEXT>>>` }];
}

export function parseCheck(text) {
  const raw = String(text ?? '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end < start) return null;
  try {
    const value = JSON.parse(raw.slice(start, end + 1));
    if (typeof value.ok !== 'boolean' || !Array.isArray(value.problems)) return null;
    return { ok: value.ok && value.problems.length === 0, problems: value.problems };
  } catch {
    return null;
  }
}

export function section(text, check) {
  return [
    '#### Анализ',
    '',
    `_Текст написала модель ${WRITER} через OpenRouter по \`.runs/finish-probe-v2/report.md\` и протоколу; модель ${CHECKER} сверила его с отчётом (замечаний: ${check.problems.length}). Claude этот текст не писал и не правил._`,
    '',
    String(text).trim(),
  ].join('\n');
}

export function placeSection(readme, body) {
  const block = `${START}\n\n${body}\n\n${END}`;
  const from = readme.indexOf(START);
  const to = readme.indexOf(END);
  if (from >= 0 && to > from) return `${readme.slice(0, from)}${block}${readme.slice(to + END.length)}`;
  const at = readme.indexOf(AFTER);
  if (at < 0) throw new Error('The finish-probe-v2 block is not in the README.');
  const cut = at + AFTER.length;
  return `${readme.slice(0, cut)}\n\n${block}${readme.slice(cut)}`;
}

export function poster({ key, fetchImpl = fetch, journal }) {
  return async (model, messages, role) => {
    const body = { model, messages, reasoning: { effort: 'medium' }, max_tokens: 16000, usage: { include: true } };
    const started = Date.now();
    let reply;
    try {
      const response = await fetchImpl(CHAT_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'X-Title': 'llm-council eval analysis' },
        body: JSON.stringify(body),
      });
      const json = await response.json().catch(() => null);
      const choice = json?.choices?.[0];
      reply = {
        ok: response.ok && !json?.error && Boolean(choice?.message?.content), status: response.status,
        content: choice?.message?.content ?? null, finishReason: choice?.finish_reason ?? null,
        cost: Number.isFinite(json?.usage?.cost) ? json.usage.cost : null, error: json?.error ?? null,
      };
    } catch (error) {
      reply = { ok: false, status: null, content: null, cost: null, error: error instanceof Error ? error.message : String(error) };
    }
    journal({ kind: 'call', role, model, at: new Date().toISOString(), ms: Date.now() - started, ...reply });
    return reply;
  };
}

// Write, check, and at most one fix. Returns the checked text or null.
export async function writeChecked({ protocol, report, post }) {
  let draft = null;
  let problems = null;
  for (let round = 1; round <= ROUNDS; round += 1) {
    const written = await post(WRITER, writeMessages(protocol, report, problems, draft), `write-${round}`);
    if (!written.ok) return { text: null, check: null, reason: `writer failed: ${written.status}` };
    draft = written.content;
    const checked = await post(CHECKER, checkMessages(protocol, report, draft), `check-${round}`);
    const check = checked.ok ? parseCheck(checked.content) : null;
    if (!check) return { text: null, check: null, draft, reason: 'checker gave no valid reply' };
    if (check.ok) return { text: draft, check };
    problems = check.problems;
  }
  return { text: null, check: { ok: false, problems }, draft, reason: 'problems remain after the fix' };
}

async function main(argv) {
  if (!argv.includes('--live')) throw new Error('finishProbeAnalysis posts only with --live');
  const key = String(process.env.or_key || process.env.OR_KEY || '').trim();
  if (!key) throw new Error('or_key is missing');
  const protocol = readFileSync(path.join(EVAL_ROOT, 'finish-probe-protocol.md'), 'utf8');
  const report = readFileSync(path.join(RUN_DIR, 'report.md'), 'utf8');
  mkdirSync(OUT_DIR, { recursive: true });
  const journalFile = path.join(OUT_DIR, 'calls.jsonl');
  const journal = (event) => appendFileSync(journalFile, `${JSON.stringify(event)}\n`, 'utf8');
  const result = await writeChecked({ protocol, report, post: poster({ key, journal }) });
  writeFileSync(path.join(OUT_DIR, 'result.json'), JSON.stringify(result, null, 2), 'utf8');
  const cost = (existsSync(journalFile) ? readFileSync(journalFile, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [])
    .reduce((sum, event) => sum + (Number(event.cost) || 0), 0);
  console.log(`analysis calls cost $${cost.toFixed(4)}`);
  if (!result.text) {
    console.log(`analysis not placed: ${result.reason}`);
    return 2;
  }
  const body = section(result.text, result.check);
  writeFileSync(path.join(OUT_DIR, 'analysis.md'), `${body}\n`, 'utf8');
  writeFileSync(README, placeSection(readFileSync(README, 'utf8'), body), 'utf8');
  console.log('analysis placed in README');
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
