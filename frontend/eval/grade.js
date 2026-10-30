import { ANSWER_INSTRUCTIONS } from './protocol.js';

const ANSWER_LINE = /^ANSWER:\s*(.*?)\s*$/i;
const REFUSAL = /\b(i cannot|i can't|i can’t|i won't|i will not answer|as an ai)\b/i;

export function answerPrompt(task) {
  const lines = [ANSWER_INSTRUCTIONS, '', 'Question:', task.stem];
  if (Array.isArray(task.options) && task.options.length) {
    lines.push('');
    for (const option of task.options) lines.push(`${option.letter}. ${option.text}`);
  }
  return lines.join('\n');
}

function lastNonEmptyLine(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lines[index].trim() !== '') return lines[index];
  }
  return '';
}

export function extractFinalAnswer(text) {
  const line = lastNonEmptyLine(text);
  if (!line) return { status: 'parse_error', raw: null };
  const match = line.match(ANSWER_LINE);
  if (!match || match[1].trim() === '') {
    if (REFUSAL.test(String(text ?? ''))) return { status: 'refusal', raw: null };
    return { status: 'parse_error', raw: null };
  }
  return { status: 'ok', raw: match[1].trim() };
}

export function canonAnswer(raw, task) {
  if (task.kind === 'integer') {
    if (!/^\d{1,3}$/.test(raw)) return null;
    const value = Number(raw);
    if (!Number.isInteger(value) || value > 999) return null;
    return String(value);
  }
  if (task.kind === 'choice') {
    if (!/^[A-Za-z]$/.test(raw)) return null;
    const letter = raw.toUpperCase();
    const index = letter.charCodeAt(0) - 65;
    if (index < 0 || index >= task.choiceCount) return null;
    return letter;
  }
  return null;
}

// Frozen with the answer-complete layer. A change here is a different reading.
export const LENIENT_RULES = 'lenient-v1: strict last-line ANSWER; else the last ANSWER line if it holds one candidate after stripping bold, parens, boxed, and trailing punctuation; else the last boxed value; else a last-line "answer is" immediately followed by one candidate; two candidates or a negated answer are not read';

const PROSE_ANSWER = /(?:final answer|correct option|correct choice|answer)\s+(?:is|:)\s*/i;

