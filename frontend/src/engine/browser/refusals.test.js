import { describe, expect, it, vi } from 'vitest';

import { redTeamReview, stage2CollectRankingsStreaming, stage3SynthesizeFinal } from './council.js';
import * as openrouter from './openrouter.js';
import { rememberBlockedId, rememberModelCooldown } from './roster.js';
import { settings } from './settings.js';

const CHAIR = 'google/gemma-4-31b-it:free';
const OTHER = 'other/answer:free';
const STAGE1 = [{ model: OTHER, response: 'An answer' }];
const SKIPPED = {
  ok: false,
  skipped: true,
  error: { status: 429, message: 'Provider returned error', detail: 'upstream' },
};

describe('refused models in later stages', () => {
  it('advances skipped judge progress without storing a failure', async () => {
    settings.councilModels = [CHAIR, OTHER, 'real/failure'];
    vi.spyOn(openrouter, 'queryModelResult').mockImplementation(async (model) => {
      if (model === CHAIR) return SKIPPED;
      if (model === 'real/failure') return { ok: false, error: { message: 'HTTP 500' } };
      return { ok: true, content: 'FINAL RANKING:\n1. Response 1', usage: {} };
    });
    const events = [];
    for await (const event of stage2CollectRankingsStreaming('q', STAGE1)) events.push(event);
    const progress = events.filter(([type]) => type === 'model_complete' || type === 'model_failed');
    expect(progress).toHaveLength(3);
    expect(progress.find(([, data]) => data.skipped)?.[1].model).toBe(CHAIR);
    const complete = events.at(-1)[1];
    expect(complete.results).toHaveLength(1);
    expect(complete.failures).toEqual([{ model: 'real/failure', error: { message: 'HTTP 500' } }]);
  });

  it('treats a skipped red team as an unavailable review', async () => {
    settings.redTeamModel = CHAIR;
    vi.spyOn(openrouter, 'queryModelResult').mockResolvedValue(SKIPPED);
    const review = await redTeamReview('q', 'An answer', 0, [], STAGE1);
    expect(review).toBeNull();
  });
});

describe('chairman availability fallback', () => {
  it.each(['blocked', 'cooling'])('skips a %s chairman and preserves its setting', async (state) => {
    settings.chairmanModel = `${CHAIR}-reasoning-high`;
    settings.councilModels = [CHAIR, OTHER];
    if (state === 'blocked') rememberBlockedId(CHAIR);
    else rememberModelCooldown(CHAIR, 600);
    const query = vi.spyOn(openrouter, 'queryModelResult').mockResolvedValue({
      ok: true, content: 'Final answer', usage: { total_tokens: 12 },
    });
    const result = await stage3SynthesizeFinal('q', STAGE1);
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][0]).toBe(OTHER);
    expect(result).toMatchObject({ model: OTHER, response: 'Final answer', usage: { total_tokens: 12 } });
    expect(settings.chairmanModel).toBe(`${CHAIR}-reasoning-high`);
  });

  it('falls back on a newly refused chairman without repeating its reasoning variants', async () => {
    settings.chairmanModel = `${CHAIR}-reasoning-high`;
    settings.councilModels = [CHAIR, `${CHAIR}-reasoning`, OTHER];
    const query = vi.spyOn(openrouter, 'queryModelResult')
      .mockResolvedValueOnce(SKIPPED)
      .mockResolvedValueOnce({ ok: true, content: 'Final answer' });
    const result = await stage3SynthesizeFinal('q', STAGE1);
    expect(query.mock.calls.map(([model]) => model)).toEqual([`${CHAIR}-reasoning-high`, OTHER]);
    expect(result.model).toBe(OTHER);
    expect(settings.chairmanModel).toBe(`${CHAIR}-reasoning-high`);
  });

  it('surfaces a genuine chairman failure without trying council alternatives', async () => {
    settings.chairmanModel = CHAIR;
    settings.councilModels = [OTHER];
    const query = vi.spyOn(openrouter, 'queryModelResult').mockResolvedValue({
      ok: false, error: { message: 'HTTP 402' },
    });
    await expect(stage3SynthesizeFinal('q', STAGE1)).rejects.toThrow('HTTP 402');
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('reports exhaustion without dispatching known-unavailable models', async () => {
    settings.chairmanModel = CHAIR;
    settings.councilModels = [CHAIR, OTHER];
    rememberModelCooldown(CHAIR, 600);
    rememberBlockedId(OTHER);
    const query = vi.spyOn(openrouter, 'queryModelResult');
    await expect(stage3SynthesizeFinal('q', STAGE1)).rejects.toThrow('No chairman model is available');
    expect(query).not.toHaveBeenCalled();
  });

  it('stops after every distinct candidate refuses instead of looping', async () => {
    settings.chairmanModel = CHAIR;
    settings.councilModels = [CHAIR, OTHER, `${OTHER}-reasoning`];
    const query = vi.spyOn(openrouter, 'queryModelResult').mockResolvedValue(SKIPPED);
    await expect(stage3SynthesizeFinal('q', STAGE1)).rejects.toThrow('No chairman model is available');
    expect(query.mock.calls.map(([model]) => model)).toEqual([CHAIR, OTHER]);
  });
});
