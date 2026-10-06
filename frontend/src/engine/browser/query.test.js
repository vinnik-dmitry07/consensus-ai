import { describe, expect, it } from 'vitest';

import {
  composeFollowUpQuery,
  rebuildCouncilQuery,
  usableFinalAnswer,
} from './query.js';

describe('usable final answer', () => {
  it('rejects missing and error payloads', () => {
    expect(usableFinalAnswer(null)).toBeNull();
    expect(usableFinalAnswer({ model: 'error', response: 'x' })).toBeNull();
    expect(usableFinalAnswer({ response: '' })).toBeNull();
    expect(usableFinalAnswer({ response: '   ' })).toBeNull();
    expect(usableFinalAnswer({ response: 'Error: failed' })).toBeNull();
    expect(usableFinalAnswer({
      response: 'All models failed to respond. Please try again.',
    })).toBeNull();
    expect(usableFinalAnswer({ response: ['not', 'text'] })).toBeNull();
  });

  it('accepts a real answer', () => {
    expect(usableFinalAnswer({ model: 'chairman', response: 'Yes.' })).toBe('Yes.');
  });
});

describe('rebuildCouncilQuery', () => {
  const conversation = {
    messages: [
      { role: 'user', content: 'What is the capital of France?' },
      { role: 'assistant', stage3: { model: 'chair', response: 'The capital of France is Paris.' } },
      { role: 'user', content: 'What about its population?', follow_up_to: 1 },
    ],
  };

  it('recomposes a follow-up against the earlier answer', () => {
    const rebuilt = rebuildCouncilQuery(conversation, 2);
    expect(rebuilt.queryText).toBe(composeFollowUpQuery(
      'The capital of France is Paris.',
      'What about its population?',
    ));
  });

  it('leaves a plain message alone', () => {
    const rebuilt = rebuildCouncilQuery(conversation, 0);
    expect(rebuilt.queryText).toBe('What is the capital of France?');
  });

  it('refuses when the earlier answer is gone', () => {
    const broken = structuredClone(conversation);
    broken.messages[1].stage3 = null;
    expect(() => rebuildCouncilQuery(broken, 2)).toThrow(/Retry that message first/);
  });
});
