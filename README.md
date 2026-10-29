# consensus.ai

**Search Wide** — a local web app where multiple LLMs answer your question, anonymously rank each other's work, and a Chairman model synthesizes the final response.

Fork of [karpathy/llm-council](https://github.com/karpathy/llm-council) with a settings UI, streaming progress, reasoning modes, cost estimates, and OpenRouter credits in the sidebar.

## How it works

1. **Stage 1: First opinions** — Your query goes to every council model in parallel. With `N_SAMPLES > 1`, each model can produce multiple independent answers. Responses appear in a tab view.
2. **Stage 2: Peer review** — Each judge skips every answer from its own vendor, sees a shuffled anonymous list, grades correctness, lists disputed claims, and ranks the rest. Rankings become a Borda score plus a council-confidence level.
3. **Red team** — A reviewer tries to refute the leading answer (`REFUTED` / `CONTESTED` / `UPHELD`). Failure of this pass is non-fatal, but confidence is then capped at `MEDIUM`: peer agreement alone never earns `HIGH`.
4. **Stage 3: Final answer** — The Chairman starts from the top-ranked answer as a base draft, applies corrections from the remaining top-K, and must address disputed claims and the red-team verdict.

## Screenshots

### 1. Ask a question
![Ask a question](assets/1.png)

### 2. Stage 1 — individual model responses
![Stage 1 individual responses](assets/2.png)

### 3. Stage 2 — raw peer evaluations
![Stage 2 raw evaluations](assets/3.png)

### 4. Stage 2 — extracted and aggregate rankings
![Stage 2 aggregate rankings](assets/4.png)

### 5. Stage 3 — final council answer
![Stage 3 final answer](assets/5.png)

### 6. Settings — council models
![Settings council models](assets/6.png)

### 7. Settings — chairman model
![Settings chairman model](assets/7.png)

### 8. Token usage breakdown
![Token usage breakdown](assets/8.png)

## Features

- **Settings UI** — Pick council models, chairman, samples per model, top-K, self-exclusion, red-team model, and API key without editing code
- **Reasoning modes** — Each model supports **Base**, **R** (medium reasoning), and **R+** (high reasoning) via `-reasoning` / `-reasoning-high` suffixes
- **Quick presets** — Top 10 Free and Top 8 Paid model shortcuts in Settings
- **Streaming** — Live progress during Stage 1–3; resume interrupted runs from where they stopped
- **Cost estimate** — Estimated OpenRouter cost shown before you send (based on council + chairman pricing)
- **Credits display** — OpenRouter balance in the sidebar
- **Attachments** — Paste or attach images and small text files with your prompt
- **Dark mode** — Toggle in the sidebar
- **Serverless** — The council runs in the browser by default, so the built site needs no Python server

## Serverless mode

The default engine calls [openrouter.ai](https://openrouter.ai/) directly from the browser. Conversations live in IndexedDB and settings (including the API key) live in localStorage on that device. Nothing is sent to a backend you host.

```bash
cd frontend
npm install
npm run dev
```

Open **http://localhost:5173**, then set your OpenRouter key in **Settings**. The key stays in this browser's localStorage and is sent only to OpenRouter. localStorage is per origin, so a GitHub Pages project site (`https://<user>.github.io/consensus-ai/`) shares that storage with every other Pages site on the account. **Forget key** in Settings removes it.

**Settings → Engine** switches to the local Python backend (`http://localhost:8001` by default). That mode is for `npm run dev`: a site served over https cannot call `http://localhost`. The two engines keep separate conversations. **Export JSON** / **Import JSON** in Settings moves them.

A production build is a static `frontend/dist` folder (`npm run build`). GitHub Pages builds it with `VITE_BASE=/consensus-ai/` via `.github/workflows/pages.yml`. That host is one origin for the whole account, so the API key and conversations are readable by the account's other Pages sites. The same `dist` deploys to Vercel, Netlify, or Cloudflare Pages at the site root without that prefix, each on its own origin. Routing is `?c=<conversation id>`, so the host does not need SPA rewrites.

Closing the tab mid-run leaves that message marked in progress. Retry Stage 1 resumes samples that already succeeded.

## Setup

### 1. Install dependencies

**Backend** (Python 3.10+):

```bash
# Option A: uv
uv sync

# Option B: local venv
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install "fastapi>=0.115.0" "uvicorn[standard]>=0.32.0" "python-dotenv>=1.0.0" "httpx>=0.27.0" "pydantic>=2.9.0"
```

**Frontend:**

```bash
cd frontend
npm install
cd ..
```

### 2. Configure API key

Create a `.env` file in the project root:

```bash
OPENROUTER_API_KEY=sk-or-v1-...
```

Get your key at [openrouter.ai](https://openrouter.ai/). You can also set or update the key in **Settings** at runtime (stored in memory until the backend restarts).

### 3. Configure models (optional)

Defaults live in `backend/config.py`. You can also change everything in the Settings UI without restarting.

```python
COUNCIL_MODELS = [
    "~openai/gpt-sol-latest",
    "~google/gemini-pro-latest",
    "~anthropic/claude-opus-latest",
    "~x-ai/grok-latest",
    "~openai/gpt-sol-latest-reasoning",
    "~google/gemini-pro-latest-reasoning",
    "~anthropic/claude-opus-latest-reasoning",
    "~x-ai/grok-latest-reasoning",
]

N_SAMPLES = 3

CHAIRMAN_MODEL = "~anthropic/claude-fable-latest-reasoning-high"
```

## Running the application

**Terminal 1 — backend** (port **8001**, run from project root):

```bash
# uv
uv run python -m backend.main

# or local venv
.\.venv\Scripts\python.exe -m backend.main
```

**Terminal 2 — frontend** (port **5173**):

```bash
cd frontend
npm run dev
```

Open **http://localhost:5173** in your browser.

On Linux/macOS you can also use `./start.sh` (requires `uv` and `npm` on PATH).

## Does the council beat one model? (free-tier benchmark)

`frontend/eval` runs the real browser engine on questions with an exact answer (AIME 2026, GPQA Diamond, MMLU-Pro) and compares the full council against a single model, majority votes, and one-pass self-aggregation, all on the same questions and the same frozen free-tier roster. Only one personal OpenRouter key is used, every call is journaled, and the roster, prompts, grader, and sample size are frozen before the first test question. Question text never leaves the gitignored `.cache` and `.runs` folders. Setup and commands: [frontend/eval/README.md](frontend/eval/README.md).

The section below is generated by `npm --prefix frontend run eval -- report` and is refreshed every time that command runs. Edits inside the markers are overwritten.

<!-- eval-results:start -->
### Free council vs simpler alternatives: interim snapshot, 78 of 120 test questions

Generated 2026-10-29T02:40:14.136Z from run `main`, protocol `326c6e10e56e`.
**Interim.** 42 questions are not started and 0 are paused mid-question. The pre-registered headline is defined on all 120 questions and is not available yet. Sample size, roster, prompts, grader, and the comparison family were frozen before the first test call and are not changed by this snapshot.

Scored so far: AIME 2026 19/30, GPQA Diamond 30/50, MMLU-Pro 29/40. Every arm is graded on the same questions, so the arms are directly comparable.
HTTP POSTs so far (smoke, dev, and test, including retries): 1342. Responses without a usage block: 330 (not counted as zero cost).

Frozen council (dev-selected): `nvidia/nemotron-3-ultra-550b-a55b:free-reasoning-high`, `dots-studio/dots-3-note-preview:free`, `xingchen-agi/xing4.0-29b-a4b:free`, `poolside/laguna-s-2.1:free`, `google/gemma-4-31b-it:free-reasoning-high`.
Chairman H: `nvidia/nemotron-3-ultra-550b-a55b:free-reasoning-high`. Single-model baseline B: `nvidia/nemotron-3-ultra-550b-a55b:free-reasoning-high`. H = B, so A0 reuses the A1 call and is not a separate comparison.

#### Accuracy by arm

| Arm | What it is | Calls per question | Pooled | Macro (mean of blocks) | AIME | GPQA | MMLU-Pro |
| --- | --- | --- | --- | --- | --- | --- | --- |
| A0 | Chairman model H answers the question directly (same call as A1 here) | 1 | 67.9% | 67.6% | 63.2% | 53.3% | 86.2% |
| A1 | Single dev-selected model B, one sample | 1 | 67.9% | 67.6% | 63.2% | 53.3% | 86.2% |
| A2 | Plurality vote over five samples of B | 5 | 82.1% | 81.8% | 78.9% | 70.0% | 96.6% |
| A3 | One-pass Self-MoA: H aggregates five samples of B | 6 | 80.8% | 80.0% | 73.7% | 73.3% | 93.1% |
| A4 | Plurality vote over the five council Stage 1 answers | 5 | 74.4% | 74.5% | 73.7% | 56.7% | 93.1% |
| A5 | Stage 2 leader: top-ranked council answer, no rewrite | 10 | 67.9% | 65.7% | 47.4% | 60.0% | 89.7% |
| A6 | Full council: Stage 1, Stage 2, red team, chairman H | 12 | 82.1% | 83.0% | 89.5% | 70.0% | 89.7% |
| A7 | Council without red team: Stage 1, Stage 2, chairman H | 11 | 88.5% | 89.3% | 94.7% | 80.0% | 93.1% |

Pooled = share of correct final answers over all scored questions. Macro = unweighted mean of the three block accuracies. Calls per question = nominal standalone cost of that arm with no retries.

#### Primary family: A6 (full council) vs alternatives, paired on the same questions (m = 4)

| Comparison | Δ pp (A6 − alt) | Wins / losses / ties | Exact McNemar p | Holm p | 95% paired bootstrap CI (pp) | Bonferroni CI (pp) | Reading at δmin = 5 pp |
| --- | --- | --- | --- | --- | --- | --- | --- |
| A6 − A1 | +14.1 | 19 / 8 / 51 | 0.052 | 0.209 | [+1.3, +26.9] | [−1.3, +29.5] | Insufficient evidence either way |
| A6 − A2 | 0.0 | 9 / 9 / 60 | 1.000 | 1.000 | [−10.3, +10.3] | [−14.1, +14.1] | Insufficient evidence either way |
| A6 − A3 | +1.3 | 11 / 10 / 57 | 1.000 | 1.000 | [−10.3, +12.8] | [−12.8, +16.7] | Insufficient evidence either way |
| A6 − A4 | +7.7 | 14 / 8 / 56 | 0.286 | 0.859 | [−3.8, +19.2] | [−6.4, +21.8] | Insufficient evidence either way |

"Better than every alternative by more than 5 pp" is not supported.
Wins = questions where A6 is correct and the alternative is wrong. McNemar tests the null of zero difference; the interval answers whether a 5 pp gain is supported or excluded. "Insufficient evidence" is not evidence of equivalence.

#### Stage diagnostics (exploratory, no family correction)

| Comparison | Meaning | Δ pp | Wins / losses / ties | Exact McNemar p | 95% CI (pp) |
| --- | --- | --- | --- | --- | --- |
| A5 − A4 | Stage 2 ranking vs plurality over the same five answers | −6.4 | 2 / 7 / 69 | 0.180 | [−12.8, 0.0] |
| A7 − A5 | Chairman rewrite without red team vs the leader it starts from | +20.5 | 20 / 4 / 54 | 0.002 | [+9.0, +30.8] |
| A6 − A7 | Red team effect through the whole pipeline | −6.4 | 3 / 8 / 67 | 0.227 | [−14.1, +1.3] |
| A6 − A5 | Chairman plus red team vs the leader | +14.1 | 19 / 8 / 51 | 0.052 | [+1.3, +25.6] |

#### Failure modes per arm (counts over scored questions)

| Arm | Correct | Wrong answer | Parse error | Refusal | No answer | Not run | Transport failure | Chairman fallback |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| A0 | 53 | 2 | 2 | 0 | 0 | 0 | 21 |  |
| A1 | 53 | 2 | 2 | 0 | 0 | 0 | 21 |  |
| A2 | 64 | 1 | 0 | 0 | 13 | 0 | 0 |  |
| A3 | 63 | 1 | 0 | 0 | 12 | 0 | 2 |  |
| A4 | 58 | 9 | 0 | 0 | 11 | 0 | 0 |  |
| A5 | 53 | 7 | 17 | 0 | 0 | 1 | 0 |  |
| A6 | 64 | 6 | 3 | 0 | 0 | 1 | 4 | 0 |
| A7 | 69 | 2 | 0 | 0 | 0 | 1 | 6 | 0 |

Every failure scores 0 and stays in the denominator. Transport failure = timeout, truncated stream, provider error, or a skipped call. Ranking fallback (no parseable Stage 2 ranking, Stage 1 order used): 26 of 78.

#### Council confidence label (computed about the Stage 2 leader before synthesis)

| Label | n | Coverage | Leader (A5) accuracy | 95% Wilson | A6 accuracy under this label | Validated (n ≥ 5) |
| --- | --- | --- | --- | --- | --- | --- |
| HIGH | 12 | 15.4% | 83.3% | [55.2%, 95.3%] | 91.7% | yes |
| MEDIUM | 40 | 51.3% | 75.0% | [59.8%, 85.8%] | 92.5% | yes |
| LOW | 10 | 12.8% | 60.0% | [31.3%, 83.2%] | 70.0% | yes |
| CONTESTED | 15 | 19.2% | 46.7% | [24.8%, 69.9%] | 60.0% | yes |

Questions without a label: 1. This checks whether the labels carry information; it is not probability calibration.
Red team: REFUTED n=15, P(leader wrong | REFUTED) = 53.3%; UPHELD n=41, P(leader wrong | UPHELD) = 17.1%, P(UPHELD | leader wrong) = 28.0% over 25 wrong leaders; CONTESTED n=8; missing or unparsed 14. A correct final answer does not verify the red-team argument.

Selection: P(A5 correct | some council answer correct) = 84.1% over 63; P(A4 correct | same) = 92.1%. A6 produced a correct answer that no council member had 10 times, A7 10 times.

This table is a measurement, not a product decision. It does not change Stage 2 or the UI. Numbers refresh with `npm --prefix frontend run eval -- report`.
<!-- eval-results:end -->

## Tech stack

- **Backend:** FastAPI, async httpx, OpenRouter API (port 8001)
- **Frontend:** React + Vite, react-markdown + GFM tables
- **Storage:** IndexedDB in the browser, or JSON files in `data/conversations/` when the local Python backend is selected
- **Package management:** uv or pip + `.venv` for Python, npm for JavaScript

## Credits

Based on [LLM Council](https://github.com/karpathy/llm-council) by Andrej Karpathy.
