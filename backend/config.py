"""Configuration for the LLM Council."""

import os

from dotenv import load_dotenv

load_dotenv()

# OpenRouter API key
OPENROUTER_API_KEY = os.getenv("OPENROUTER_API_KEY")

# Council members - list of OpenRouter model identifiers
# ~*-latest aliases always resolve to the newest model in each family
COUNCIL_MODELS = [
    '~openai/gpt-latest',
    '~google/gemini-pro-latest',
    '~anthropic/claude-opus-latest',
    '~x-ai/grok-latest',
    '~openai/gpt-latest-reasoning',
    '~google/gemini-pro-latest-reasoning',
    '~anthropic/claude-opus-latest-reasoning',
    '~x-ai/grok-latest-reasoning',
]

# Number of response samples to collect per model in Stage 1
N_SAMPLES = 3

# Chairman model - synthesizes final response
CHAIRMAN_MODEL = '~anthropic/claude-fable-latest-reasoning-high'

# How many top-ranked Stage 1 answers the chairman sees
TOP_K = 3

# Red-team model (None = use chairman). Tries to refute the leading answer.
RED_TEAM_MODEL = None

# Exclude a judge's own model family from the candidates it ranks
SELF_EXCLUSION = True

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
