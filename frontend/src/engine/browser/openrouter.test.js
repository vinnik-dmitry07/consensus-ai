import { afterEach, describe, expect, it, vi } from 'vitest';

import { browserEngine } from './engine.js';
import {
  CatalogueUnavailable,
  hasVisibleContent,
  modelFamily,
  OPENROUTER_MAX_TOKENS,
  OPENROUTER_MAX_TOKENS_HIGH,
  parseHttpError,
  parseRetryAfter,
  queryModelResult,
  resolveMaxTokens,
  unknownCatalogueIds,
} from './openrouter.js';
import { settings } from './settings.js';

function jsonResponse(status, body, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

describe('model family', () => {
  it('treats the same vendor as one family', () => {
    expect(modelFamily('anthropic/claude-opus-4.1')).toBe(
      modelFamily('anthropic/claude-sonnet-4.5'),
    );
  });

  it('collapses reasoning variants and the alias prefix', () => {
    expect(modelFamily('~openai/gpt-sol-latest-reasoning-high')).toBe(
      modelFamily('openai/gpt-sol-latest'),
    );
  });

  it('keeps different vendors apart', () => {
    expect(modelFamily('google/gemini-pro-latest')).not.toBe(
      modelFamily('x-ai/grok-latest'),
    );
  });

  it('falls back to the id when there is no author', () => {
    expect(modelFamily('some-local-model')).toBe('some-local-model');
  });
});

describe('parseRetryAfter', () => {
  it('honours a seconds value', () => {
    expect(parseRetryAfter('7', 99)).toBe(7);
  });

  it('accepts an HTTP date without throwing', () => {
    const value = parseRetryAfter('Wed, 21 Oct 2015 07:28:00 GMT', 4);
    expect(value).toBeGreaterThanOrEqual(0);
  });

  it('falls back when the header is garbage', () => {
    expect(parseRetryAfter('soon', 4)).toBe(4);
  });

  it('falls back when the header is missing', () => {
    expect(parseRetryAfter(null, 8)).toBe(8);
  });

  it('clamps an absurd wait', () => {
    expect(parseRetryAfter('86400', 2)).toBe(60);
  });
});

describe('parseHttpError', () => {
  it('uses the reserved-tokens message for 402', async () => {
    const response = jsonResponse(402, {
      error: {
        message: 'This request requires more credits, or fewer max_tokens. You requested up to 65536 tokens, but can only afford 2194.',
      },
    });
    const error = await parseHttpError(response);
    expect(error.status).toBe(402);
    expect(error.message).toBe('402: cannot afford reserved tokens');
    expect(error.detail).toContain('fewer max_tokens');
  });

  it('names a 404', async () => {
    const error = await parseHttpError(jsonResponse(404, {
      error: { message: 'No endpoints found' },
    }));
    expect(error.message).toBe('Model not found (404)');
    expect(error.detail).toBe('No endpoints found');
  });

  it('keeps a non-json body', async () => {
    const response = new Response('upstream exploded', { status: 500 });
    const error = await parseHttpError(response);
    expect(error.status).toBe(500);
    expect(error.message).toContain('upstream exploded');
  });
});

describe('resolveMaxTokens', () => {
  it('defaults to 16k', () => {
    expect(resolveMaxTokens('~openai/gpt-latest')).toBe(OPENROUTER_MAX_TOKENS);
  });

  it('uses 32k for reasoning-high', () => {
    expect(resolveMaxTokens('~anthropic/claude-fable-latest-reasoning-high')).toBe(
      OPENROUTER_MAX_TOKENS_HIGH,
    );
  });

  it('lets an override win', () => {
    expect(resolveMaxTokens('any-reasoning-high', 4096)).toBe(4096);
  });
});

describe('hasVisibleContent', () => {
  it('rejects empty and non-text payloads', () => {
    expect(hasVisibleContent('')).toBe(false);
    expect(hasVisibleContent('   ')).toBe(false);
    expect(hasVisibleContent(null)).toBe(false);
    expect(hasVisibleContent([])).toBe(false);
    expect(hasVisibleContent({ text: 'x' })).toBe(false);
  });

  it('accepts text', () => {
    expect(hasVisibleContent('hello')).toBe(true);
  });
});

describe('queryModelResult', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns a structured 402 error', async () => {
    settings.apiKey = 'sk-test';
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(402, {
      error: { message: 'This request requires more credits' },
    })));
    const result = await queryModelResult('~x-ai/grok-latest', [
      { role: 'user', content: 'q' },
    ]);
    expect(result.ok).toBe(false);
    expect(result.error.message).toBe('402: cannot afford reserved tokens');
  });

  it('treats empty content as failure', async () => {
    settings.apiKey = 'sk-test';
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, {
      choices: [{ message: { content: '' } }],
      usage: {},
    })));
    const result = await queryModelResult('~openai/gpt-latest', [
      { role: 'user', content: 'q' },
    ]);
    expect(result.ok).toBe(false);
    expect(result.error.message).toBe('Empty model response');
  });

  it('sends xhigh effort for an Anthropic reasoning-high model', async () => {
    settings.apiKey = 'sk-test';
    const fetchMock = vi.fn(async () => jsonResponse(200, {
      choices: [{ message: { content: 'yes' } }],
      usage: {},
    }));
    vi.stubGlobal('fetch', fetchMock);
    await queryModelResult('~anthropic/claude-opus-latest-reasoning-high', [
      { role: 'user', content: 'q' },
    ]);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.model).toBe('~anthropic/claude-opus-latest');
    expect(body.reasoning).toEqual({ effort: 'xhigh' });
    expect(body.max_tokens).toBe(OPENROUTER_MAX_TOKENS_HIGH);
    expect(fetchMock.mock.calls[0][1].headers['X-Title']).toBe('consensus.ai');
  });

  it('leaves phi-4-reasoning-plus unchanged and sends no reasoning field', async () => {
    settings.apiKey = 'sk-test';
    const fetchMock = vi.fn(async () => jsonResponse(200, {
      choices: [{ message: { content: 'yes' } }],
      usage: {},
    }));
    vi.stubGlobal('fetch', fetchMock);
    await queryModelResult('microsoft/phi-4-reasoning-plus', [
      { role: 'user', content: 'q' },
    ]);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.model).toBe('microsoft/phi-4-reasoning-plus');
    expect(body.reasoning).toBeUndefined();
    expect(body.max_tokens).toBe(OPENROUTER_MAX_TOKENS);
  });

  it('treats a 200 without choices as an empty response', async () => {
    settings.apiKey = 'sk-test';
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, { usage: {} })));
    const result = await queryModelResult('openai/gpt-real', [
      { role: 'user', content: 'q' },
    ]);
    expect(result.ok).toBe(false);
    expect(result.error.message).toBe('Empty model response');
  });
});

