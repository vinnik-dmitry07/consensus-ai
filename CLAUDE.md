# CLAUDE.md - Technical Notes for LLM Council

This file contains technical details, architectural decisions, and important implementation notes for future development sessions.

## Project Overview

LLM Council is a 3-stage deliberation system where multiple LLMs collaboratively answer user questions. The key innovation is anonymized peer review in Stage 2, preventing models from playing favorites.

## Architecture

### Backend Structure (`backend/`)

**`config.py`**
- Contains `COUNCIL_MODELS` (list of OpenRouter model identifiers)
- Contains `CHAIRMAN_MODEL` (model that synthesizes final answer)
- Contains `N_SAMPLES` (independent Stage 1 answers collected per model)
- Contains `TOP_K`, `RED_TEAM_MODEL` (None = chairman), `SELF_EXCLUSION`
- Uses environment variable `OPENROUTER_API_KEY` from `.env`
- Backend runs on **port 8001** (NOT 8000 - user had another app on 8000)

**`openrouter.py`**
- `query_model()`: Single async model query
- `query_models_parallel()`: Parallel queries using `asyncio.gather()`
- Returns dict with 'content' and optional 'reasoning_details'
- Graceful degradation: returns None on failure, continues with successful responses
- `model_family()`: vendor segment of an OpenRouter id (`anthropic/…`), used for
  self-exclusion and red-team selection — never compare raw model ids for this
- `parse_retry_after()`: 429 backoff from the header; seconds or HTTP-date, and
  clamped to `MAX_RETRY_AFTER_SECONDS` so one header cannot stall a run

**`council.py`** - The Core Logic
- `stage1_collect_responses()`: Parallel queries to all council models
- `usable_stage1_results()`: Prior samples a resume may reuse — drops models no longer on the council and samples beyond the current `n_samples`
- `build_judge_view()`: Per-judge candidate set — exclude own vendor family (`model_family`), then seeded shuffle (`sha256(judge + query)`)
- `stage2_collect_rankings()`: Thin wrapper over the streaming impl
  - Each judge gets its own anonymized `Response 1..M` labels (`label_to_index` maps to canonical Stage 1 indices)
  - Prompt asks for correctness 0–10, issues, disputed claims, then `FINAL RANKING:`
  - Canonical `label_to_model` stays `Response i+1` → model in Stage 1 order
- `calculate_aggregate_rankings()`: Per-response normalized Borda + mean correctness + top-1 votes; per-model macro average
- `red_team_review()`: Adversarial pass vs the leader (`VERDICT` / `CONFIDENCE`); non-fatal on failure
- `compute_consensus()`: Council confidence `HIGH` / `MEDIUM` / `LOW` / `CONTESTED` (never "verified"). `HIGH` requires a red-team verdict — if the red team did not run, confidence is capped at `MEDIUM`
- `run_post_ranking()`: Aggregation + red team + consensus used by every entry point
- `stage3_synthesize_final()`: Chairman sees anonymized top-K only; Candidate #1 is the base draft
- `parse_ranking_from_text()` / `parse_correctness_scores()` / `parse_issues()` / `parse_disputed_claims()`

**`storage.py`**
- JSON-based conversation storage in `data/conversations/`
- `update_streaming_message()` uses the `UNSET` sentinel: an omitted field is
  left alone, an explicit `None` clears it. Retries rely on this to wipe the run
  they replace — passing `None` must not silently no-op
- Each conversation: `{id, created_at, messages[]}`
- Assistant messages contain: `{role, stage1, stage2, stage3, metadata}`
- Metadata persisted: `label_to_model`, `response_rankings`, `aggregate_rankings`, `top_k_indices`, `red_team`, `consensus`

**`main.py`**
- FastAPI app with CORS enabled for localhost:5173 and localhost:3000
- POST `/api/conversations/{id}/message` returns metadata in addition to stages
- Streaming emits `redteam_start` / `redteam_complete` / `redteam_error` between Stage 2 and 3
- Retry Stage 3 recomputes post-ranking (including red team)
- `_rebuild_council_query()`: every retry endpoint rebuilds the *original* query. A message stored with `follow_up_to` is recomposed against that earlier final answer; if it is gone, the retry is refused with 400 rather than silently re-asking a bare fragment
- Each retry clears the stages it replaces (Stage 1 retry clears stage2/stage3/metadata, Stage 2 retry clears stage3, Stage 3 retry clears stage3), so a failed retry never leaves the previous run's answer on the message

### Frontend Structure (`frontend/src/`)

**`App.jsx`**
- Main orchestration: manages conversations list and current conversation
- Handles message sending, streaming events (including red-team), and metadata in UI state

**`components/ChatInterface.jsx`**
- Multiline textarea (3 rows, resizable)
- Enter to send, Shift+Enter for new line
- User messages wrapped in markdown-content class for padding

**`components/Stage1.jsx`**
- Tab view of individual model responses
- ReactMarkdown rendering with markdown-content wrapper

