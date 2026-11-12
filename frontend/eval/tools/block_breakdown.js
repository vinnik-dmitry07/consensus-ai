// Breakdown of one block of a finished a8 campaign, question by question: the
// block result under each gold variant, the questions an arm missed, what each
// Stage 2 judge saw and ranked, and how often calls ended at the cap. Offline:
// it reads stored files only and makes no call. Not part of the hashed method.
//
// The reading of these tables is not written here. `--analysis --live` sends
// the report this tool builds to two OpenRouter models (evalAnalysis.js): one
// writes the section, the other checks it against the report.
//
//   node eval/tools/block_breakdown.js [--readme]
//   node eval/tools/block_breakdown.js --analysis --live

import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

import { parseCorrectnessScores, parseRankingFromText } from '../../src/engine/browser/council.js';
import { BLOCK_LABELS, orderBlocks } from '../a8Blocks.js';
import { cutReasoning, forwardText } from '../a8Variants.js';
import { loadBankTasks, questionRecords, readGold } from '../campaignData.js';
import { attributedSection, placeAnalysis, placeBefore, rewriteFile, sectionMarkers } from '../noteTools.js';

const EVAL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUNS = path.join(EVAL_ROOT, '.runs');
const README = path.join(EVAL_ROOT, 'README.md');

export const TARGET = Object.freeze({
  run: 'a8-open-v5e',
  block: 'livemath',
  goldFile: 'gold-corrections-a8-open-v5e.json',
  wideFile: 'gold-corrections-a8-open-v5e-all.json',
  // Names the README already uses for these questions.
  names: Object.freeze({
    'test:livemath-202505:q0f82e3c1061a': 'слоны',
    'test:livemath-202505:qc3e6b97f72eb': 'Jana',
    'test:livemath-202505:qd6e2cba62273': 'дуэли',
    'test:livemath-202505:qd95a2526ee6c': 'овцы',
    'test:livemath-202505:qa4de4243d9fc': 'Paul',
    'test:livemath-202505:q69bbd425dbba': '1023',
    'test:livemath-202505:qfa1834ca36fa': 'Мерлин',
  }),
  // The code checks of the block, by question.
  checks: Object.freeze({
    composite: 'test:livemath-202505:qc3e6b97f72eb',
    sheep: 'test:livemath-202505:qd95a2526ee6c',
  }),
});

// Each call carries two README sections and the report with its appendix, so
// its reserve alone is near $0.4: a $0.5 ceiling let the writer through and
// refused the checker. A call settles at well under a tenth of that reserve.
const ANALYSIS_LIMITS = Object.freeze({ maxUsd: 1, maxPosts: 8 });
// The campaign rules the analysis models get: this README section, up to the results.
const RULES_FROM = '### a8-open-v5: общий максимальный лимит, новые блоки, защита от цикла';
const RULES_TO = '### Итоги a8-open-v5e';
// The block closes the results of the campaign: it goes right before the next section.
const BEFORE = '### Диагностика: дописывание оборванных ответов (`finish-probe-v1`)';

const ARMS = ['A8', 'S8', 'P8', 'B8'];
const MODEL_NAMES = { stepfun: 'StepFun', tencent: 'hy4', deepseek: 'DeepSeek' };
const FINISH_RU = { stop: 'закончен', length: 'лимит', loop: 'цикл' };
const RESPONSES_HEAD = 'Here are the responses from different models (anonymized):';
const TASK_HEAD = '\n\nYour task:\n';

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
const nameOf = (model) => MODEL_NAMES[String(model).split('/')[0]] || String(model).split('/')[0];
const pct = (count, total) => (total ? `${(100 * count / total).toFixed(1)}%` : 'n/a');
const finishOf = (slot) => slot?.result?.finishReason ?? slot?.finishReason ?? null;
const finishRu = (finish) => FINISH_RU[finish] || finish;
const tokensOf = (slot) => slot?.usage?.completion_tokens ?? slot?.result?.usage?.completion_tokens ?? null;

export function markers(target = TARGET) {
  const tag = `${target.run}-${target.block}`;
  const block = sectionMarkers(tag);
  const analysis = sectionMarkers(`${tag}-analysis`);
  return { start: block.start, end: block.end, analysisStart: analysis.start, analysisEnd: analysis.end };
}