function stripDecorations(raw) {
  let text = String(raw ?? '');
  let prev = '';
  while (text !== prev) {
    prev = text;
    text = text.replace(/\\boxed\{([^{}]*)\}/g, ' $1 ');
    text = text.replace(/\\text\{([^{}]*)\}/g, ' $1 ');
  }
  text = text.replace(/[*_`$]/g, '');
  let again = '';
  while (text !== again) {
    again = text;
    text = text.trim().replace(/^\(+/, '').replace(/\)+$/, '').replace(/[.)]+$/g, '').trim();
  }
  return text;
}

function integerCandidates(text) {
  const found = [];
  const re = /(^|[^\d.])\+?(\d{1,3})(?:\.0+)?(?![\d.])/g;
  let match = re.exec(text);
  while (match) {
    const value = String(Number(match[2]));
    if (!found.includes(value)) found.push(value);
    match = re.exec(text);
  }
  return found;
}

function choiceLetter(raw, task) {
  if (task.kind !== 'choice' || !/^[A-Za-z]$/.test(raw)) return null;
  const letter = raw.toUpperCase();
  const index = letter.charCodeAt(0) - 65;
  if (index < 0 || index >= task.choiceCount) return null;
  return letter;
}

function leadingChoice(text, task) {
  const match = text.match(/^([A-Za-z])(.*)$/);
  if (!match) return null;
  const letter = choiceLetter(match[1], task);
  if (!letter) return null;
  if (match[2] !== '' && !/^[\s.):]/.test(match[2])) return null;
  return { letter, rest: match[2] };
}

function openingPair(text, task) {
  const match = text.match(/^([A-Za-z])\s*(?:or|\/)\s*\(?([A-Za-z])(?![A-Za-z])/i);
  if (!match) return false;
  const left = choiceLetter(match[1], task);
  const right = choiceLetter(match[2], task);
  return Boolean(left && right && left !== right);
}

function trailingAlternative(rest, letter, task) {
  const match = rest.match(/^\s*(?:,\s*)?(?:and|or|\/)\s+\(?([A-Za-z])(?![A-Za-z])\s*$/i);
  if (!match) return false;
  const other = choiceLetter(match[1], task);
  return Boolean(other && other !== letter);
}

function isolatedLetters(text, task) {
  const found = [];
  const re = /(^|[^A-Za-z])([A-Za-z])(?![A-Za-z])/g;
  let match = re.exec(text);
  while (match) {
    const letter = choiceLetter(match[2], task);
    if (letter && !found.includes(letter)) found.push(letter);
    match = re.exec(text);
  }
  return found;
}

function readInteger(text) {
  const lead = text.match(/^\+?(\d{1,3})(?:\.0+)?(?:\.(?!\d))?(?=$|[\s)])/);
  if (lead) {
    const rest = text.slice(lead[0].length);
    if (/(?:\bor\b|\band\b|\/)\s*\+?\d{1,3}\b/i.test(rest)) return { value: null, ambiguous: true };
    return { value: String(Number(lead[1])), ambiguous: false };
  }
  const values = integerCandidates(text);
  if (values.length > 1) return { value: null, ambiguous: true };
  if (values.length === 1) return { value: values[0], ambiguous: false };
  return { value: null, ambiguous: false };
}

function parsePayload(raw, task) {
  const text = stripDecorations(raw);
  if (!text) return { value: null, ambiguous: false };
  if (task.kind === 'integer') return readInteger(text);
  if (task.kind === 'choice') {
    if (openingPair(text, task)) return { value: null, ambiguous: true };
    const lead = leadingChoice(text, task);
    if (lead) {
      if (trailingAlternative(lead.rest, lead.letter, task)) return { value: null, ambiguous: true };
      return { value: lead.letter, ambiguous: false };
    }
    const letters = isolatedLetters(text, task);
    if (letters.length > 1) return { value: null, ambiguous: true };
    if (letters.length === 1) return { value: letters[0], ambiguous: false };
  }
  return { value: null, ambiguous: false };
}

function answerPayloads(text) {
  const payloads = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const match = line.match(/ANSWER\s*[:：]\s*(.*)$/i);
    if (match) payloads.push(match[1]);
  }
  return payloads;
}

function immediateCandidate(fragment, task) {
  const text = stripDecorations(fragment).replace(/^[:\-–—]+\s*/, '');
  if (!text) return { value: null, ambiguous: false };
  if (task.kind === 'integer') return readInteger(text);
  if (openingPair(text, task)) return { value: null, ambiguous: true };
  const lead = leadingChoice(text, task);
  if (!lead) return { value: null, ambiguous: false };
  if (trailingAlternative(lead.rest, lead.letter, task)) return { value: null, ambiguous: true };
  return { value: lead.letter, ambiguous: false };
}

function proseCandidate(line, task) {
  const source = String(line || '');
  const flags = new RegExp(PROSE_ANSWER.source, 'gi');
  let match = flags.exec(source);
  let last = null;
  while (match) {
    last = match;
    match = flags.exec(source);
  }
  if (!last) return null;
  return immediateCandidate(source.slice(last.index + last[0].length), task);
}

export function extractLenient(text, task) {
  const strict = extractFinalAnswer(text);
  if (strict.status === 'ok') {
    const canon = canonAnswer(strict.raw, task);
    if (canon != null) return { status: 'ok', canon, lenient: false, via: null };
  }
  const payloads = answerPayloads(text);
  if (payloads.length) {
    const parsed = parsePayload(payloads[payloads.length - 1], task);
    if (parsed.value) return { status: 'ok', canon: parsed.value, lenient: true, via: 'answer_line' };
    return { status: 'no_answer', reason: parsed.ambiguous ? 'ambiguous' : 'no_answer' };
  }
  const boxed = [...String(text ?? '').matchAll(/\\boxed\{([^{}]*)\}/g)];
  if (boxed.length) {
    const parsed = parsePayload(boxed[boxed.length - 1][1], task);
    if (parsed.value) return { status: 'ok', canon: parsed.value, lenient: true, via: 'boxed' };
    if (parsed.ambiguous) return { status: 'no_answer', reason: 'ambiguous' };
  }
  const prose = proseCandidate(lastNonEmptyLine(text), task);
  if (prose?.value) return { status: 'ok', canon: prose.value, lenient: true, via: 'prose' };
  if (prose?.ambiguous) return { status: 'no_answer', reason: 'ambiguous' };
  if (REFUSAL.test(String(text ?? ''))) return { status: 'no_answer', reason: 'refusal' };
  return { status: 'no_answer', reason: 'no_answer' };
}

export function gradeResponseLenient(task, text, failure = null) {
  if (failure) {
    if (failure === 'truncated') {
      return {
        correct: 0,
        status: 'no_answer',
        reason: 'length',
        formatCompliant: false,
        extracted: null,
      };
    }
    return gradeResponse(task, '', failure);
  }
  const found = extractLenient(text, task);
  if (found.status === 'ok' && !found.lenient) return gradeResponse(task, text);
  if (found.status === 'ok') {
    return {
      correct: found.canon === task.goldCanon ? 1 : 0,
      status: 'graded',
      formatCompliant: false,
      extracted: found.canon,
      lenient: true,
      via: found.via,
    };
  }
  return {
    correct: 0,
    status: 'no_answer',
    reason: found.reason || 'no_answer',
    formatCompliant: false,
    extracted: null,
  };
}

export function failureKind(result) {
  if (!result) return 'provider_error';
  if (result.skipped) {
    const message = `${result.error?.message || ''} ${result.error?.detail || ''}`.toLowerCase();
    if (message.includes('harness')) return 'harness_403';
    return 'skipped';
  }
  const kind = result.error?.kind;
  if (kind === 'first-response' || kind === 'idle' || kind === 'total') return 'timeout';
  if (kind === 'aborted') return 'aborted';
  const message = `${result.error?.message || ''} ${result.error?.detail || ''}`.toLowerCase();
  if (message.includes('stream ended') || message.includes('protocol')) return 'truncated';
  if (result.finishReason === 'length') return 'truncated';
  return 'provider_error';
}

export function gradeResponse(task, text, failure = null) {
  if (failure) {
    return {
      correct: 0,
      status: failure,
      formatCompliant: false,
      extracted: null,
    };
  }
  const extracted = extractFinalAnswer(text);
  if (extracted.status !== 'ok') {
    return {
      correct: 0,
      status: extracted.status,
      formatCompliant: false,
      extracted: null,
    };
  }
  const canon = canonAnswer(extracted.raw, task);
  if (canon == null) {
    return {
      correct: 0,
      status: 'parse_error',
      formatCompliant: false,
      extracted: extracted.raw,
    };
  }
  return {
    correct: canon === task.goldCanon ? 1 : 0,
    status: 'graded',
    formatCompliant: true,
    extracted: canon,
  };
}

export function plurality(grades, pick) {
  const votes = new Map();
  let abstain = 0;
  for (const grade of grades) {
    if (!grade || grade.status !== 'graded' || grade.extracted == null) {
      abstain += 1;
      continue;
    }
    votes.set(grade.extracted, (votes.get(grade.extracted) || 0) + 1);
  }
  if (!votes.size) {
    return {
      correct: 0,
      status: 'no_answer',
      extracted: null,
      tie: false,
      abstain,
      votes: {},
    };
  }
  const max = Math.max(...votes.values());
  const tied = [...votes.keys()].filter((key) => votes.get(key) === max);
  const tie = tied.length > 1;
  const extracted = tie ? pick(tied) : tied[0];
  return {
    status: 'graded',
    extracted,
    tie,
    abstain,
    votes: Object.fromEntries(votes),
  };
}
