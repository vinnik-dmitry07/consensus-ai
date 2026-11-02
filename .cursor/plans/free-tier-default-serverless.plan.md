---
name: Free-tier serverless default
overview: New in-browser (serverless) settings should start as the existing Top 10 Free roster so a first visit can run without a personal OpenRouter key. Keep the paid factory list for Top 8 Paid and leave the FastAPI backend defaults unchanged. Saved localStorage rosters stay as stored.
todos:
  - id: flag-unset-roster
    content: Add a persisted use_free_tier_default flag in frontend/src/engine/browser/settings.js so unset/fresh state is distinct from a saved paid roster, and clear it on council/chairman writes.
    status: pending
  - id: shared-free-roster
    content: Extract the Settings Top 10 Free roster shape into roster.js and reuse it from Settings.jsx and the browser engine apply path.
    status: pending
  - id: apply-on-browser-paths
    content: Apply that roster from the live catalogue on browser getSettings, resetSettings, send, and retry — only while the unset flag is true.
    status: pending
  - id: tests-and-verify
    content: Cover unset vs saved vs reset vs empty catalogue in existing Vitest files and run frontend tests.
    status: pending
---
## Goal

On the in-browser engine (GitHub Pages / any static `frontend/dist` host, and `npm run dev` which uses the same engine), a user with no saved roster should get the existing **Top 10 Free** selection: `rankTopFreeModels` council, chairman `${top[0]}-reasoning-high`, `n_samples = 1`, red team left `null`. That roster is all `:free`, so `runAllowedBySettings` / `requireApiKey` allow a run via `FREE_TIER_API_KEY` without a personal key.

Users who already persisted a council (paid or custom) keep it. The local FastAPI factory in `backend/config.py` / `backend/settings.py` stays paid.

## Assumptions

- **Serverless target is the browser engine**, not a separate Vercel/Cloudflare app. `frontend/src/engine/index.js` defaults `getEngineMode()` to `'browser'` unless localStorage `llm-council-engine` is `'local'`. Settings labels that mode "In-browser (serverless)". `.github/workflows/pages.yml` ships `frontend/dist`. README says the same bundle also deploys to Vercel/Netlify/Cloudflare Pages. One JS change covers all of those.
- **Free tier is the existing Top 10 Free product**, not a new price list. `Settings.jsx` `selectTopFreeModels` already calls `rankTopFreeModels(availableModels, readBlockedIds())`, sets `nSamples` to `1`, and sets chairman to `` `${top[0]}-reasoning-high` ``. Do not hardcode catalogue ids.
- **`DEFAULT_COUNCIL_MODELS` / `DEFAULT_CHAIRMAN_MODEL` stay the paid factory** used by **Top 8 Paid**. Do not repurpose those constants as free ids.
- **Unset vs saved is not "STORAGE_KEY missing".** `persist()` writes the whole state on any setter (`apiKey`, `nSamples`, …). A new visitor who only stores a key would otherwise look "saved" with the paid `freshState()` council. A dedicated flag is the dimension that tells those apart.
- **`freshState()` / `resetToDefaults()` are new settings.** After this change they mark the roster pending-free. `resetSettings()` then applies Top 10 Free from the catalogue (same as first visit). **Top 8 Paid** remains the way to restore the paid eight.
- **Local backend is out of scope.** `remoteEngine.getSettings()` / `backend/settings.py` keep today's paid `COUNCIL_MODELS`. `Settings.jsx` must not auto-apply free when `getEngineMode() === 'local'`.
- **`npm run dev` uses the browser engine by default**, so localhost Vite gets the free default too. Do not gate on `VITE_BASE` or hostname.
- **Catalogue failure:** leave the pending flag true and do not treat the in-memory paid factory as a saved choice. The send gate stays blocked (`rosterRequiresUserKey` is true for `DEFAULT_COUNCIL_MODELS`) until free models can be ranked. Do not invent fallback ids.
- **`TITLE_MODEL`** (`google/gemini-2.5-flash`) stays paid. `generateConversationTitle` already returns `'New Conversation'` when `keyForModel(TITLE_MODEL)` is missing. No change.
- **No new repo files** except tests in existing `*.test.js` files. Single quotes in JS.

