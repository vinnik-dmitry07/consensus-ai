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

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { markers as campaignMarkers } from './a8CampaignNote.js';
import {
  ANALYSIS_END, ANALYSIS_LIMITS, ANALYSIS_START, PROTOCOL_V4, README_END, README_START, V4_INSTRUCTION, renderV4Readme, v4AnalysisSection,
} from './finishProbeV4.js';
import { placeAfter, placeAnalysis, readJson, readJsonl, rewriteFile, ruleFiles } from './noteTools.js';

const EVAL_ROOT = path.dirname(fileURLToPath(import.meta.url));
const RUN_DIR = path.join(EVAL_ROOT, '.runs', 'finish-probe-v4');
const README = path.join(EVAL_ROOT, 'README.md');
export const AFTER = campaignMarkers('a8-open-v7').analysisEnd;
export const NOTE_START = '<!-- finish-probe-v4-note:start -->';
export const NOTE_END = '<!-- finish-probe-v4-note:end -->';
const VERDICT_RU = Object.freeze({ pass: 'выполнен', fail: 'не выполнен', not_evaluable: 'не определён' });
// Each decision code and the criteria its frozen text calls "held".
export const CLAIMED_HELD = Object.freeze({ accepted_often_wrong: ['k4'], no_use_for_arms: ['k4', 'kp'], confirmed_for_arms: ['k4', 'kp', 'kw'] });

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

export function runAnalysisLive() {
  const note = readFileSync(path.join(RUN_DIR, 'readme-note.md'), 'utf8');
  return placeAnalysis({
    dir: path.join(RUN_DIR, 'analysis'),
    instruction: V4_INSTRUCTION,
    rules: `${ruleFiles(EVAL_ROOT, [PROTOCOL_V4, 'finish-probe-protocol.md'])}\n\n# Note computed from the report (README, beside the block)\n\n${note}`,
    report: readFileSync(path.join(RUN_DIR, 'report.md'), 'utf8'),
    limits: ANALYSIS_LIMITS,
    readme: README,
    start: ANALYSIS_START,
    end: ANALYSIS_END,
    after: NOTE_END,
    section: (record) => v4AnalysisSection(record.text, record.check, record.writer, record.checker),
  });
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
      rewriteFile(README, (text) => placeAfter(placeAfter(text, README_START, README_END, block, AFTER), NOTE_START, NOTE_END, note, README_END));
    }
    console.log(block);
    console.log('----');
    console.log(note);
  }
}
