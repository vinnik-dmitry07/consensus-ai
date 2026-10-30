/**
 * Share settings stay in this browser. They are not part of either council engine.
 */

export const SHARE_STORAGE_KEY = 'llm-council-share-settings';

const LINK_LIMIT = 100;

let state = null;

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key === SHARE_STORAGE_KEY) state = null;
  });
}

function freshState() {
  return { github_token: null, links: [] };
}

function sameShare(link, provider, id) {
  return link.provider === provider && link.id === id;
}

function isLinkRecord(value) {
  return Boolean(
    value
    && (value.provider === 'gist' || value.provider === 'dpaste')
    && typeof value.id === 'string'
    && value.id
    && typeof value.link === 'string'
    && value.link
    && typeof value.created_at === 'string',
  );
}

function load() {
  if (state) return state;
  state = freshState();
  try {
    const raw = localStorage.getItem(SHARE_STORAGE_KEY);
    if (!raw) return state;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return state;
    if (typeof parsed.github_token === 'string' && parsed.github_token.trim()) {
      state.github_token = parsed.github_token.trim();
    }
    if (Array.isArray(parsed.links)) {
      state.links = parsed.links.filter(isLinkRecord).slice(0, LINK_LIMIT);
    }
  } catch {
    state = freshState();
  }
  return state;
}

function save() {
  localStorage.setItem(SHARE_STORAGE_KEY, JSON.stringify(state));
}

export function getGithubToken() {
  return load().github_token;
}

export function setGithubToken(token) {
  load();
  const next = typeof token === 'string' ? token.trim() : '';
  state.github_token = next || null;
  save();
  return state.github_token;
}

export function forgetGithubToken() {
  return setGithubToken(null);
}

export function maskToken(token) {
  if (!token) return '';
  if (token.length <= 8) return '****';
  return `${token.slice(0, 4)}...${token.slice(-4)}`;
}

export function listShareLinks(conversationId) {
  return load().links
    .filter((link) => link.conversation_id === conversationId)
    .map((link) => ({ ...link }));
}

export function rememberShareLink(record) {
  load();
  const next = {
    provider: record.provider,
    id: record.id,
    link: record.link,
    conversation_id: record.conversation_id || null,
    created_at: record.created_at,
    expires_at: record.expires_at || null,
  };
  if (!isLinkRecord(next)) throw new Error('Could not remember this share link.');
  const previous = state.links;
  state.links = [
    next,
    ...state.links.filter((link) => !sameShare(link, next.provider, next.id)),
  ].slice(0, LINK_LIMIT);
  try {
    save();
  } catch (error) {
    state.links = previous;
    throw error;
  }
  return { ...next };
}

export function forgetShareLink(provider, id) {
  load();
  state.links = state.links.filter((link) => !sameShare(link, provider, id));
  save();
}

export function resetShareSettingsForTests() {
  state = null;
  try {
    localStorage.removeItem(SHARE_STORAGE_KEY);
  } catch {
    // The test storage may already have been removed.
  }
}