## Changes

### `frontend/src/engine/browser/settings.js`

Today `freshState()` (used when `localStorage` has no `llm-council-browser-settings`, when JSON parse throws, and from `resetToDefaults`) copies the paid lists:

- `council_models`: `DEFAULT_COUNCIL_MODELS` (`~openai/gpt-sol-latest`, …)
- `chairman_model`: `DEFAULT_CHAIRMAN_MODEL` (`~anthropic/claude-fable-latest-reasoning-high`)
- `n_samples`: `3`

`load()` starts from `freshState()` then overlays parsed fields. A stored document **without** `council_models` would keep that paid overlay — after this work it must not look like a finished paid save.

Edits:

- Add `use_free_tier_default` on the in-memory object (snake_case like `council_models`).
- `freshState()`: keep the paid factory fields as the pre-apply placeholder (so Top 8 Paid constants stay the in-memory fallback) **and** set `use_free_tier_default: true`.
- `load()`:
  - no raw / parse catch → `freshState()` (flag true).
  - parsed JSON → start from a **non-pending** copy (`use_free_tier_default: false`), overlay fields as now, then set `use_free_tier_default` only if `parsed.use_free_tier_default === true` (strict boolean; localStorage is hostile).
- `persist()`: continue `JSON.stringify(current())` so the flag is stored when true. `toDict()` must **omit** the flag (same public shape as today).
- `resetToDefaults()`: `freshState()` then restore `api_key` (already does). Flag is true again.
- Clear the flag (and persist) in the `councilModels` and `chairmanModel` setters only. That is a user/test roster write. Do **not** clear it from `apiKey`, `nSamples`, `topK`, `redTeamModel`, or `selfExclusion`.
- `updateFromDict`: if `'council_models'` or `'chairman_model'` is in `data`, the setters clear the flag. No extra path needed if those setters own the flag.
- Export a read-only getter, e.g. `settings.useFreeTierDefault`, for the engine. Do not import `roster.js` from this file (roster already imports settings).

### `frontend/src/engine/browser/roster.js`

Add one helper next to `rankTopFreeModels` (limit default 10 unchanged):

```js
export function freeTierDefaultRoster(models, blockedIds) {
  const councilModels = rankTopFreeModels(models, blockedIds);
  return {
    councilModels,
    chairmanModel: councilModels[0] ? `${councilModels[0]}-reasoning-high` : '',
    nSamples: 1,
  };
}
```

This is the exact shape `selectTopFreeModels` already builds. Empty `councilModels` → empty chairman; caller must not persist that as a finished roster.

Optional tiny `applyFreeTierDefaultRoster(models)` here that writes `settings.councilModels` / `nSamples` / `chairmanModel` (setters clear the flag) then `notifySettingsChanged()` once. Prefer this over three silent writes so ChatInterface/`settingsVersion` refresh after apply. If apply is empty, return false and leave the flag true.

Do not change `rosterRequiresUserKey` / `runAllowedBySettings`. Empty council and the paid factory already require a personal key.

### `frontend/src/engine/browser/engine.js`

Catalogue rows already have `id`, `name`, `description` in `getAvailableModels` (needed by `extractSize` inside `rankTopFreeModels`). Reuse that mapping.

Add `async function ensureFreeTierDefaults()`:

1. If `!settings.useFreeTierDefault`, return.
2. `pricing = await openrouter.getModelsPricing()`.
3. If `!pricing` or no keys, return (flag stays true).
4. Build `{ id, name, description }` rows the same way as `getAvailableModels`.
5. `roster = freeTierDefaultRoster(rows, readBlockedIds())`.
6. If `!roster.councilModels.length`, return (flag stays true).
7. Write council, `nSamples = 1`, chairman; notify once.

Call it **before** `requireApiKey()` on `sendMessageStream` and `retryStage` (today both call `requireApiKey()` at the top with the in-memory paid factory, which throws `API_KEY_REQUIRED`). Also call it at the start of `ensureServableRoster` so prune runs on the free list, not the placeholder paid eight.

