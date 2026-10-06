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

## Tech stack

- **Backend:** FastAPI, async httpx, OpenRouter API (port 8001)
- **Frontend:** React + Vite, react-markdown + GFM tables
- **Storage:** IndexedDB in the browser, or JSON files in `data/conversations/` when the local Python backend is selected
- **Package management:** uv or pip + `.venv` for Python, npm for JavaScript

## Credits

Based on [LLM Council](https://github.com/karpathy/llm-council) by Andrej Karpathy.
