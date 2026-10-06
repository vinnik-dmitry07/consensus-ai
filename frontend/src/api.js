/**
 * API client for the LLM Council.
 *
 * The method surface stays stable. Calls go to whichever engine is selected
 * (in-browser IndexedDB, or the local Python backend).
 */

import { getEngine } from './engine/index.js';

function engine() {
  return getEngine();
}

export const api = {
  getCredits() {
    return engine().getCredits();
  },

  getPricing() {
    return engine().getPricing();
  },

  getAvailableModels() {
    return engine().getAvailableModels();
  },

  getSettings() {
    return engine().getSettings();
  },

  updateSettings(settings) {
    return engine().updateSettings(settings);
  },

  resetSettings() {
    return engine().resetSettings();
  },

  forgetApiKey() {
    const current = engine();
    if (typeof current.forgetApiKey !== 'function') {
      throw new Error('This engine does not store an API key in the browser');
    }
    return current.forgetApiKey();
  },

  listConversations() {
    return engine().listConversations();
  },

  createConversation() {
    return engine().createConversation();
  },

  getConversation(conversationId) {
    return engine().getConversation(conversationId);
  },

  removeConversation(conversationId) {
    return engine().removeConversation(conversationId);
  },

  exportConversations() {
    return engine().exportConversations();
  },

  importConversations(payload) {
    return engine().importConversations(payload);
  },

  sendMessageStream(conversationId, content, images, files, onEvent) {
    return engine().sendMessageStream(
      conversationId,
      content,
      images,
      files,
      onEvent,
    );
  },

  retryStage(conversationId, stage, messageIndex, onEvent) {
    return engine().retryStage(conversationId, stage, messageIndex, onEvent);
  },
};