describe('catalogue validation', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('raises when pricing is empty', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, { data: [] })));
    await expect(unknownCatalogueIds(['~openai/gpt-sol-latest'])).rejects.toBeInstanceOf(
      CatalogueUnavailable,
    );
  });

  it('rejects an unknown council id and leaves settings alone', async () => {
    settings.councilModels = ['openai/gpt-real'];
    settings.chairmanModel = 'openai/gpt-real';
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, {
      data: [{ id: 'openai/gpt-real', name: 'Real', pricing: {}, description: '' }],
    })));
    await expect(browserEngine.updateSettings({
      council_models: ['openai/missing'],
    })).rejects.toThrow(/Unknown models/);
    expect(settings.councilModels).not.toContain('openai/missing');
  });

  it('accepts a known chairman id', async () => {
    settings.councilModels = ['openai/gpt-real'];
    settings.chairmanModel = 'openai/gpt-real';
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, {
      data: [{ id: 'openai/gpt-real', name: 'Real', pricing: {}, description: '' }],
    })));
    const updated = await browserEngine.updateSettings({
      chairman_model: 'openai/gpt-real',
    });
    expect(updated.chairman_model).toBe('openai/gpt-real');
  });

  it('rejects every change when the catalogue is unavailable', async () => {
    const before = [...settings.councilModels];
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, { data: [] })));
    await expect(browserEngine.updateSettings({ n_samples: 2 })).rejects.toThrow(
      /catalogue unavailable/i,
    );
    expect(settings.councilModels).toEqual(before);
    expect(settings.nSamples).toBe(3);
  });
});

describe('credits', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('includes key limit fields', async () => {
    settings.apiKey = 'sk-test-key-value';
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      if (String(url).includes('/credits')) {
        return jsonResponse(200, { data: { total_credits: 10, total_usage: 3 } });
      }
      return jsonResponse(200, {
        data: { limit: 5, limit_remaining: 1.25, limit_reset: 'daily' },
      });
    }));
    const body = await browserEngine.getCredits();
    expect(body.remaining).toBe(7);
    expect(body.limit_remaining).toBe(1.25);
    expect(body.limit_reset).toBe('daily');
  });

  it('keeps credits when the key lookup fails', async () => {
    settings.apiKey = 'sk-test-key-value';
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      if (String(url).includes('/credits')) {
        return jsonResponse(200, { data: { total_credits: 4, total_usage: 1 } });
      }
      return new Response('nope', { status: 500 });
    }));
    const body = await browserEngine.getCredits();
    expect(body.remaining).toBe(3);
    expect(body.limit_remaining).toBeUndefined();
  });
});
