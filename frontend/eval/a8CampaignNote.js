// README block of an a8 campaign, built from the files the campaign wrote:
// excerpts of its report.md (made by the report code), the route snapshot and
// the host check. No new numbers and no reading of the result: the analysis
// section is written by OpenRouter models (evalAnalysis.js).
//
//   node frontend/eval/a8CampaignNote.js --run a8-open-v7 [--readme] [--after <marker>]
//   node frontend/eval/a8CampaignNote.js --run a8-open-v7 --analysis --live

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { placeAfter } from './a8RunNote.js';

const EVAL_ROOT = path.dirname(fileURLToPath(import.meta.url));
const RUNS_ROOT = path.join(EVAL_ROOT, '.runs');
const README = path.join(EVAL_ROOT, 'README.md');
export const SECTIONS = Object.freeze(['Secondary family', 'Dev selection', 'Calls by stage', 'Cost']);
export const ANALYSIS_LIMITS = Object.freeze({ maxUsd: 0.5, maxPosts: 8 });

const readJson = (file) => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null);

export function markers(run) {
  return {
    start: `<!-- ${run}-results:start -->`,
    end: `<!-- ${run}-results:end -->`,
    analysisStart: `<!-- ${run}-analysis:start -->`,
    analysisEnd: `<!-- ${run}-analysis:end -->`,
  };
}

// The report split at its "## " headings: the opening part, then each section.
export function splitReport(text) {
  const lines = String(text).replace(/\r\n/g, '\n').split('\n');
  const parts = { intro: [], sections: new Map() };
  let current = null;
  for (const line of lines.slice(1)) {
    if (line.startsWith('## ')) {
      current = line.slice(3).trim();
      parts.sections.set(current, []);
      continue;
    }
    (current ? parts.sections.get(current) : parts.intro).push(line);
  }
  const trim = (list) => list.join('\n').trim();
  return { intro: trim(parts.intro), sections: new Map([...parts.sections].map(([name, list]) => [name, trim(list)])) };
}

// The opening part without its first paragraph (the question, kept in the protocol).
export function introExcerpt(intro) {
  const paragraphs = intro.split(/\n\s*\n/);
  return paragraphs.slice(1).join('\n\n').trim();
}

export function buildBlock(run, root = RUNS_ROOT) {
  const dir = path.join(root, run);
  const reportFile = path.join(dir, 'reports', 'report.md');
  if (!existsSync(reportFile)) throw new Error(`${run} has no report yet`);
  const campaign = readJson(path.join(dir, 'campaign.json'));
  const selection = readJson(path.join(dir, 'selection.json'));
  const routesDir = path.join(root, campaign.routesInheritedFrom);
  const repin = readJson(path.join(routesDir, 'repin.json'));
  const hostcheck = readJson(path.join(routesDir, 'hostcheck.json'));
  const report = splitReport(readFileSync(reportFile, 'utf8'));
  const head = [
    `### Кампания \`${run}\` (${(campaign.primaryBlocks || []).join(', ')})`,
    '',
    `Правила — в [${run}-protocol.md](${run}-protocol.md). Ниже выдержки из \`.runs/${run}/reports/report.md\`, собранные кодом без правки; толкование — в разделе «Анализ» под блоком.`,
    '',
    `- Маршруты: снимок \`${campaign.routesInheritedFrom}\`${repin?.chosen ? `; ${repin.model} перенесён с \`${repin.checks?.[repin.model]?.pinned?.tag ?? '?'}\` на \`${repin.chosen.tag}\`` : ''}${repin?.drop?.length ? `; убраны ${repin.drop.join(', ')}` : ''}; лимит ${campaign.stageCaps?.stage1} на всех стадиях.`,
  ];
  if (hostcheck) head.push(`- Проверка хоста \`${hostcheck.tag}\` до кампании: ${hostcheck.accepted} из ${hostcheck.calls} одновременных вызовов вернулись, медиана ${Number(hostcheck.medianTokensPerSecond).toFixed(1)} токена в секунду, итог \`${hostcheck.verdict}\`.`);
  if (selection) head.push(`- Состав по dev: B = H = ${selection.b}; совет ${selection.council.join(', ')}.`);
  const body = [head.join('\n'), '', introExcerpt(report.intro)];
  for (const name of SECTIONS) {
    const key = [...report.sections.keys()].find((title) => title.startsWith(name));
    if (key) body.push('', `#### ${key}`, '', report.sections.get(key));
  }
  body.push('', 'Полный отчёт и воспроизведение без сети:', '', '```bash', `npm --prefix frontend run eval -- a8 --phase report --run ${run}`, '```');
  return body.join('\n');
}

