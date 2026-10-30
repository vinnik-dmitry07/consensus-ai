/**
 * A share snapshot is the conversation without its local id, without a run
 * still on screen, and without fields the chat view does not know.
 * Opening a share runs the same cleaner, so a hostile payload cannot throw
 * during render.
 */

const USER_FIELDS = ['role', 'content', 'images', 'files', 'follow_up_to'];
const ASSISTANT_FIELDS = [
  'role',
  'content',
  'stage1',
  'stage2',
  'stage3',
  'metadata',
  'stage1_complete',
  'stage1_failures',
  'stage1_skipped',
  'stage2_failures',
  'stage2_skipped',
  'error',
];

const ARRAY_FIELDS = new Set([
  'stage1',
  'stage2',
  'stage1_failures',
  'stage1_skipped',
  'stage2_failures',
  'stage2_skipped',
  'parsed_ranking',
  'ranked_indices',
  'disputed_claims',
  'reasons',
  'aggregate_rankings',
  'response_rankings',
  'top_k_indices',
]);

const OBJECT_FIELDS = new Set([
  'stage3',
  'metadata',
  'label_to_index',
  'label_to_model',
  'correctness',
  'issues',
  'usage',
  'error',
  'consensus',
  'red_team',
]);

const STRING_LISTS = new Set(['parsed_ranking', 'disputed_claims', 'reasons']);
const MARKDOWN_FIELDS = new Set(['content', 'response', 'ranking', 'critique']);
const RESPONSE_LABEL = /^Response \d{1,4}$/;
const DATA_IMAGE = /^data:image\/(?:png|jpe?g|gif|webp);base64,[a-z0-9+/]+={0,2}$/i;
const MARKDOWN_IMAGE = /!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;
const PLAIN_TOKEN = /^[A-Za-z0-9_-]+$/;

const MAX_MESSAGES = 200;
const MAX_DEPTH = 8;
const MAX_NODES = 20000;
const MAX_ARRAY = 200;
const MAX_KEYS = 80;
const MAX_TEXT = 1_000_000;
const MAX_IMAGE_CHARS = 12_000_000;
const MAX_FILE_CHARS = 100 * 1024;
const MAX_FILES = 10;

function blankBudget() {
  return { nodes: 0, overflow: false };
}

function takeNode(budget) {
  budget.nodes += 1;
  if (budget.nodes > MAX_NODES) budget.overflow = true;
  return !budget.overflow;
}

function clip(value, limit) {
  return value.length > limit ? value.slice(0, limit) : value;
}

function isDataImage(value) {
  return typeof value === 'string'
    && value.length <= MAX_IMAGE_CHARS
    && DATA_IMAGE.test(value);
}

function neutralizeRemoteImages(value) {
  return value.replace(MARKDOWN_IMAGE, (match, alt, url) => {
    if (isDataImage(url)) return match;
    const label = clip(String(alt || '').trim(), 200);
    return label ? `[image: ${label}]` : '';
  });
}

function sanitizeImages(value) {
  if (!Array.isArray(value)) return undefined;
  const images = value.filter(isDataImage).slice(0, MAX_FILES);
  return images.length ? images : undefined;
}

function sanitizeFiles(value) {
  if (!Array.isArray(value)) return undefined;
  const files = [];
  for (const item of value) {
    if (files.length >= MAX_FILES) break;
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    if (typeof item.name !== 'string' || !item.name.trim()) continue;
    const file = { name: clip(item.name.trim(), 200) };
    if (typeof item.content === 'string') file.content = clip(item.content, MAX_FILE_CHARS);
    files.push(file);
  }
  return files.length ? files : undefined;
}

function sanitizeLabelMap(value, kind) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const next = {};
  for (const [label, mapped] of Object.entries(value)) {
    if (!RESPONSE_LABEL.test(label)) continue;
    if (kind === 'index') {
      if (typeof mapped !== 'number' || !Number.isInteger(mapped) || mapped < 0 || mapped > 1000) continue;
      next[label] = mapped;
    } else if (typeof mapped === 'string' && mapped.trim()) {
      next[label] = clip(mapped.trim(), 200);
    }
    if (Object.keys(next).length >= MAX_KEYS) break;
  }
  return Object.keys(next).length ? next : undefined;
}