// The gold variants, from the report as run to every correction at once.
export function variantsOf(target, tasks, main, wide) {
  const base = (id) => tasks.get(id).goldCanon;
  return [
    { key: 'report', label: 'Исходный отчёт, без правок', gold: base, excluded: new Set() },
    { key: 'main', label: `Основной: правки из \`${target.goldFile}\``, gold: main.goldOf, excluded: new Set(main.excluded) },
    { key: 'main-less', label: 'Основной без вопросов, которые исключает полный список', gold: main.goldOf, excluded: new Set([...main.excluded, ...wide.excluded]) },
    { key: 'wide', label: `Полный список: \`${target.wideFile}\``, gold: wide.goldOf, excluded: new Set(wide.excluded) },
  ];
}

// The report's rule: a graded answer is right when its canonical form equals
// the gold in force.
export function scoreRow(row, gold) {
  const right = (answer) => (answer != null && answer === gold ? 1 : 0);
  const graded = (grade) => (grade && grade.status === 'graded' ? right(grade.extracted) : 0);
  const arms = {};
  for (const arm of ARMS) arms[arm] = graded(row.arms?.[arm]);
  return {
    arms,
    leader: graded(row.diagnostics?.leader),
    council: (row.diagnostics?.councilAnswers || []).map(right),
  };
}

export function tally(scored) {
  const out = { n: scored.length, wins: 0, losses: 0 };
  for (const arm of ARMS) out[arm] = 0;
  for (const item of scored) {
    for (const arm of ARMS) out[arm] += item.arms[arm];
    if (item.arms.A8 > item.arms.S8) out.wins += 1;
    if (item.arms.A8 < item.arms.S8) out.losses += 1;
  }
  return out;
}

const loadRows = (dir) => questionRecords(dir, 'test_').filter((row) => row.status === 'complete');

// The slot journal folded as the runtime folds it (the last event of a key
// wins). Reasoning is dropped; requests and texts are kept only where `full`
// says so, since the journal holds every prompt of the campaign.
async function readSlots(file, full) {
  const slots = new Map();
  const lines = readline.createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.startsWith('{"kind":"slot"')) continue;
    const event = JSON.parse(line);
    if (!event.key || !event.slot) continue;
    const next = { ...(slots.get(event.key) || {}), ...event.slot };
    if (next.result) {
      const { reasoning_details: _dropped, ...result } = next.result;
      next.result = full(next.meta?.questionId) ? result : { finishReason: result.finishReason, usage: result.usage };
    }
    if (!full(next.meta?.questionId)) delete next.request;
    slots.set(event.key, next);
  }
  return [...slots.values()].filter((slot) => slot.meta && slot.state === 'completed');
}

function callsByQuestion(slots) {
  const out = new Map();
  for (const slot of slots) {
    const { questionId, branch, stage } = slot.meta;
    const calls = out.get(questionId) || { stage1: [], samples: [], judges: [], A8: null, S8: null };
    if (branch === 'council' && stage === 'stage1') calls.stage1.push(slot);
    else if (branch === 'council' && stage === 'stage2') calls.judges.push(slot);
    else if (branch === 'replicates') calls.samples.push(slot);
    else if (branch === 'A8') calls.A8 = slot;
    else if (branch === 'S8') calls.S8 = slot;
    out.set(questionId, calls);
  }
  return out;
}

function stops(slots) {
  const out = { n: slots.length, cap: 0, loop: 0 };
  for (const slot of slots) {
    if (finishOf(slot) === 'length') out.cap += 1;
    if (finishOf(slot) === 'loop') out.loop += 1;
  }
  return out;
}

// The answers a judge was shown, in its own label order.
export function shownResponses(prompt) {
  const from = String(prompt).indexOf(RESPONSES_HEAD);
  const to = String(prompt).lastIndexOf(TASK_HEAD);
  if (from < 0 || to < from) return [];
  return prompt.slice(from + RESPONSES_HEAD.length, to)
    .split(/\n\n(?=Response \d+:\n)/)
    .map((part) => part.trim().match(/^Response (\d+):\n([\s\S]*)$/))
    .filter(Boolean)
    .map((match) => ({ label: `Response ${match[1]}`, text: match[2] }));
}

