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
