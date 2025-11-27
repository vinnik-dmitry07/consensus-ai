/**
 * API client for the LLM Council backend.
 */

const API_BASE = 'http://localhost:8001';

export const api = {
  /**
   * Get OpenRouter credits balance.
   */
  async getCredits() {
    const response = await fetch(`${API_BASE}/api/credits`);
    if (!response.ok) {
      throw new Error('Failed to fetch credits');
    }
    return response.json();
  },

  /**
   * Get pricing information for council models.
   */
  async getPricing() {
    const response = await fetch(`${API_BASE}/api/pricing`);
    if (!response.ok) {
      throw new Error('Failed to fetch pricing');
    }
    return response.json();
  },

  /**
   * List all conversations.
   */
  async listConversations() {
    const response = await fetch(`${API_BASE}/api/conversations`);
    if (!response.ok) {
      throw new Error('Failed to list conversations');
    }
    return response.json();
  },

  /**
   * Create a new conversation.
   */
  async createConversation() {
    const response = await fetch(`${API_BASE}/api/conversations`, {
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

  /**
   * Get a specific conversation.
   */
  async getConversation(conversationId) {
    const response = await fetch(
      `${API_BASE}/api/conversations/${conversationId}`
    );
    if (!response.ok) {
      throw new Error('Failed to get conversation');
    }
    return response.json();
  },

  /**
   * Send a message in a conversation.
   * @param {string} conversationId - The conversation ID
   * @param {string} content - The message content
   * @param {string[]} images - Optional array of base64 image data URLs
   */
  async sendMessage(conversationId, content, images = []) {
    const response = await fetch(
      `${API_BASE}/api/conversations/${conversationId}/message`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ content, images }),
      }
    );
    if (!response.ok) {
      throw new Error('Failed to send message');
    }
    return response.json();
  },

  /**
   * Send a message and receive streaming updates.
   * @param {string} conversationId - The conversation ID
   * @param {string} content - The message content
   * @param {string[]} images - Optional array of base64 image data URLs
   * @param {function} onEvent - Callback function for each event: (eventType, data) => void
   * @returns {Promise<void>}
   */
  async sendMessageStream(conversationId, content, images = [], onEvent) {
    const response = await fetch(
      `${API_BASE}/api/conversations/${conversationId}/message/stream`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ content, images }),
      }
    );

    if (!response.ok) {
      throw new Error('Failed to send message');
    }

    await this._processSSEStream(response, onEvent);
  },

  /**
   * Retry a failed stage.
   * @param {string} conversationId - The conversation ID
   * @param {number} stage - The stage number to retry (1, 2, or 3)
   * @param {number} messageIndex - The index of the assistant message to retry
   * @param {function} onEvent - Callback function for each event
   * @returns {Promise<void>}
   */
  async retryStage(conversationId, stage, messageIndex, onEvent) {
    const response = await fetch(
      `${API_BASE}/api/conversations/${conversationId}/retry/stage${stage}/stream`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ message_index: messageIndex }),
      }
    );

    if (!response.ok) {
      throw new Error(`Failed to retry stage ${stage}`);
    }

    await this._processSSEStream(response, onEvent);
  },

  /**
   * Process an SSE stream response.
   * @private
   */
  async _processSSEStream(response, onEvent) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      // Append new chunk to buffer
      buffer += decoder.decode(value, { stream: true });
      
      // Process complete lines from buffer
      const lines = buffer.split('\n');
      
      // Keep the last potentially incomplete line in the buffer
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6);
          if (data.trim()) {
            try {
              const event = JSON.parse(data);
              onEvent(event.type, event);
            } catch (e) {
              console.error('Failed to parse SSE event:', e, 'Data:', data.substring(0, 100));
            }
          }
        }
      }
    }
    
    // Process any remaining data in the buffer
    if (buffer.startsWith('data: ')) {
      const data = buffer.slice(6);
      if (data.trim()) {
        try {
          const event = JSON.parse(data);
          onEvent(event.type, event);
        } catch (e) {
          console.error('Failed to parse final SSE event:', e);
        }
      }
    }
  },
};