function sanitize(value, key, depth, budget) {
  if (key === 'images') return sanitizeImages(value);
  if (key === 'files') return sanitizeFiles(value);
  if (key === 'label_to_index') return sanitizeLabelMap(value, 'index');
  if (key === 'label_to_model') return sanitizeLabelMap(value, 'model');
  if (!takeNode(budget)) return undefined;
  if (value == null) return value;
  if (key === 'model' || key === 'message' || key === 'level'
    || key === 'consensus_level' || key === 'verdict' || MARKDOWN_FIELDS.has(key)) {
    if (typeof value !== 'string') return undefined;
  }
  if (OBJECT_FIELDS.has(key) || ARRAY_FIELDS.has(key)) {
    if (typeof value !== 'object') return undefined;
  }
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return undefined;
    if (key === 'follow_up_to' && (!Number.isInteger(value) || value < 0 || value > 10000)) {
      return undefined;
    }
    if (key === 'stage' && value !== 1 && value !== 2 && value !== 3) return undefined;
    return value;
  }
  if (typeof value === 'string') {
    if (key === 'model') {
      const trimmed = clip(value.trim(), 200);
      return trimmed || undefined;
    }
    if (key === 'level' || key === 'consensus_level' || key === 'verdict') {
      const token = value.trim().slice(0, 40);
      return PLAIN_TOKEN.test(token) ? token : undefined;
    }
    if (key === 'message' || MARKDOWN_FIELDS.has(key) || key === '') {
      const clipped = clip(value, MAX_TEXT);
      return MARKDOWN_FIELDS.has(key) ? neutralizeRemoteImages(clipped) : clipped;
    }
    return clip(value, MAX_TEXT);
  }
  if (typeof value !== 'object' || depth >= MAX_DEPTH) return undefined;

  if (Array.isArray(value)) {
    if (OBJECT_FIELDS.has(key)) return undefined;
    const next = [];
    for (const item of value.slice(0, MAX_ARRAY)) {
      const child = sanitize(item, '', depth + 1, budget);
      if (child == null) continue;
      if (STRING_LISTS.has(key) && typeof child !== 'string') continue;
      next.push(child);
    }
    return next;
  }

  if (ARRAY_FIELDS.has(key)) return undefined;

  const next = {};
  const entries = Object.entries(value).slice(0, MAX_KEYS);
  for (const [childKey, childValue] of entries) {
    if (childKey === '__proto__' || childKey === 'constructor' || childKey === 'prototype') continue;
    const child = sanitize(childValue, childKey, depth + 1, budget);
    if (child === undefined) continue;
    next[childKey] = child;
  }
  return next;
}

function keep(target, key, value) {
  if (value == null || value === '') return;
  if (Array.isArray(value) && value.length === 0) return;
  target[key] = value;
}

function assistantInProgress(message) {
  if (message.streaming === true) return true;
  const loading = message.loading;
  if (!loading || typeof loading !== 'object') return false;
  return Boolean(loading.stage1 || loading.stage2 || loading.redteam || loading.stage3);
}

function cleanMessage(message, includeAttachments, budget) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return null;
  const role = message.role === 'user' || message.role === 'assistant' ? message.role : '';
  if (!role) return null;
  if (role === 'assistant' && assistantInProgress(message)) return null;

  const fields = role === 'user' ? USER_FIELDS : ASSISTANT_FIELDS;
  const next = { role };
  for (const key of fields) {
    if (key === 'role') continue;
    if (!includeAttachments && (key === 'images' || key === 'files')) continue;
    if (!(key in message)) continue;
    keep(next, key, sanitize(message[key], key, 1, budget));
  }
  if (role === 'user' && typeof next.content !== 'string') next.content = '';
  return next;
}

function cleanMessages(messages, includeAttachments, tooBig) {
  const budget = blankBudget();
  const next = [];
  const source = Array.isArray(messages) ? messages : [];
  for (const message of source) {
    if (next.length >= MAX_MESSAGES) {
      budget.overflow = true;
      break;
    }
    const cleaned = cleanMessage(message, includeAttachments, budget);
    if (cleaned) next.push(cleaned);
    if (budget.overflow) break;
  }
  if (budget.overflow) throw new Error(tooBig);
  return next;
}

export function buildShareSnapshot(conversation, { includeAttachments = true } = {}) {
  if (!conversation || typeof conversation !== 'object') {
    throw new Error('Nothing to share.');
  }
  return {
    version: 1,
    shared_at: new Date().toISOString(),
    conversation: {
      title: typeof conversation.title === 'string' && conversation.title.trim()
        ? clip(conversation.title.trim(), 300)
        : 'New Conversation',
      created_at: typeof conversation.created_at === 'string' && conversation.created_at.trim()
        ? clip(conversation.created_at.trim(), 40)
        : new Date().toISOString(),
      messages: cleanMessages(
        conversation.messages,
        includeAttachments,
        'This conversation is too large to share. Try again without attachments.',
      ),
    },
  };
}

export function snapshotToConversation(snapshot) {
  if (!snapshot || snapshot.version !== 1 || !snapshot.conversation) {
    throw new Error('Unsupported share snapshot.');
  }
  const source = snapshot.conversation;
  let messages;
  try {
    messages = cleanMessages(source.messages, true, 'This share is too large to open.');
  } catch (error) {
    if (error instanceof Error && error.message === 'This share is too large to open.') throw error;
    throw new Error('Unsupported share snapshot.');
  }
  return {
    id: crypto.randomUUID(),
    created_at: typeof source.created_at === 'string' && source.created_at.trim()
      ? clip(source.created_at.trim(), 40)
      : new Date().toISOString(),
    title: typeof source.title === 'string' && source.title.trim()
      ? clip(source.title.trim(), 300)
      : 'New Conversation',
    messages,
    removed: false,
  };
}
