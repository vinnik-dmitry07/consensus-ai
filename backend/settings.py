"""Runtime settings for the LLM Council that can be modified via API."""

from typing import List, Optional
from .config import COUNCIL_MODELS as DEFAULT_COUNCIL_MODELS, N_SAMPLES as DEFAULT_N_SAMPLES, CHAIRMAN_MODEL as DEFAULT_CHAIRMAN_MODEL, OPENROUTER_API_KEY as ENV_API_KEY


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
        # Note: API key is not reset - user must explicitly clear it
    
    def to_dict(self) -> dict:
        """Return settings as a dictionary (with masked API key for security)."""
        return {
            "council_models": self._council_models,
            "n_samples": self._n_samples,
            "chairman_model": self._chairman_model,
            "has_api_key": self.has_api_key,
            "masked_api_key": self.masked_api_key,
        }
    
    def update_from_dict(self, data: dict):
        """Update settings from a dictionary."""
        if "council_models" in data:
            self.council_models = data["council_models"]
        if "n_samples" in data:
            self.n_samples = data["n_samples"]
        if "chairman_model" in data:
            self.chairman_model = data["chairman_model"]
        if "api_key" in data:
            self.api_key = data["api_key"]


# Global singleton instance
settings = CouncilSettings()

