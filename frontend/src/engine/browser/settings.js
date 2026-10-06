/**
 * Browser copy of backend/config.py defaults and backend/settings.py.
 * Stored in localStorage. The API key never leaves this browser except as a
 * bearer token to openrouter.ai.
 */

const STORAGE_KEY = 'llm-council-browser-settings';

export const TITLE_MODEL = 'google/gemini-2.5-flash';

export const DEFAULT_COUNCIL_MODELS = [
  '~openai/gpt-sol-latest',
  '~google/gemini-pro-latest',
  '~anthropic/claude-opus-latest',
  '~x-ai/grok-latest',
  '~openai/gpt-sol-latest-reasoning',
  '~google/gemini-pro-latest-reasoning',
  '~anthropic/claude-opus-latest-reasoning',
  '~x-ai/grok-latest-reasoning',
];

export const DEFAULT_N_SAMPLES = 3;
export const DEFAULT_CHAIRMAN_MODEL = '~anthropic/claude-fable-latest-reasoning-high';
export const DEFAULT_TOP_K = 3;
export const DEFAULT_RED_TEAM_MODEL = null;
export const DEFAULT_SELF_EXCLUSION = true;

function freshState() {
  return {
    council_models: [...DEFAULT_COUNCIL_MODELS],
    n_samples: DEFAULT_N_SAMPLES,
    chairman_model: DEFAULT_CHAIRMAN_MODEL,
    top_k: DEFAULT_TOP_K,
    red_team_model: DEFAULT_RED_TEAM_MODEL,
    self_exclusion: DEFAULT_SELF_EXCLUSION,
    api_key: null,
  };
}

let state = null;

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key === STORAGE_KEY) state = null;
  });
}

function clampInt(value, min, max) {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return freshState();
    const parsed = JSON.parse(raw);
    const next = freshState();
    if (Array.isArray(parsed.council_models)) {
      next.council_models = parsed.council_models.map((model) => String(model));
    }
    if (parsed.n_samples != null) next.n_samples = clampInt(parsed.n_samples, 1, 10);
    if (typeof parsed.chairman_model === 'string' && parsed.chairman_model) {
      next.chairman_model = parsed.chairman_model;
    }
    if (parsed.top_k != null) next.top_k = clampInt(parsed.top_k, 1, 10);
    if (typeof parsed.red_team_model === 'string' && parsed.red_team_model.trim()) {
      next.red_team_model = parsed.red_team_model.trim();
    } else {
      next.red_team_model = null;
    }
    if (parsed.self_exclusion != null) next.self_exclusion = Boolean(parsed.self_exclusion);
    if (typeof parsed.api_key === 'string' && parsed.api_key.trim()) {
      next.api_key = parsed.api_key.trim();
    }
    return next;
  } catch {
    return freshState();
  }
}

function current() {
  if (!state) state = load();
  return state;
}

function persist() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(current()));
}

export function resetSettingsState() {
  state = null;
}

function maskedKey(apiKey) {
  if (!apiKey) return null;
  if (apiKey.length <= 8) return '****';
  return `${apiKey.slice(0, 4)}...${apiKey.slice(-4)}`;
}

export const settings = {
  get councilModels() {
    return current().council_models;
  },

  set councilModels(value) {
    current().council_models = [...value];
    persist();
  },

  get nSamples() {
    return current().n_samples;
  },

  set nSamples(value) {
    current().n_samples = clampInt(value, 1, 10);
    persist();
  },

  get chairmanModel() {
    return current().chairman_model;
  },

  set chairmanModel(value) {
    current().chairman_model = value;
    persist();
  },

  get topK() {
    return current().top_k;
  },

  set topK(value) {
    current().top_k = clampInt(value, 1, 10);
    persist();
  },

  get redTeamModel() {
    return current().red_team_model;
  },

  set redTeamModel(value) {
    if (value && String(value).trim()) {
      current().red_team_model = String(value).trim();
    } else {
      current().red_team_model = null;
    }
    persist();
  },

  get selfExclusion() {
    return current().self_exclusion;
  },

  set selfExclusion(value) {
    current().self_exclusion = Boolean(value);
    persist();
  },

  get apiKey() {
    return current().api_key;
  },

  set apiKey(value) {
    if (value && String(value).trim()) {
      current().api_key = String(value).trim();
      persist();
    }
  },

  clearApiKey() {
    current().api_key = null;
    persist();
  },

  get hasApiKey() {
    return Boolean(current().api_key);
  },

  get maskedApiKey() {
    return maskedKey(current().api_key);
  },

  resetToDefaults() {
    const apiKey = current().api_key;
    state = freshState();
    state.api_key = apiKey;
    persist();
  },

  toDict() {
    const data = current();
    return {
      council_models: [...data.council_models],
      n_samples: data.n_samples,
      chairman_model: data.chairman_model,
      top_k: data.top_k,
      red_team_model: data.red_team_model,
      self_exclusion: data.self_exclusion,
      has_api_key: Boolean(data.api_key),
      masked_api_key: maskedKey(data.api_key),
    };
  },

  updateFromDict(data) {
    if (!data) return;
    if ('council_models' in data) this.councilModels = data.council_models;
    if ('n_samples' in data) this.nSamples = data.n_samples;
    if ('chairman_model' in data) this.chairmanModel = data.chairman_model;
    if ('top_k' in data) this.topK = data.top_k;
    if ('red_team_model' in data) this.redTeamModel = data.red_team_model;
    if ('self_exclusion' in data) this.selfExclusion = data.self_exclusion;
    if ('api_key' in data) this.apiKey = data.api_key;
  },
};