// The candidates the chairman was shown, best first, with their peer scores.
export function shownCandidates(prompt) {
  const text = String(prompt);
  const end = text.lastIndexOf(TASK_HEAD);
  const heads = [...text.matchAll(/Candidate #(\d+) \(score=([^,]+), correctness=([^)]+)\):\n/g)];
  return heads.map((head, index) => ({
    place: Number(head[1]),
    score: head[2],
    correctness: head[3],
    text: text.slice(head.index + head[0].length, index + 1 < heads.length ? heads[index + 1].index : end),
  }));
}

// A shown text belongs to the Stage 1 answer it ends with. A cut answer is
// shown as a marker and the tail of its reasoning, and a candidate starts with
// the judges' notes, so only the ending is compared. The longest answer is
// tried first: a bare "ANSWER: 8" is also the ending of a longer answer.
const ending = (text) => String(text || '').trim().slice(-160);

function ownerOf(text, stage1, used) {
  const shown = String(text || '').trim();
  const slot = [...stage1]
    .sort((left, right) => (right.result?.content || '').length - (left.result?.content || '').length)
    .find((item) => !used.has(item.meta.model) && shown.endsWith(ending(item.result?.content)));
  if (!slot) throw new Error('A shown answer matches no Stage 1 answer of its question');
  used.add(slot.meta.model);
  return slot.meta.model;
}

// The text of a judge reply the engine parsed: with the tail rule on, a judge
// cut in its reasoning is parsed from the end of it only (a8Variants.js).
export function engineReply(slot, rule) {
  const reply = slot.result?.content || '';
  const result = slot.result ? { ...slot.result, finishReason: finishOf(slot) } : null;
  return rule && cutReasoning(result) ? { text: forwardText(reply, rule), tail: true } : { text: reply, tail: false };
}

function judgeView(slot, stage1, rule) {
  const used = new Set();
  const shown = shownResponses(slot.request.messages[0].content).map((item) => ({ label: item.label, model: ownerOf(item.text, stage1, used) }));
  const modelOf = new Map(shown.map((item) => [item.label, item.model]));
  const { text: reply, tail } = engineReply(slot, rule);
  const scores = parseCorrectnessScores(reply);
  // The engine keeps the first mention of each label; with no FINAL RANKING
  // line its parser falls back to the order of mentions in the whole reply.
  const order = [...new Set(parseRankingFromText(reply))].filter((label) => modelOf.has(label)).map((label) => modelOf.get(label));
  return {
    judge: slot.meta.model,
    saw: shown.map((item) => item.model),
    scores: shown.map((item) => ({ model: item.model, score: scores[item.label] ?? null })),
    order,
    rankingLine: /FINAL RANKING/i.test(reply),
    tail,
    finish: finishOf(slot),
    tokens: tokensOf(slot),
  };
}

function chairmanView(slot, stage1) {
  const used = new Set();
  return shownCandidates(slot.request.messages[0].content).map((item) => ({
    place: item.place, score: item.score, correctness: item.correctness, model: ownerOf(item.text, stage1, used),
  }));
}

function isComposite(value) {
  if (value < 4) return false;
  for (let divisor = 2; divisor * divisor <= value; divisor += 1) if (value % divisor === 0) return true;
  return false;
}

// Every reading of the sheep question (qd95a) with the first sheep at second
// 0: a sheep every k seconds, k from 3 to 100; a thunderclap every T seconds,
// T a multiple of k up to 200; the first clap on the sheep of second a, a from
// 0 to 100. A sheep under a clap is subtracted, any other is added. The
// statement fixes the count: 8 after second 60 and 12 after second 100.
export function sheepFits() {
  const fits = [];
  for (let k = 3; k <= 100; k += 1) {
    for (let period = k; period <= 200; period += k) {
      for (let first = 0; first <= 100; first += k) {
        const clap = (second) => second >= first && (second - first) % period === 0;
        const count = (until) => {
          let total = 0;
          for (let second = 0; second <= until; second += k) total += clap(second) ? -1 : 1;
          return total;
        };
        if (count(60) !== 8 || count(100) !== 12) continue;
        // fromStart: the thunder runs from the start of the count, so its
        // first clap comes less than one period after the first sheep.
        fits.push({ k, period, first, fromStart: first < period, onFirstSheep: first === 0, at60: 60 % k === 0 && clap(60), at100: 100 % k === 0 && clap(100) });
      }
    }
  }
  return fits;
}

function shortId(id) {
  return String(id).split(':').pop().slice(0, 5);
}

async function buildData(target = TARGET) {
  const dir = path.join(RUNS, target.run);
  const campaign = readJson(path.join(dir, 'campaign.json'));
  const selection = readJson(path.join(dir, 'selection.json'));
  const tasks = loadBankTasks();
  const main = readGold(readJson(path.join(EVAL_ROOT, target.goldFile)), tasks);
  const wide = readGold(readJson(path.join(EVAL_ROOT, target.wideFile)), tasks);
  const variants = variantsOf(target, tasks, main, wide);
  const primary = campaign.primaryBlocks || [];
  const testDir = path.join(dir, 'comparison', 'test');
  const rows = loadRows(testDir).filter((row) => primary.includes(row.block));
  const council = selection.council;

  // The rule above must give back the grades the campaign stored.
  for (const row of rows) {
    const stored = scoreRow(row, variants[0].gold(row.id));
    for (const arm of ARMS) {
      if (stored.arms[arm] !== (row.arms?.[arm]?.correct === 1 ? 1 : 0)) throw new Error(`${row.id}: ${arm} regrades differently from the stored grade`);
    }
  }

  const inBlock = rows.filter((row) => row.block === target.block);
  const blockIds = new Set(inBlock.map((row) => row.id));
  const slots = await readSlots(path.join(testDir, 'events.jsonl'), (id) => blockIds.has(id));
  const calls = callsByQuestion(slots);
  const label = (id) => (target.names[id] ? `${target.names[id]} (\`${shortId(id)}\`)` : `\`${shortId(id)}\``);

  const variantTable = variants.map((variant) => {
    const kept = inBlock.filter((row) => !variant.excluded.has(row.id));
    return { key: variant.key, label: variant.label, ...tally(kept.map((row) => scoreRow(row, variant.gold(row.id)))) };
  });

  // What each corrections file does to the questions of this block.
  const changes = [];
  for (const row of inBlock) {
    const base = tasks.get(row.id).goldCanon;
    const act = (set) => (set.excluded.has(row.id) ? 'исключён' : set.gold.has(row.id) ? `эталон ${shortAnswer(base)} → ${shortAnswer(set.gold.get(row.id))}` : null);
    const inMain = act(main);
    const inWide = act(wide);
    if (inMain) changes.push({ id: row.id, where: 'основной и полный', action: inMain, reason: main.reasons.get(row.id) });
    else if (inWide) changes.push({ id: row.id, where: 'только полный', action: inWide, reason: wide.reasons.get(row.id) });
  }

  const mainVariant = variants[1];
  const scoredMain = new Map(rows.filter((row) => !mainVariant.excluded.has(row.id)).map((row) => [row.id, scoreRow(row, mainVariant.gold(row.id))]));
  const answersOf = (row) => council.map((model, index) => ({ model, answer: row.diagnostics?.councilAnswers?.[index] ?? null }));
  const differ = (row) => new Set((row.diagnostics?.councilAnswers || []).filter((answer) => answer != null)).size >= 2;
  const synth = (slot) => ({ finish: finishOf(slot), tokens: tokensOf(slot) });
  // The A8 or S8 arm of a row as stored, with its synthesis call.
  const armCell = (row, arm, slot) => ({ status: row.arms[arm].status, extracted: row.arms[arm].extracted ?? null, ...synth(slot) });

  const misses = [];
  const judges = [];
  const appendix = [];
  for (const row of inBlock) {
    const score = scoredMain.get(row.id);
    if (!score) continue;
    const own = calls.get(row.id);
    if (!own || own.stage1.length !== council.length || own.judges.length !== council.length || !own.A8 || !own.S8) throw new Error(`${row.id}: the journal does not hold one completed call per stage`);
    const stage1 = council.map((model) => own.stage1.find((slot) => slot.meta.model === model));
    const samples = [stage1[council.indexOf(selection.b)], ...own.samples];
    if (score.arms.A8 === 0 || score.arms.S8 === 0) {
      misses.push({
        id: row.id,
        gold: mainVariant.gold(row.id),
        council: answersOf(row),
        leader: row.diagnostics?.leader?.extracted ?? null,
        A8: { ...armCell(row, 'A8', own.A8), right: score.arms.A8 },
        S8: { ...armCell(row, 'S8', own.S8), right: score.arms.S8 },
        samples: row.diagnostics?.replicateAnswers || [],
        stops: { stage1: stops(stage1), samples: stops(samples), judges: stops(own.judges) },
      });
    }
    if (differ(row)) {
      judges.push({
        id: row.id,
        gold: mainVariant.gold(row.id),
        answers: answersOf(row),
        views: council.map((model) => judgeView(own.judges.find((slot) => slot.meta.model === model), stage1, campaign.tailRule)),
        candidates: chairmanView(own.A8, stage1),
      });
    }
    if (score.arms.A8 !== score.arms.S8) {
      appendix.push({
        id: row.id,
        stem: tasks.get(row.id).stem,
        stage1: stage1.map((slot, index) => ({ model: slot.meta.model, finish: finishOf(slot), answer: row.diagnostics?.councilAnswers?.[index] ?? null, text: slot.result?.content || '' })),
        judges: own.judges.map((slot) => ({ model: slot.meta.model, finish: finishOf(slot), text: slot.result?.content || '' })),
        ...Object.fromEntries(['A8', 'S8'].map((arm) => [arm, { ...synth(own[arm]), status: row.arms[arm].status, text: own[arm].result?.content || '' }])),
      });
    }
  }

  // The same counts for every primary block, under the main variant.
  const blocks = orderBlocks(primary).map((block) => {
    const kept = rows.filter((row) => row.block === block && scoredMain.has(row.id));
    const { wins, losses } = tally(kept.map((row) => scoredMain.get(row.id)));
    const out = { block, n: kept.length, wins, losses, differ: 0, differLeader: 0, differA8: 0, differS8: 0, missedRight: 0, fixed: 0, broke: 0 };
    for (const row of kept) {
      const score = scoredMain.get(row.id);
      if (differ(row)) {
        out.differ += 1;
        out.differLeader += score.leader;
        out.differA8 += score.arms.A8;
        out.differS8 += score.arms.S8;
      }
      if (score.council.includes(1) && !score.leader) out.missedRight += 1;
      if (!score.leader && score.arms.A8) out.fixed += 1;
      if (score.leader && !score.arms.A8) out.broke += 1;
    }
    const stage1 = kept.flatMap((row) => calls.get(row.id)?.stage1 ?? []);
    out.stage1 = council.map((model) => ({ model, ...stops(stage1.filter((slot) => slot.meta.model === model)) }));
    return out;
  });

  const checks = [];
  const inBlockRow = (kind) => {
    const found = inBlock.find((row) => row.id === target.checks[kind]);
    if (!found) throw new Error(`${target.checks[kind]} (${kind} check) is not a question of ${target.block}`);
    return found;
  };
  const jana = inBlockRow('composite');
  checks.push({ kind: 'composite', id: jana.id, answers: answersOf(jana).map((item) => ({ ...item, next: Number(item.answer) + 1, composite: isComposite(Number(item.answer) + 1) })) });
  checks.push({ kind: 'sheep', id: inBlockRow('sheep').id, fits: sheepFits() });

  return {
    target,
    label,
    config: {
      b: selection.b, h: selection.h, council,
      selfExclusion: campaign.selfExclusion, topK: campaign.topK, redTeam: campaign.redTeam ?? null,
      cap: campaign.stageCaps?.stage1, tailChars: campaign.tailRule?.chars ?? null, shownToJudge: [...new Set(judges.flatMap((item) => item.views.map((view) => view.saw.length)))].sort(),
    },
    variantTable, changes, misses, judges, blocks, checks, appendix,
  };
}

function shortAnswer(value) {
  if (value == null) return '—';
  const text = String(value);
  return text.length > 16 ? `${text.slice(0, 6)}…${text.slice(-4)} (${text.length} цифр)` : text;
}

function armText(cell) {
  if (cell.status === 'graded') return `${shortAnswer(cell.extracted)} ${cell.right ? '✓' : '✗'}`;
  return cell.extracted ? `\`${cell.extracted}\`, не разобран ✗` : 'нет ответа ✗';
}

function synthText(cell) {
  return `${finishRu(cell.finish)}${cell.tokens ? `, ${cell.tokens}` : ''}`;
}

function stopsText(item) {
  return `${item.cap}/${item.n}${item.loop ? ` и цикл ${item.loop}` : ''}`;
}

function renderBlock(data) {
  const { target, label, config } = data;
  const title = BLOCK_LABELS[target.block] || target.block;
  const lines = [
    `#### ${title} по вопросам (\`${target.run}\`)`,
    '',
    `Разбор блока ${title} по сохранённым файлам \`${target.run}\`. Новых вызовов нет: таблицы собраны кодом \`tools/block_breakdown.js\` из файлов вопросов, журнала вызовов и файлов правок эталонов; скрипт не входит в хешируемый метод. Ответ верен, как в отчёте кампании, если его каноническая запись равна эталону в силе. Толкование — в разделе «Анализ» под блоком.`,
    '',
    `Состав: B = председатель = \`${config.h}\`; совет ${config.council.map((model) => `\`${model}\``).join(', ')}. Исключение ответов своего вендора у судьи ${config.selfExclusion ? 'включено' : 'выключено'}; на вопросах, где совет разошёлся, каждый судья видел ответов: ${config.shownToJudge.join(' или ') || 'n/a'}. Председателю идут первые ${config.topK} кандидата. Red team ${config.redTeam ? `\`${config.redTeam}\`` : 'выключен'}. Лимит ${config.cap} токенов на каждой стадии.`,
    '',
    '**Результат блока по вариантам эталонов.**',
    '',
    '| Вариант | Вопросов | A8 | S8 | P8 | B8 | A8 лучше / S8 лучше |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...data.variantTable.map((row) => `| ${row.label} | ${row.n} | ${ARMS.map((arm) => `${row[arm]} (${pct(row[arm], row.n)})`).join(' | ')} | ${row.wins} / ${row.losses} |`),
    '',
    'Что правки меняют в этом блоке (причины — дословно из файлов правок):',
    '',
    ...data.changes.map((item) => `- ${label(item.id)}, ${item.where} список: ${item.action}. «${item.reason}»`),
  ];
  lines.push(
    '',
    `**Вопросы, где A8 или S8 ошиблись (основной вариант).** Ответы Stage 1 идут в порядке ${config.council.map(nameOf).join(' / ')}; «—» значит, что в ответе нет разобранной последней строки. «На лимите» — сколько вызовов кончились на лимите токенов: ответы Stage 1; выборки B (первая — тот же ответ Stage 1 модели B); судьи. «Цикл» — вызов остановлен детектором цикла. В колонках синтеза — чем кончился вызов и сколько токенов он выдал.`,
    '',
    '| Вопрос | Эталон | Stage 1 | Лидер Stage 2 | A8 | S8 | Выборки B | На лимите: Stage 1; B; судьи | Синтез A8 | Синтез S8 |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...data.misses.map((row) => `| ${label(row.id)} | ${shortAnswer(row.gold)} | ${row.council.map((item) => shortAnswer(item.answer)).join(' / ')} | ${shortAnswer(row.leader)} | ${armText(row.A8)} | ${armText(row.S8)} | ${row.samples.map(shortAnswer).join(', ')} | ${stopsText(row.stops.stage1)}; ${stopsText(row.stops.samples)}; ${stopsText(row.stops.judges)} | ${synthText(row.A8)} | ${synthText(row.S8)} |`),
    '',
    `**Судьи на вопросах, где совет дал разные разобранные ответы.** Первое место — первая метка, которую разбор движка прочёл в ответе судьи.${data.judges.some((item) => item.views.some((view) => view.tail)) ? ` Судью, оборванного в рассуждении, движок разбирал только по последним ${config.tailChars} символам (правило хвоста); такие ячейки помечены «по хвосту».` : ''}`,
    '',
    '| Вопрос | Эталон | Судья | Видел ответы | Оценки корректности | Первое место | Ответ судьи |',
    '| --- | --- | --- | --- | --- | --- | --- |',
  );
  for (const item of data.judges) {
    const answer = new Map(item.answers.map((entry) => [entry.model, entry.answer]));
    const show = (model) => `${nameOf(model)}: ${shortAnswer(answer.get(model))}`;
    for (const view of item.views) {
      const how = [view.tail ? 'по хвосту' : null, view.rankingLine ? null : 'строки FINAL RANKING нет, порядок по упоминаниям'].filter(Boolean).join('; ');
      const first = view.order.length ? `${show(view.order[0])}${how ? ` (${how})` : ''}` : `не разобрано${view.tail ? ' (по хвосту)' : ''}`;
      lines.push(`| ${label(item.id)} | ${shortAnswer(item.gold)} | ${nameOf(view.judge)} | ${view.saw.map(show).join('; ')} | ${view.scores.map((entry) => `${nameOf(entry.model)} ${entry.score ?? 'нет'}`).join('; ')} | ${first} | ${synthText(view)} |`);
    }
  }
  lines.push('', 'Порядок кандидатов, который получил председатель (балл судей и средняя корректность — из его запроса):', '');
  for (const item of data.judges) {
    const answer = new Map(item.answers.map((entry) => [entry.model, entry.answer]));
    lines.push(`- ${label(item.id)}: ${item.candidates.map((entry) => `№${entry.place} ${nameOf(entry.model)} (${shortAnswer(answer.get(entry.model))}), балл ${entry.score}, корректность ${entry.correctness}`).join('; ')}.`);
  }
  lines.push(
    '',
    '**Те же счётчики по всем новым блокам (основной вариант).** «Исправил» — лидер Stage 2 неверен, A8 верен; «испортил» — лидер верен, A8 неверен.',
    '',
    `| Блок | Вопросов | A8 лучше / S8 лучше | Совет дал разные разобранные ответы | из них верны: лидер, A8, S8 | Верный ответ был в совете, лидер неверен | Председатель исправил / испортил | Stage 1 на лимите: ${config.council.map(nameOf).join(', ')} |`,
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
    ...data.blocks.map((row) => `| ${BLOCK_LABELS[row.block] || row.block} | ${row.n} | ${row.wins} / ${row.losses} | ${row.differ} | ${row.differLeader}, ${row.differA8}, ${row.differS8} | ${row.missedRight} | ${row.fixed} / ${row.broke} | ${row.stage1.map((item) => `${item.cap}/${item.n}`).join(', ')} |`),
    '',
    '**Проверки кодом.**',
    '',
  );
  for (const check of data.checks) {
    if (check.kind === 'composite') {
      lines.push(`- ${label(check.id)}: ответы совета ${check.answers.map((item) => item.answer).join(', ')}; n + 1 = ${check.answers.map((item) => item.next).join(', ')}; составные: ${check.answers.map((item) => (item.composite ? 'да' : 'нет')).join(', ')}.`);
    }
    if (check.kind === 'sheep') {
      lines.push(
        `- ${label(check.id)}: перебор всех чтений с первой овцой в нулевую секунду, где каждый удар грома приходится на овцу (шаг овец от 3 до 100 секунд, период грома до 200 секунд, первый удар с 0-й по 100-ю секунду). Условие — счёт 8 после 60-й секунды и 12 после 100-й — выполняют ${check.fits.length} варианта:`,
        '',
        '| Шаг овец | Период грома | Первый удар, секунда | Гром идёт с начала счёта (первый удар раньше одного периода) | Удар на первой овце | Удар на 60-й секунде | Удар на 100-й секунде |',
        '| --- | --- | --- | --- | --- | --- | --- |',
        ...check.fits.map((fit) => `| ${fit.k} | ${fit.period} | ${fit.first} | ${fit.fromStart ? 'да' : 'нет'} | ${fit.onFirstSheep ? 'да' : 'нет'} | ${fit.at60 ? 'да' : 'нет'} | ${fit.at100 ? 'да' : 'нет'} |`),
      );
    }
  }
  lines.push('', 'Воспроизведение без сети (из `frontend/`):', '', '```bash', 'node eval/tools/block_breakdown.js --readme', '```');
  return lines.join('\n');
}

function clip(text, max) {
  const value = String(text || '').trim();
  if (value.length <= max) return value;
  return `${value.slice(0, max / 2)}\n[… пропущено ${value.length - max} символов …]\n${value.slice(-max / 2)}`;
}

// The block and, for the questions where the two arms differ, the stored texts
// the analysis models may quote from. A call cut before a final answer holds
// its reasoning, not an answer, so only its ending is given.
function renderReport(data) {
  const { label } = data;
  const lines = [renderBlock(data), '', '## Приложение: сохранённые тексты по вопросам, где A8 и S8 разошлись (основной вариант)'];
  const body = (item, max) => (item.finish === 'stop' ? clip(item.text, max) : `[вызов кончился так: ${finishRu(item.finish)}; текст ниже — конец того, что он успел выдать]\n${clip(item.text, max).slice(-1500)}`);
  for (const item of data.appendix) {
    lines.push('', `### ${label(item.id)}`, '', 'Условие:', '', item.stem.trim());
    for (const call of item.stage1) lines.push('', `Ответ Stage 1, ${nameOf(call.model)} (${finishRu(call.finish)}; разобранный ответ: ${shortAnswer(call.answer)}):`, '', body(call, 3000));
    for (const call of item.judges) lines.push('', `Судья ${nameOf(call.model)} (${finishRu(call.finish)}):`, '', clip(call.text, 6000));
    lines.push('', `Председатель A8 (${synthText(item.A8)}; оценка: ${item.A8.status}):`, '', body(item.A8, 5000));
    lines.push('', `Синтез S8 (${synthText(item.S8)}; оценка: ${item.S8.status}):`, '', body(item.S8, 5000));
  }
  return lines.join('\n');
}

