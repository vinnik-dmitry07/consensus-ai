// README text of finish-probe-v4, kept outside the frozen V4_FILES so that the
// freeze of v4 holds. It renders the block with the frozen renderV4Readme from
// report.json, places it after the a8-open-v7 analysis, and adds a note that
// the code computes: the launches, the cells not measured, and a wording fix
// where the frozen decision text names a criterion "held" that was not
// evaluable. The analysis is written and checked by OpenRouter models with
// that note among its inputs.
//
//   node frontend/eval/finishProbeV4Readme.js --readme
//   node frontend/eval/finishProbeV4Readme.js --analysis --live

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { placeAfter } from './a8RunNote.js';
import {
  ANALYSIS_END, ANALYSIS_START, PROTOCOL_V4, README_END, README_START, V4_INSTRUCTION, renderV4Readme, v4AnalysisSection,
} from './finishProbeV4.js';

const EVAL_ROOT = path.dirname(fileURLToPath(import.meta.url));
const RUN_DIR = path.join(EVAL_ROOT, '.runs', 'finish-probe-v4');
const README = path.join(EVAL_ROOT, 'README.md');
export const AFTER = '<!-- a8-open-v7-analysis:end -->';
export const NOTE_START = '<!-- finish-probe-v4-note:start -->';
export const NOTE_END = '<!-- finish-probe-v4-note:end -->';
const VERDICT_RU = Object.freeze({ pass: 'выполнен', fail: 'не выполнен', not_evaluable: 'не определён' });
// Each decision code and the criteria its frozen text calls "held".
export const CLAIMED_HELD = Object.freeze({ accepted_often_wrong: ['k4'], no_use_for_arms: ['k4', 'kp'], confirmed_for_arms: ['k4', 'kp', 'kw'] });

const readJson = (file) => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null);
const readJsonl = (file) => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []);

// Pure: the note from the report and the stops of the run.
export function buildNote({ result }, stops) {
  const lines = [];
  const runs = stops.filter((row) => row.kind === 'run');
  if (runs.length > 1) {
    lines.push(`- Запусков прогона: ${runs.length}; ${runs.map((row, index) => `${index + 1}-й закончился \`${row.end}\`${row.blocked?.length ? ` (маршрут не спрашивался до конца запуска: ${row.blocked.join(', ')})` : ''}`).join('; ')}. Новый запуск заново читает список хостов, как в правиле v3.`);
  }
  const unmeasured = result.forms.rows.reduce((sum, row) => sum + row['not measured'], 0) + result.forms.syntheses['not measured'];
  const waiting = result.forms.rows.reduce((sum, row) => sum + row['not sent or waiting'], 0) + result.forms.syntheses['not sent or waiting'];
  lines.push(`- Ячеек без измерения (отказ до генерации, например 404 «No endpoints found»): ${unmeasured}; не отправлено: ${waiting}.`);
  const claimed = CLAIMED_HELD[result.decision.code] || [];
  const wrong = claimed.filter((name) => result[name]?.verdict !== 'pass');
  if (wrong.length) {
    lines.push(`- Поправка к формулировке решения: текст замороженного кода называет ${wrong.map((name) => name.toUpperCase()).join(' и ')} выполненным, а по отчёту ${wrong.map((name) => `${name.toUpperCase()} ${VERDICT_RU[result[name].verdict]}`).join(', ')}. Решение дано правилом протокола: решает первый проваленный критерий в порядке K4, KP, KW. Код v4 не правится, иначе сменится его хэш.`);
  }
  return lines.join('\n');
}

export async function runAnalysisLive() {
  const report = readFileSync(path.join(RUN_DIR, 'report.md'), 'utf8');
  const note = readFileSync(path.join(RUN_DIR, 'readme-note.md'), 'utf8');
  const { runAnalysis } = await import('./evalAnalysis.js');
  const rules = [
    ...[PROTOCOL_V4, 'finish-probe-protocol.md'].map((name) => `# File ${name}\n\n${readFileSync(path.join(EVAL_ROOT, name), 'utf8')}`),
    `# Note computed from the report (README, beside the block)\n\n${note}`,
  ].join('\n\n');
  const record = await runAnalysis({
    dir: path.join(RUN_DIR, 'analysis'), instruction: V4_INSTRUCTION, rules, report,
    limits: { maxUsd: 0.5, maxPosts: 8 }, key: String(process.env.or_key || process.env.OR_KEY || '').trim(),
  });
  console.log(`analysis spend: settled $${record.spend.settledUsd.toFixed(4)}, ${record.spend.posts} POSTs`);
  if (!record.text) {
    console.log(`analysis not placed: ${record.reason}`);
    return 2;
  }
  const body = v4AnalysisSection(record.text, record.check, record.writer, record.checker);
  writeFileSync(path.join(RUN_DIR, 'analysis', 'analysis.md'), `${body}\n`, 'utf8');
  const text = readFileSync(README, 'utf8');
  if (!text.includes(NOTE_END)) throw new Error('Place the v4 block and note first (--readme).');
  writeFileSync(README, placeAfter(text, ANALYSIS_START, ANALYSIS_END, body, NOTE_END), 'utf8');
  console.log('analysis placed in README');
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  if (argv.includes('--analysis')) {
    if (!argv.includes('--live')) throw new Error('--analysis posts only with --live');
    process.exitCode = await runAnalysisLive();
  } else {
    const built = readJson(path.join(RUN_DIR, 'report.json'));
    if (!built) throw new Error('Build the v4 report first.');
    const block = renderV4Readme(built);
    const note = buildNote(built, readJsonl(path.join(RUN_DIR, 'stops.jsonl')));
    writeFileSync(path.join(RUN_DIR, 'readme-note.md'), `${note}\n`, 'utf8');
    if (argv.includes('--readme')) {
      let text = readFileSync(README, 'utf8');
      text = placeAfter(text, README_START, README_END, block, AFTER);
      text = placeAfter(text, NOTE_START, NOTE_END, note, README_END);
      writeFileSync(README, text, 'utf8');
    }
    console.log(block);
    console.log('----');
    console.log(note);
  }
}
