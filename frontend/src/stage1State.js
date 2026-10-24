function list(value) {
  return Array.isArray(value) ? value : [];
}

export function answerTabsFrom(responses) {
  const tabs = [];
  list(responses).forEach((resp, sourceIndex) => {
    if (!resp || typeof resp.response !== 'string' || resp.response.trim() === '') return;
    tabs.push({
      sourceIndex,
      model: resp.model,
      response: resp.response,
    });
  });
  return tabs;
}

export function pickAnswerTab(tabs, selectedSource) {
  if (!tabs?.length) return null;
  if (selectedSource == null) return tabs[tabs.length - 1];
  return tabs.find((tab) => tab.sourceIndex === selectedSource) || tabs[tabs.length - 1];
}

export function knownList(incoming, stored) {
  return Array.isArray(incoming) ? incoming : list(stored);
}

const SAFE_NOTE_MESSAGES = new Set([
  'Model not found (404)',
  '402: cannot afford reserved tokens',
  'Only available on agentic harnesses',
  'Temporarily rate-limited upstream',
  'Cooling down after an upstream rate limit',
  'Temporarily unavailable (cooldown)',
  'Provider returned an error',
  'OpenRouter will not serve this model',
  'Request failed',
]);

export function shortModelName(model) {
  if (typeof model !== 'string' || model === '') return 'unknown';
  return model.split('/')[1] || model;
}

export function safeNoteReason(kind, message) {
  const text = typeof message === 'string' ? message.trim() : '';
  if (SAFE_NOTE_MESSAGES.has(text)) return text;
  const http = /^HTTP (\d{3})\b/.exec(text);
  if (http) return `HTTP ${http[1]}`;
  return kind === 'skip' ? '' : 'Request failed';
}

export function stageRetryPatch(message, stage) {
  const current = message || {};
  return {
    ...current,
    error: null,
    streaming: false,
    stage1_failures: stage === 1 ? [] : current.stage1_failures,
    stage1_skipped: stage === 1 ? [] : current.stage1_skipped,
    stage2_failures: stage === 3 ? current.stage2_failures : [],
    stage2_skipped: stage === 3 ? current.stage2_skipped : [],
    ...(stage === 1 ? { stage1: [], stage1Progress: null } : {}),
    loading: {
      stage1: stage === 1,
      stage2: stage === 2,
      redteam: stage === 3,
      stage3: false,
    },
  };
}

export function applyStage1Event(message, eventType, event = {}) {
  const current = message || {};
  switch (eventType) {
    case 'stage1_start':
      return {
        ...current,
        loading: { ...(current.loading || {}), stage1: true },
        stage1: [],
        stage1Progress: null,
        stage1_failures: [],
        stage1_skipped: [],
        stage2: null,
        stage3: null,
        metadata: null,
        error: null,
      };
    case 'stage1_init': {
      const data = event.data || {};
      return {
        ...current,
        stage1Progress: {
          total: data.total_models,
          completed: data.existing_count || 0,
          results: [],
        },
      };
    }
    case 'stage1_model_complete': {
      const progress = current.stage1Progress;
      if (!progress) return current;
      const isExisting = Boolean(event.data.existing);
      return {
        ...current,
        stage1Progress: {
          ...progress,
          completed: isExisting ? progress.completed : progress.completed + 1,
          results: [...progress.results, event.data.result],
        },
      };
    }
    case 'stage1_model_failed': {
      const data = event.data || {};
      const progress = current.stage1Progress;
      const isExisting = Boolean(data.existing);
      const skipped = Boolean(data.skipped);
      const next = {
        ...current,
        stage1_failures: skipped
          ? list(current.stage1_failures)
          : [...list(current.stage1_failures), data],
        stage1_skipped: skipped
          ? [...list(current.stage1_skipped), data]
          : list(current.stage1_skipped),
      };
      if (!progress) return next;
      const countFailure = !isExisting && !skipped;
      const dropSlot = !isExisting && skipped;
      return {
        ...next,
        stage1Progress: {
          ...progress,
          completed: progress.completed + (countFailure ? 1 : 0),
          total: Math.max(0, progress.total - (dropSlot ? 1 : 0)),
        },
      };
    }
    case 'stage1_complete':
      return {
        ...current,
        stage1: event.data,
        stage1_failures: knownList(event?.failures, current.stage1_failures),
        stage1_skipped: knownList(event?.skipped, current.stage1_skipped),
        stage1Progress: null,
        loading: { ...(current.loading || {}), stage1: false },
      };
    case 'stage1_error':
      return {
        ...current,
        stage1: current.stage1Progress?.results ?? current.stage1 ?? [],
        stage1_failures: knownList(event?.failures, current.stage1_failures),
        stage1_skipped: knownList(event?.skipped, current.stage1_skipped),
        loading: { ...(current.loading || {}), stage1: false },
        stage1Progress: null,
        error: { stage: 1, message: event.message },
      };
    default:
      return current;
  }
}
