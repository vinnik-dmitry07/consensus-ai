"""Configuration for the LLM Council."""

import os

from dotenv import load_dotenv

load_dotenv()

# OpenRouter API key. Free and paid model ids both use this personal key.
OPENROUTER_API_KEY = os.getenv("OPENROUTER_API_KEY")

# Council members - list of OpenRouter model identifiers
# ~*-latest aliases always resolve to the newest model in each family
COUNCIL_MODELS = [
    '~openai/gpt-sol-latest',
    '~google/gemini-pro-latest',
    '~anthropic/claude-opus-latest',
    '~x-ai/grok-latest',
    '~openai/gpt-sol-latest-reasoning',
    '~google/gemini-pro-latest-reasoning',
    '~anthropic/claude-opus-latest-reasoning',
    '~x-ai/grok-latest-reasoning',
]

# Number of response samples to collect per model in Stage 1
N_SAMPLES = 3

# Chairman model - synthesizes final response
CHAIRMAN_MODEL = '~anthropic/claude-fable-latest-reasoning-high'

# Cheap model for conversation titles
TITLE_MODEL = 'google/gemini-2.5-flash'

# How many top-ranked Stage 1 answers the chairman sees
TOP_K = 3

# Red-team model (None = use chairman). Tries to refute the leading answer.
RED_TEAM_MODEL = None

# Exclude a judge's own model family from the candidates it ranks
SELF_EXCLUSION = True

# Answer mode: 'council' (3 stages) or 'self_moa' (S8). Self-MoA asks the
# chairman model for SELF_MOA_SAMPLES independent answers and has the same
# model combine them, with no peer ranking and no red team.
MODE_COUNCIL = 'council'
MODE_SELF_MOA = 'self_moa'
MODE = MODE_COUNCIL
SELF_MOA_SAMPLES = 5

# Self-MoA calls follow the a8-open v5+ runs (frontend/eval/a8Profile.js):
# one 32768-token cap, temperature 0.7 and top_p 1, a stream deadline that
# lets a full cap finish at 8 tokens a second, the loop guard with two attempts,
# and the tail rule for a sample cut before it wrote an answer. Must match
# frontend/src/engine/browser/selfMoa.js.
SELF_MOA_MAX_TOKENS = 32768
SELF_MOA_TEMPERATURE = 0.7
SELF_MOA_TOP_P = 1
SELF_MOA_STREAM_SECONDS = -(-SELF_MOA_MAX_TOKENS // 8) + 120
SELF_MOA_IDLE_SECONDS = 120.0
# Two attempts per call, as the runs allowed per slot.
SELF_MOA_MAX_ATTEMPTS = 2
SELF_MOA_TAIL_CHARS = 8000
SELF_MOA_TAIL_MARKER = (
    '[This answer was cut off before a final answer. '
    'Last 8000 characters of its unfinished reasoning:]'
)

# OpenRouter API endpoint
OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions'
OPENROUTER_CREDITS_URL = 'https://openrouter.ai/api/v1/credits'
OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models'
OPENROUTER_KEY_URL = 'https://openrouter.ai/api/v1/key'

# Cap reserved completion tokens so OpenRouter 402s less often.
DEFAULT_MAX_TOKENS = 16000
DEFAULT_MAX_TOKENS_HIGH = 32000  # xhigh can use ~95% of the cap


def _positive_int_env(name: str, default: int) -> int:
    raw = (os.getenv(name) or '').strip()
    if not raw:
        return default
    try:
        return max(1, int(raw))
    except ValueError:
        return default


OPENROUTER_MAX_TOKENS = _positive_int_env('OPENROUTER_MAX_TOKENS', DEFAULT_MAX_TOKENS)
OPENROUTER_MAX_TOKENS_HIGH = _positive_int_env(
    'OPENROUTER_MAX_TOKENS_HIGH', DEFAULT_MAX_TOKENS_HIGH
)

# Data directory for conversation storage
DATA_DIR = "data/conversations"