export const CAMPAIGN_INSTRUCTION = [
  'You analyse the result of a paid evaluation campaign for the README of the project. The protocols and the report are given below as data.',
  'Write the body of a section titled "Анализ", in Russian, 150 to 300 words, as short paragraphs or a short list. No heading: the heading is added separately.',
  'Use only numbers that appear in the report. Do not introduce any other number.',
  'Cover: what the primary comparison shows under the pre-set reading rules; what the secondary family and the diagnostics add; how the roster and routes differ from earlier campaigns as the protocols state; the main limits.',
  'Do not present any follow-up experiment as decided. You may say what stays open.',
  'Return only the text of the section.',
].join('\n');

export function analysisSection(run, text, check, writer, checker) {
  return [
    '#### Анализ',
    '',
    `_Текст написала модель ${writer} через OpenRouter по \`.runs/${run}/reports/report.md\` и протоколам кампании; модель ${checker} сверила его с отчётом (замечаний: ${check.problems.length}). Claude этот текст не писал и не правил._`,
    '',
    String(text).trim(),
  ].join('\n');
}

function flagValue(argv, name) {
  const index = argv.indexOf(name);
  return index < 0 ? null : (argv[index + 1] ?? null);
}

async function runCampaignAnalysis(run) {
  const { runAnalysis } = await import('./evalAnalysis.js');
  const protocols = [`${run}-protocol.md`, 'a8-open-v6-protocol.md'].filter((name, index, list) => list.indexOf(name) === index && existsSync(path.join(EVAL_ROOT, name)));
  const rules = protocols.map((name) => `# File ${name}\n\n${readFileSync(path.join(EVAL_ROOT, name), 'utf8')}`).join('\n\n');
  const record = await runAnalysis({
    dir: path.join(RUNS_ROOT, run, 'analysis'),
    instruction: CAMPAIGN_INSTRUCTION,
    rules,
    report: readFileSync(path.join(RUNS_ROOT, run, 'reports', 'report.md'), 'utf8'),
    limits: ANALYSIS_LIMITS,
    key: String(process.env.or_key || process.env.OR_KEY || '').trim(),
  });
  console.log(`analysis spend: settled $${record.spend.settledUsd.toFixed(4)}, ${record.spend.posts} POSTs`);
  if (!record.text) {
    console.log(`analysis not placed: ${record.reason}`);
    return 2;
  }
  const { end, analysisStart, analysisEnd } = markers(run);
  const body = analysisSection(run, record.text, record.check, record.writer, record.checker);
  writeFileSync(path.join(RUNS_ROOT, run, 'analysis', 'analysis.md'), `${body}\n`, 'utf8');
  const readme = readFileSync(README, 'utf8');
  if (!readme.includes(end)) throw new Error('Place the campaign block first (--readme).');
  writeFileSync(README, placeAfter(readme, analysisStart, analysisEnd, body, end), 'utf8');
  console.log('analysis placed in README');
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const run = flagValue(argv, '--run');
  if (!run) throw new Error('--run is required');
  if (argv.includes('--analysis')) {
    if (!argv.includes('--live')) throw new Error('--analysis posts only with --live');
    process.exitCode = await runCampaignAnalysis(run);
  } else {
    const block = buildBlock(run);
    writeFileSync(path.join(RUNS_ROOT, run, 'readme-block.md'), `${block}\n`, 'utf8');
    if (argv.includes('--readme')) {
      const { start, end } = markers(run);
      const text = readFileSync(README, 'utf8');
      const next = placeAfter(text, start, end, block, flagValue(argv, '--after') || '<!-- a8-open-v6:end -->');
      if (next !== text) writeFileSync(README, next, 'utf8');
    }
    console.log(block);
  }
}