Make `getSettings` async:

```js
async getSettings() {
  await ensureFreeTierDefaults();
  return settings.toDict();
}
```

Every UI caller already uses `await Promise.resolve(api.getSettings())` (`App.jsx` `readCanRun`, `ChatInterface.jsx` gate effect, `Settings.jsx` `loadData`, `Sidebar.jsx` credits). `remoteEngine.getSettings` is already async.

Make `resetSettings` async: `resetToDefaults()` then `ensureFreeTierDefaults()` then `toDict()`. `Settings.jsx` `handleReset` already awaits it.

Do not apply free defaults in `updateSettings` when the client sent an explicit council.

### `frontend/src/components/Settings.jsx`

- `selectTopFreeModels`: call `freeTierDefaultRoster` instead of duplicating rank/chairman/`setNSamples(1)`.
- `selectTopPaidModels`: unchanged (`DEFAULT_COUNCIL_MODELS`, `DEFAULT_N_SAMPLES`, `DEFAULT_CHAIRMAN_MODEL`).
- `loadData`: keep `Promise.all([api.getSettings(), api.getAvailableModels()])`. After `getSettings` is async+ensure, `settingsData` is already the free roster on first visit. `getModelsPricing` is cached, so the parallel catalogue fetch is fine.
- Do not add a second apply in `loadData` (avoids racing `getSettings`). Local engine is automatically skipped because ensure lives only on `browserEngine`.

No Settings UI copy is required. Optional one-line README note under Serverless that the default council is free and does not need a personal key — only if you already touch docs; not required for the behavior change.

### Do not edit

- `backend/config.py` `COUNCIL_MODELS` / `CHAIRMAN_MODEL`
- `backend/settings.py` `reset_to_defaults`
- `frontend/src/engine/index.js` engine-mode default (already browser)

## Verification

From `frontend/`:

```bash
npm test
```

Add cases in existing files (no new test file):

**`frontend/src/engine/browser/engine.test.js` (or `roster.test.js`)**

- Unset (cleared storage + `resetSettingsState`): mock `getModelsPricing` with several `:free` rows (names/sizes like `roster.test.js`); `await browserEngine.getSettings()` equals `freeTierDefaultRoster(...)` (council, chairman suffix, `n_samples === 1`); stored JSON has `use_free_tier_default !== true`; `runAllowedBySettings(toDict())` is true with `has_api_key: false`.
- Saved paid: persist `council_models: DEFAULT_COUNCIL_MODELS` **without** the flag (today's existing-user document); `getSettings` must not replace them; `runAllowedBySettings` stays false without a key.
- Saved paid that happens to equal the factory **with** `use_free_tier_default: true` (reset / first persist before apply): apply **does** replace with free.
- Setter: after `settings.councilModels = ['openai/gpt-4.1']`, flag is false and ensure must not overwrite.
- Empty catalogue / `{}`: flag stays true; council remains the paid placeholder; `getSettings` does not persist a finished free roster; send gate still blocked.
- `resetSettings()` after a saved paid council: pending then apply free again.
- `sendMessageStream` with unset flag and a free catalogue: first `requireApiKey` must not throw; do not start from the paid eight.

**`frontend/src/engine/browser/roster.test.js`**

- `freeTierDefaultRoster` matches current button rules (chairman is first ranked id + `-reasoning-high`, `nSamples` 1, empty input → empty council).
- Existing `rosterRequiresUserKey` row for `DEFAULT_COUNCIL_MODELS` stays `true`.

**`frontend/src/engine/browser/storage.test.js`**

- `resetToDefaults` still keeps the api key and still sets `n_samples` to `3` **before** ensure (current assertion). Add that after `await browserEngine.resetSettings()` with a mocked free catalogue, `n_samples` is `1`.

Manual (GitHub Pages or `npm run dev`, browser engine): wipe origin `localStorage` (at least `llm-council-browser-settings`), reload, confirm Settings shows the Top 10 Free set and the composer is not "add an API key" blocked; send a short prompt; reopen after reload and confirm the same free roster (now saved). Set Top 8 Paid, save, reload — paid must remain.

## Open questions

none