**`components/Stage2.jsx`**
- **Critical Feature**: Tab view showing RAW evaluation text from each model
- De-anonymization is CLIENT-SIDE via each judge's `label_to_index` (identity fallback for old messages)
- Shows extracted ranking, per-response correctness, and that judge's disputed claims
- Street Cred is a macro score + mean correctness per model
- Top-K candidate list and council-confidence / red-team panel
- Explanatory text clarifies that boldface model names are for readability only

**`components/Stage3.jsx`**
- Final synthesized answer from chairman
- Council-confidence badge and "Based on" leader (+ remaining candidates)
- Green-tinted background to highlight conclusion

**Styling (`*.css`)**
- Light mode theme (not dark mode)
- Primary color: #4a90e2 (blue)
- Global markdown styling in `index.css` with `.markdown-content` class
- 12px padding on all markdown content to prevent cluttered appearance

## Key Design Decisions

### Stage 2 Prompt Format
The Stage 2 prompt is specific so both ranking and correctness parse reliably:
```
1. Per-response evaluation + Correctness: N/10 + Issues
2. DISPUTED CLAIMS: (or none) — agreement is not evidence of correctness
3. FINAL RANKING: numbered "1. Response k" list, nothing after
```

Self-exclusion drops every answer from the judge's own vendor (`model_family`, i.e. the author segment of the OpenRouter id), so two Anthropic models never grade each other. If that would leave a judge with nothing to rank, exclusion is skipped for that judge and `self_excluded` is False. Each judge sees a seeded shuffle of the remaining answers.

### De-anonymization Strategy
- Each judge receives its own `Response 1..M` labels after shuffle
- Stage 2 results store `label_to_index` (judge label → canonical Stage 1 index)
- Canonical metadata mapping: `{"Response 1": "openai/gpt-latest", ...}` in Stage 1 order
- Frontend displays model names in **bold** for readability
- Chairman prompt stays anonymized (`Candidate #1..#K`); no model names

### Ranking → answer
- Per-response score = mean normalized Borda `(M_j - pos) / (M_j - 1)`
- Top-K (default 3) go to the chairman; #1 is the base draft
- Red team tries to refute the leader; consensus level is shown as council confidence

### Error Handling Philosophy
- Continue with successful responses if some models fail (graceful degradation)
- Never fail the entire request due to single model failure
- Log errors but don't expose to user unless all models fail

### UI/UX Transparency
- All raw outputs are inspectable via tabs
- Parsed rankings shown below raw text for validation
- Users can verify system's interpretation of model outputs
- This builds trust and allows debugging of edge cases

## Important Implementation Details

### Relative Imports
All backend modules use relative imports (e.g., `from .config import ...`) not absolute imports. This is critical for Python's module system to work correctly when running as `python -m backend.main`.

### Port Configuration
- Backend: 8001 (changed from 8000 to avoid conflict)
- Frontend: 5173 (Vite default)
- Update both `backend/main.py` and `frontend/src/api.js` if changing

### Markdown Rendering
All ReactMarkdown components must be wrapped in `<div className="markdown-content">` for proper spacing. This class is defined globally in `index.css`.

### Model Configuration
Models are hardcoded in `backend/config.py`. Chairman can be same or different from council members. The current default is Gemini as chairman per user preference.

## Common Gotchas

1. **Module Import Errors**: Always run backend as `python -m backend.main` from project root, not from backend directory
2. **CORS Issues**: Frontend must match allowed origins in `main.py` CORS middleware
3. **Ranking Parse Failures**: If models don't follow format, fallback regex extracts any "Response X" patterns; if no ranking parses, Stage 1 order is used (`ranking_fallback`)
4. **Old conversations**: UI falls back to identity label mapping and hides consensus / top-K / red-team panels when metadata is missing
5. **Resume after a settings change**: Stage 1 retry reuses stored samples, but only for models still on the council and only up to the current `n_samples`; the surviving set is written back so Stage 1 on disk matches what Stage 2 ranked

## Future Enhancement Ideas

- Configurable council/chairman via UI instead of config file
- Streaming responses instead of batch loading
- Export conversations to markdown/PDF
- Model performance analytics over time
- Custom ranking criteria (not just accuracy/insight)
- Support for reasoning models (o1, etc.) with special handling

## Testing Notes

Use `test_openrouter.py` to verify API connectivity and test different model identifiers before adding to council. The script tests both streaming and non-streaming modes.

## Data Flow Summary

```
User Query
    ↓
Stage 1: Parallel queries → [individual responses]
    ↓
Stage 2: Per-judge exclude-own-family + shuffle → grade + rank
    ↓
Aggregate (normalized Borda, correctness, top-1) → top-K
    ↓
Red team vs leader → council confidence (HIGH/MEDIUM/LOW/CONTESTED)
    ↓
Stage 3: Chairman anchored on Candidate #1 using top-K + consensus
    ↓
Return: {stage1, stage2, stage3, metadata}
    ↓
Frontend: Tabs, Street Cred, confidence badge, red-team panel
```

The entire flow is async/parallel where possible to minimize latency.
