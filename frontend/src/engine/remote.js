/**
 * Local FastAPI engine. Talks to the Python backend over REST and SSE.
 */

const DEFAULT_API_BASE = 'http://localhost:8001';
const API_BASE_KEY = 'llm-council-api-base';

export function getApiBase() {
  try {
    const stored = localStorage.getItem(API_BASE_KEY);
    if (stored && stored.trim()) return stored.trim().replace(/\/$/, '');
  } catch {
    // localStorage can be blocked; the dev default still works.
  }
  return DEFAULT_API_BASE;
}

export function setApiBase(url) {
  const cleaned = String(url || '').trim().replace(/\/$/, '');
  const next = cleaned || DEFAULT_API_BASE;
  localStorage.setItem(API_BASE_KEY, next);
  return next;
}

/**
 * Pull the backend's own explanation out of an error response.
 * A retry can be refused for a reason the user can act on (for example, the
 * earlier answer a follow-up was built on is gone), so show that, not a stub.
 */
async function errorDetail(response, fallback) {
  try {
    const body = await response.json();
    const detail = body?.detail;
    if (typeof detail === 'string' && detail.trim()) return detail;
    if (detail && Array.isArray(detail.unknown_models)) {
      return `Unknown models: ${detail.unknown_models.join(', ')}`;
    }
  } catch {
    // Not JSON, or already consumed - fall through to the generic message.
  }
  return fallback;
}

export const remoteEngine = {
  async getCredits() {
    const response = await fetch(`${getApiBase()}/api/credits`);
    if (!response.ok) {
      throw new Error('Failed to fetch credits');
    }
    return response.json();
  },

  async getPricing() {
    const response = await fetch(`${getApiBase()}/api/pricing`);
    if (!response.ok) {
      throw new Error('Failed to fetch pricing');
    }
    return response.json();
  },

  async getAvailableModels() {
    const response = await fetch(`${getApiBase()}/api/models`);
    if (!response.ok) {
      throw new Error('Failed to fetch models');
    }
    return response.json();
  },

  async getSettings() {
    const response = await fetch(`${getApiBase()}/api/settings`);
    if (!response.ok) {
      throw new Error('Failed to fetch settings');
    }
    return response.json();
  },

  async updateSettings(settings) {
    const response = await fetch(`${getApiBase()}/api/settings`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(settings),
    });
    if (!response.ok) {
      throw new Error(await errorDetail(response, 'Failed to update settings'));
    }
    return response.json();
  },

  async resetSettings() {
    const response = await fetch(`${getApiBase()}/api/settings/reset`, {
      method: 'POST',
    });
    if (!response.ok) {
      throw new Error('Failed to reset settings');
    }
    return response.json();
  },

  async listConversations() {
    const response = await fetch(`${getApiBase()}/api/conversations`);
    if (!response.ok) {
      throw new Error('Failed to list conversations');
    }
    return response.json();
  },

  async createConversation() {
    const response = await fetch(`${getApiBase()}/api/conversations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    });
    if (!response.ok) {
      throw new Error('Failed to create conversation');
    }
    return response.json();
  },

  async getConversation(conversationId) {
    const response = await fetch(
      `${getApiBase()}/api/conversations/${conversationId}`
    );
    if (!response.ok) {
      throw new Error('Failed to get conversation');
    }
    return response.json();
  },

  async removeConversation(conversationId) {
    const response = await fetch(
      `${getApiBase()}/api/conversations/${conversationId}`,
      { method: 'DELETE' }
    );
    if (!response.ok) {
      throw new Error('Failed to remove conversation');
    }
    return response.json();
  },

  async exportConversations() {
    const response = await fetch(`${getApiBase()}/api/conversations/export`);
    if (!response.ok) {
      throw new Error('Failed to export conversations');
    }
    return response.json();
  },

  async importConversations(payload) {
    if (!payload || Array.isArray(payload) || !Array.isArray(payload.conversations)) {
      throw new Error('Invalid import file');
    }
    const response = await fetch(`${getApiBase()}/api/conversations/import`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      throw new Error(await errorDetail(response, 'Failed to import conversations'));
    }
    return response.json();
  },

  async sendMessageStream(
    conversationId,
    content,
    images = [],
    files = [],
    onEvent,
  ) {
    const response = await fetch(
      `${getApiBase()}/api/conversations/${conversationId}/message/stream`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          content,
          images,
          files,
        }),
      }
    );

    if (!response.ok) {
      throw new Error(await errorDetail(response, 'Failed to send message'));
    }

    await this._processSSEStream(response, onEvent);
  },

  async retryStage(conversationId, stage, messageIndex, onEvent) {
    const response = await fetch(
      `${getApiBase()}/api/conversations/${conversationId}/retry/stage${stage}/stream`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ message_index: messageIndex }),
      }
    );

    if (!response.ok) {
      throw new Error(
        await errorDetail(response, `Failed to retry stage ${stage}`)
      );
    }

    await this._processSSEStream(response, onEvent);
  },

  async _processSSEStream(response, onEvent) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let finished = false;
    const onStreamEvent = (eventType, event) => {
      if (isTerminalEvent(eventType)) finished = true;
      onEvent(eventType, event);
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) emitSseData(line, onStreamEvent);
    }

    if (buffer) emitSseData(buffer, onStreamEvent);
    if (!finished) {
      onEvent('error', {
        type: 'error',
        stage: null,
        message: 'The local backend closed the stream before the council finished.',
      });
    }
  },
};

function isTerminalEvent(eventType) {
  return eventType === 'complete'
    || eventType === 'error'
    || eventType === 'stage1_error'
    || eventType === 'stage2_error'
    || eventType === 'stage3_error';
}

function emitSseData(line, onEvent) {
  if (!line.startsWith('data: ')) return;
  const data = line.slice(6);
  if (!data.trim()) return;
  try {
    const event = JSON.parse(data);
    onEvent(event.type, event);
  } catch (exc) {
    console.error('Failed to parse SSE event:', exc, 'Data:', data.substring(0, 100));
  }
}
