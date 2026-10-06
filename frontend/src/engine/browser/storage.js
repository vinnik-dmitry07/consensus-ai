/**
 * IndexedDB port of backend/storage.py.
 * Same conversation JSON. Each change reads and writes in one transaction,
 * which IndexedDB runs one at a time, including across tabs.
 */

import { openDB } from 'idb';

const DB_NAME = 'llm-council';
const STORE = 'conversations';
const DB_VERSION = 1;

const CONVERSATION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const UNSET = Symbol('UNSET');

let dbPromise = null;

function assertConversationId(conversationId) {
  if (typeof conversationId !== 'string' || !CONVERSATION_ID_RE.test(conversationId)) {
    throw new Error('Invalid conversation id');
  }
}

function database() {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: 'id' });
        }
      },
    });
  }
  return dbPromise;
}

async function readRow(conversationId) {
  const db = await database();
  return db.get(STORE, conversationId);
}

async function writeRow(conversation) {
  const db = await database();
  await db.put(STORE, conversation);
}

export async function resetStorageForTests() {
  if (dbPromise) {
    const db = await dbPromise;
    db.close();
    dbPromise = null;
  }
  await new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => resolve();
  });
}

export async function createConversation(conversationId) {
  assertConversationId(conversationId);
  const conversation = {
    id: conversationId,
    created_at: new Date().toISOString(),
    title: 'New Conversation',
    messages: [],
    removed: false,
  };
  const db = await database();
  await db.put(STORE, conversation);
  return conversation;
}

export async function getConversation(conversationId) {
  try {
    assertConversationId(conversationId);
  } catch {
    return null;
  }
  const row = await readRow(conversationId);
  return row || null;
}

function newestFirst(a, b) {
  if (a.created_at < b.created_at) return 1;
  if (a.created_at > b.created_at) return -1;
  return 0;
}

function activeRows(rows) {
  return rows.filter((data) => data && !data.removed).sort(newestFirst);
}

export async function listConversations() {
  const db = await database();
  const rows = await db.getAll(STORE);
  return activeRows(rows).map((data) => ({
    id: data.id,
    created_at: data.created_at,
    title: data.title || 'New Conversation',
    message_count: (data.messages || []).length,
  }));
}

async function mutate(conversationId, fn) {
  assertConversationId(conversationId);
  const db = await database();
  const tx = db.transaction(STORE, 'readwrite');
  try {
    const conversation = await tx.store.get(conversationId);
    if (!conversation) {
      throw new Error(`Conversation ${conversationId} not found`);
    }
    fn(conversation);
    await tx.store.put(conversation);
    await tx.done;
    return conversation;
  } catch (exc) {
    try {
      tx.abort();
    } catch {
      // The transaction may already have finished.
    }
    try {
      await tx.done;
    } catch {
      // Aborting rejects tx.done. That rejection is the abort, not the cause.
    }
    throw exc;
  }
}

export async function addUserMessage(
  conversationId,
  content,
  images = null,
  files = null,
  followUpTo = null,
) {
  await mutate(conversationId, (conversation) => {
    const message = { role: 'user', content };
    if (images && images.length) message.images = images;
    if (files && files.length) message.files = files;
    if (followUpTo != null) message.follow_up_to = followUpTo;
    conversation.messages.push(message);
  });
}

export async function addAssistantMessage(
  conversationId,
  stage1,
  stage2,
  stage3,
  metadata = null,
  stage1Failures = null,
  error = null,
) {
  await mutate(conversationId, (conversation) => {
    const message = {
      role: 'assistant',
      stage1,
      stage2,
      stage3,
    };
    if (metadata) message.metadata = metadata;
    if (stage1Failures && stage1Failures.length) message.stage1_failures = stage1Failures;
    if (error) message.error = error;
    conversation.messages.push(message);
  });
}

export async function updateConversationTitle(conversationId, title) {
  await mutate(conversationId, (conversation) => {
    conversation.title = title;
  });
}