const INSTRUCTION = [
  'You analyse one block of a finished paid evaluation campaign for the README of the project. Given below as data: under PROTOCOL, the README sections with the rules of the campaign and with its results as written so far; under REPORT, a report on the block built by code, with stored texts in its appendix.',
  'Write the body of a section titled "Анализ", in Russian, 250 to 450 words, as short paragraphs or a short list. No heading: the heading is added separately.',
  'Use only numbers that appear in the report. Do not introduce any other number.',
  'Cover: why arm A8 scored below arm S8 on this block, question by question where the two arms differ, using the judges\' rankings, the way each call ended and the stored texts in the appendix; which misses both arms share; what each gold variant changes in the block result and why that variant exists; what this block cannot show.',
  'Keep apart what the stored data show and what would be a guess. Do not decide which reading of a disputed question is right beyond what the corrections files, the results section and the code checks in the report state.',
  'Do not present any follow-up experiment as decided. You may say what stays open.',
  'Return only the text of the section.',
].join('\n');

export function analysisSection(target, record) {
  const basis = `\`.runs/${target.run}/reports/block-${target.block}.md\` (блок выше и сохранённые тексты ответов) и по разделам этого README о правилах и итогах кампании`;
  return attributedSection('Анализ блока', basis, 'с ними', record);
}

