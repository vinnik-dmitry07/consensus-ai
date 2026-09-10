"""Runtime settings for the LLM Council that can be modified via API."""

from typing import List, Optional

from .config import (
    CHAIRMAN_MODEL as DEFAULT_CHAIRMAN_MODEL,
    COUNCIL_MODELS as DEFAULT_COUNCIL_MODELS,
    N_SAMPLES as DEFAULT_N_SAMPLES,
    OPENROUTER_API_KEY as ENV_API_KEY,
    RED_TEAM_MODEL as DEFAULT_RED_TEAM_MODEL,
    SELF_EXCLUSION as DEFAULT_SELF_EXCLUSION,
    TOP_K as DEFAULT_TOP_K,
)


class CouncilSettings:
    """Singleton class to manage runtime council settings."""
    
    _instance = None
    
    def __new__(cls):
        if cls._instance is None:
            cls._instance = super().__new__(cls)
            cls._instance._initialized = False
        return cls._instance
    
    def __init__(self):
        if self._initialized:
            return
        self._initialized = True
        self._council_models: List[str] = list(DEFAULT_COUNCIL_MODELS)
        self._n_samples: int = DEFAULT_N_SAMPLES
        self._chairman_model: str = DEFAULT_CHAIRMAN_MODEL
        self._top_k: int = DEFAULT_TOP_K
        self._red_team_model: Optional[str] = DEFAULT_RED_TEAM_MODEL
        self._self_exclusion: bool = DEFAULT_SELF_EXCLUSION
        self._api_key: Optional[str] = ENV_API_KEY  # Initialize from env, can be overridden
    
    @property
    def council_models(self) -> List[str]:
        return self._council_models
    
    @council_models.setter
    def council_models(self, value: List[str]):
        self._council_models = list(value)
    
    @property
    def n_samples(self) -> int:
        return self._n_samples
    
    @n_samples.setter
    def n_samples(self, value: int):
        self._n_samples = max(1, min(10, value))  # Clamp between 1 and 10
    
    @property
    def chairman_model(self) -> str:
        return self._chairman_model
    
    @chairman_model.setter
    def chairman_model(self, value: str):
        self._chairman_model = value

    @property
    def top_k(self) -> int:
        return self._top_k

    @top_k.setter
    def top_k(self, value: int):
        self._top_k = max(1, min(10, int(value)))

    @property
    def red_team_model(self) -> Optional[str]:
        return self._red_team_model

    @red_team_model.setter
    def red_team_model(self, value: Optional[str]):
        if value and str(value).strip():
            self._red_team_model = str(value).strip()
        else:
            self._red_team_model = None

    @property
    def self_exclusion(self) -> bool:
        return self._self_exclusion

    @self_exclusion.setter
    def self_exclusion(self, value: bool):
        self._self_exclusion = bool(value)
    
    @property
    def api_key(self) -> Optional[str]:
        return self._api_key
    
    @api_key.setter
    def api_key(self, value: Optional[str]):
        if value and value.strip():
            self._api_key = value.strip()
        # Don't clear if empty - keep existing key
    
    @property
    def has_api_key(self) -> bool:
        """Check if an API key is configured."""
        return bool(self._api_key)
    
    @property
    def masked_api_key(self) -> Optional[str]:
        """Return a masked version of the API key for display."""
        if not self._api_key:
            return None
        if len(self._api_key) <= 8:
            return "****"
        return self._api_key[:4] + "..." + self._api_key[-4:]
    
    def reset_to_defaults(self):
        """Reset all settings to their default values (except API key)."""
        self._council_models = list(DEFAULT_COUNCIL_MODELS)
        self._n_samples = DEFAULT_N_SAMPLES
        self._chairman_model = DEFAULT_CHAIRMAN_MODEL
        self._top_k = DEFAULT_TOP_K
        self._red_team_model = DEFAULT_RED_TEAM_MODEL
        self._self_exclusion = DEFAULT_SELF_EXCLUSION
        # Note: API key is not reset - user must explicitly clear it
    
    def to_dict(self) -> dict:
        """Return settings as a dictionary (with masked API key for security)."""
        return {
            'council_models': self._council_models,
            'n_samples': self._n_samples,
            'chairman_model': self._chairman_model,
            'top_k': self._top_k,
            'red_team_model': self._red_team_model,
            'self_exclusion': self._self_exclusion,
            'has_api_key': self.has_api_key,
            'masked_api_key': self.masked_api_key,
        }
    
    def update_from_dict(self, data: dict):
        """Update settings from a dictionary."""
        if 'council_models' in data:
            self.council_models = data['council_models']
        if 'n_samples' in data:
            self.n_samples = data['n_samples']
        if 'chairman_model' in data:
            self.chairman_model = data['chairman_model']
        if 'top_k' in data:
            self.top_k = data['top_k']
        if 'red_team_model' in data:
            self.red_team_model = data['red_team_model']
        if 'self_exclusion' in data:
            self.self_exclusion = data['self_exclusion']
        if 'api_key' in data:
            self.api_key = data['api_key']


# Global singleton instance
settings = CouncilSettings()