export async function removeConversation(conversationId) {
  await mutate(conversationId, (conversation) => {
    conversation.removed = true;
  });
}

export async function addUserTurn(
  conversationId,
  content,
  images = null,
  files = null,
  followUpTo = null,
) {
  const conversation = await mutate(conversationId, (row) => {
    const message = { role: 'user', content };
    if (images && images.length) message.images = images;
    if (files && files.length) message.files = files;
    if (followUpTo != null) message.follow_up_to = followUpTo;
    row.messages.push(message);
    row.messages.push({
      role: 'assistant',
      stage1: [],
      stage1_failures: [],
      stage2: null,
      stage3: null,
      streaming: true,
    });
  });
  return conversation.messages.length - 1;
}

export async function createStreamingAssistantMessage(conversationId) {
  const conversation = await mutate(conversationId, (row) => {
    row.messages.push({
      role: 'assistant',
      stage1: [],
      stage1_failures: [],
      stage2: null,
      stage3: null,
      streaming: true,
    });
  });
  return conversation.messages.length - 1;
}

async function appendMessageListItem(conversationId, messageIndex, field, item) {
  await mutate(conversationId, (conversation) => {
    const message = conversation.messages[messageIndex];
    if (message[field] == null) message[field] = [];
    message[field].push(item);
  });
}

export function appendStage1Result(conversationId, messageIndex, result) {
  return appendMessageListItem(conversationId, messageIndex, 'stage1', result);
}

export function appendStage1Failure(conversationId, messageIndex, failure) {
  return appendMessageListItem(conversationId, messageIndex, 'stage1_failures', failure);
}

export async function updateStreamingMessage(conversationId, messageIndex, fields = {}) {
  const stage1 = 'stage1' in fields ? fields.stage1 : UNSET;
  const stage2 = 'stage2' in fields ? fields.stage2 : UNSET;
  const stage3 = 'stage3' in fields ? fields.stage3 : UNSET;
  const metadata = 'metadata' in fields ? fields.metadata : UNSET;
  const error = 'error' in fields ? fields.error : null;
  const streaming = 'streaming' in fields ? fields.streaming : true;
  const stage1Complete = 'stage1_complete' in fields ? fields.stage1_complete : null;
  const stage1Failures = 'stage1_failures' in fields ? fields.stage1_failures : null;
  const stage2Failures = 'stage2_failures' in fields ? fields.stage2_failures : null;

  await mutate(conversationId, (conversation) => {
    const message = conversation.messages[messageIndex];
    if (!message) throw new Error(`Invalid message index: ${messageIndex}`);

    if (stage1 !== UNSET) message.stage1 = stage1;
    if (stage1Complete != null) message.stage1_complete = stage1Complete;
    if (stage1Failures != null) message.stage1_failures = stage1Failures;
    if (stage2Failures != null) message.stage2_failures = stage2Failures;
    if (stage2 !== UNSET) message.stage2 = stage2;
    if (stage3 !== UNSET) message.stage3 = stage3;
    if (metadata !== UNSET) message.metadata = metadata;
    if (error != null) message.error = error;
    else if ('error' in message) delete message.error;

    message.streaming = streaming;
  });
}

export async function exportConversations() {
  const db = await database();
  const rows = await db.getAll(STORE);
  return { version: 1, conversations: activeRows(rows) };
}

export async function importConversations(conversations) {
  const imported = [];
  for (const conversation of conversations || []) {
    if (!conversation || typeof conversation !== 'object') continue;
    try {
      assertConversationId(conversation.id);
    } catch {
      continue;
    }
    const row = {
      ...conversation,
      id: conversation.id,
      messages: Array.isArray(conversation.messages) ? conversation.messages : [],
      created_at: conversation.created_at || new Date().toISOString(),
      title: conversation.title || 'New Conversation',
      removed: Boolean(conversation.removed),
    };
    await writeRow(row);
    imported.push(row.id);
  }
  return imported;
}