// What the analysis models get as rules: the campaign section of the README
// and its results section up to this block, where the corrections files, the
// sensitivity rows and the blind labelling are described.
export function rulesOf(readme, start) {
  const from = readme.indexOf(RULES_FROM);
  const to = readme.indexOf(RULES_TO);
  const stop = readme.indexOf(start);
  if (from < 0 || to < from || stop < to) throw new Error('The campaign sections are not in the README before the block');
  const title = (heading) => heading.replace(/^#+\s*/, '');
  return [
    `# File README.md, section "${title(RULES_FROM)}"\n\n${readme.slice(from, to).trim()}`,
    `# File README.md, section "${title(RULES_TO)}", up to the block the report is built from\n\n${readme.slice(to, stop).trim()}`,
  ].join('\n\n');
}

function runBlockAnalysis(target) {
  const reportFile = path.join(RUNS, target.run, 'reports', `block-${target.block}.md`);
  if (!existsSync(reportFile)) throw new Error('Build the block first (run without --analysis).');
  const { start, end, analysisStart, analysisEnd } = markers(target);
  const readme = readFileSync(README, 'utf8').replace(/\r\n/g, '\n');
  if (!readme.includes(end)) throw new Error('Place the block first (--readme).');
  return placeAnalysis({
    dir: path.join(RUNS, target.run, `analysis-block-${target.block}`),
    instruction: INSTRUCTION,
    rules: rulesOf(readme, start),
    report: readFileSync(reportFile, 'utf8'),
    limits: ANALYSIS_LIMITS,
    label: `block-${target.block}`,
    readme: README,
    start: analysisStart,
    end: analysisEnd,
    after: end,
    section: (record) => analysisSection(target, record),
  });
}

async function main(argv) {
  if (argv.includes('--analysis')) {
    if (!argv.includes('--live')) throw new Error('--analysis posts only with --live');
    return runBlockAnalysis(TARGET);
  }
  const data = await buildData(TARGET);
  const block = renderBlock(data);
  const reports = path.join(RUNS, TARGET.run, 'reports');
  mkdirSync(reports, { recursive: true });
  writeFileSync(path.join(reports, `block-${TARGET.block}.md`), `${renderReport(data)}\n`, 'utf8');
  if (argv.includes('--readme')) {
    // Markers already in the README are refilled; otherwise the block goes
    // right before the heading that follows the results of the campaign.
    const { start, end } = markers(TARGET);
    rewriteFile(README, (text) => placeBefore(text, start, end, block, BEFORE));
  }
  console.log(block);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
