import { useState, useEffect, useMemo } from 'react';
import { api } from '../api';
import './Settings.css';

export default function Settings({ isOpen, onClose, onSettingsChange }) {
  const [settings, setSettings] = useState(null);
  const [availableModels, setAvailableModels] = useState([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  // Local state for editing
  const [nSamples, setNSamples] = useState(1);
  const [councilModels, setCouncilModels] = useState([]);
  const [chairmanModel, setChairmanModel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [hasApiKey, setHasApiKey] = useState(false);
  const [maskedApiKey, setMaskedApiKey] = useState('');

  // Load settings and available models
  useEffect(() => {
    if (isOpen) {
      loadData();
    }
  }, [isOpen]);

  // Close on Escape key
  useEffect(() => {
    if (!isOpen) return;
    const handleEsc = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', handleEsc);
    return () => window.removeEventListener('keydown', handleEsc);
  }, [isOpen, onClose]);

  const loadData = async () => {
    setLoading(true);
    setError(null);
    try {
      const [settingsData, modelsData] = await Promise.all([
        api.getSettings(),
        api.getAvailableModels(),
      ]);
      
      setSettings(settingsData);
      setNSamples(settingsData.n_samples);
      setCouncilModels(settingsData.council_models);
      setChairmanModel(settingsData.chairman_model);
      setHasApiKey(settingsData.has_api_key || false);
      setMaskedApiKey(settingsData.masked_api_key || '');
      setApiKey(''); // Clear any previous input
      setAvailableModels(modelsData.models || []);
    } catch (err) {
      setError('Failed to load settings');
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  // Filter models based on search query
  const filteredModels = useMemo(() => {
    if (!searchQuery.trim()) return availableModels;
    const query = searchQuery.toLowerCase();
    return availableModels.filter(
      (model) =>
        model.id.toLowerCase().includes(query) ||
        model.name.toLowerCase().includes(query)
    );
  }, [availableModels, searchQuery]);

  // Extract model size from name (e.g., "70B", "405B", "8x7B")
  const extractSize = (name) => {
    const match = name.match(/(\d+)x?(\d*)b/i);
    if (!match) return 0;
    const base = parseInt(match[1]);
    const mult = match[2] ? parseInt(match[2]) : 1;
    return match[0].includes('x') ? base * mult : base;
  };

  // Get model family from id (e.g., "meta-llama/llama-3.3-70b" -> "llama")
  const getFamily = (id) => {
    const name = id.split('/').pop().toLowerCase();
    // Common family patterns
    const families = ['llama', 'gemma', 'qwen', 'mistral', 'phi', 'deepseek', 'gemini', 'gpt', 'claude', 'olmo', 'hermes', 'dolphin', 'glm', 'yi'];
    for (const f of families) {
      if (name.includes(f)) return f;
    }
    return name.split('-')[0];
  };

  // Top 8 paid models (from config.py defaults)
  const TOP_8_PAID = [
    'openai/gpt-5.5',
    'google/gemini-3.1-pro-preview',
    'anthropic/claude-opus-4.8',
    'x-ai/grok-4.5',
    'openai/gpt-5.5-reasoning',
    'google/gemini-3.1-pro-preview-reasoning',
    'anthropic/claude-opus-4.8-reasoning',
    'x-ai/grok-4.5-reasoning',
  ];

  // Select top 10 free general-purpose models - largest of each family
  const selectTopFreeModels = () => {
    // Whitelist: known general-purpose model families (not code-specialized)
    const validFamilies = ['llama', 'gemma', 'qwen', 'mistral', 'phi', 'deepseek', 'glm', 'yi', 'olmo', 'hermes', 'dolphin', 'gemini', 'gpt', 'claude'];
    // Blacklist: code-specialized variants within those families
    const codeVariants = ['coder', 'codestral', 'starcoder', 'codellama', 'devstral'];
    
    const freeModels = availableModels.filter(m => {
      if (!m.id.endsWith(':free')) return false;
      const lower = m.id.toLowerCase();
      if (codeVariants.some(c => lower.includes(c))) return false;
      return validFamilies.some(f => lower.includes(f));
    });
    
    const familyBest = {};
    for (const model of freeModels) {
      const family = getFamily(model.id);
      const size = extractSize(model.name);
      if (!familyBest[family] || size > familyBest[family].size) {
        familyBest[family] = { id: model.id, size };
      }
    }
    const top = Object.values(familyBest)
      .sort((a, b) => b.size - a.size)
      .slice(0, 10)
      .map(m => m.id);
    setCouncilModels(top);
    // Set chairman to Qwen 235B free with reasoning+
    setChairmanModel('qwen/qwen3-235b-a22b:free-reasoning-high');
  };

  // Select top 8 paid models
  const selectTopPaidModels = () => {
    setCouncilModels(TOP_8_PAID);
    setNSamples(3);
    setChairmanModel('anthropic/claude-fable-5-reasoning-high');
  };

  // Group models by provider
  const groupedModels = useMemo(() => {
    const groups = {};
    filteredModels.forEach((model) => {
      const provider = model.id.split('/')[0] || 'other';
      if (!groups[provider]) {
        groups[provider] = [];
      }
      groups[provider].push(model);
    });
    return groups;
  }, [filteredModels]);

  // Sort selected models alphabetically by display name
  const sortedCouncilModels = useMemo(() => {
    return [...councilModels].sort((a, b) => {
      // Parse base IDs
      let baseA = a.replace('-reasoning-high', '').replace('-reasoning', '');
      let baseB = b.replace('-reasoning-high', '').replace('-reasoning', '');
      
      // Get display names
      const modelA = availableModels.find(m => m.id === baseA);
      const modelB = availableModels.find(m => m.id === baseB);
      const nameA = modelA?.name || baseA.split('/').pop();
      const nameB = modelB?.name || baseB.split('/').pop();
      
      return nameA.localeCompare(nameB);
    });
  }, [councilModels, availableModels]);

  // Check if a specific variant is selected
  const isVariantSelected = (modelId, variant) => {
    const fullModelId = variant === 'base' ? modelId : `${modelId}-${variant}`;
    return councilModels.includes(fullModelId);
  };

  // Check if any variant of a model is selected
  const isAnyVariantSelected = (modelId) => {
    return (
      councilModels.includes(modelId) ||
      councilModels.includes(`${modelId}-reasoning`) ||
      councilModels.includes(`${modelId}-reasoning-high`)
    );
  };

  // Toggle a specific variant independently
  const toggleModel = (modelId, variant = 'base') => {
    const fullModelId = variant === 'base' ? modelId : `${modelId}-${variant}`;
    
    if (councilModels.includes(fullModelId)) {
      // Remove this variant
      setCouncilModels(councilModels.filter((m) => m !== fullModelId));
    } else {
      // Add this variant
      setCouncilModels([...councilModels, fullModelId]);
    }
  };

  // Set chairman model variant
  const setChairmanVariant = (modelId, variant) => {
    const baseId = modelId.replace('-reasoning-high', '').replace('-reasoning', '');
    const fullModelId = variant === 'base' ? baseId : `${baseId}-${variant}`;
    setChairmanModel(fullModelId);
  };

  // Get chairman variant
  const getChairmanVariant = () => {
    if (chairmanModel.includes('-reasoning-high')) return 'reasoning-high';
    if (chairmanModel.includes('-reasoning')) return 'reasoning';
    return 'base';
  };

  const getChairmanBaseId = () => {
    return chairmanModel.replace('-reasoning-high', '').replace('-reasoning', '');
  };

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      const updateData = {
        n_samples: nSamples,
        council_models: councilModels,
        chairman_model: chairmanModel,
      };
      // Only include API key if user entered a new one
      if (apiKey.trim()) {
        updateData.api_key = apiKey.trim();
      }
      const updatedSettings = await api.updateSettings(updateData);
      setSettings(updatedSettings);
      setHasApiKey(updatedSettings.has_api_key || false);
      setMaskedApiKey(updatedSettings.masked_api_key || '');
      setApiKey(''); // Clear the input after save
      onSettingsChange?.(updatedSettings);
      onClose();
    } catch (err) {
      setError('Failed to save settings');
      console.error(err);
    } finally {
      setSaving(false);
    }
  };

  const handleReset = async () => {
    setSaving(true);
    setError(null);
    try {
      const resetSettings = await api.resetSettings();
      setSettings(resetSettings);
      setNSamples(resetSettings.n_samples);
      setCouncilModels(resetSettings.council_models);
      setChairmanModel(resetSettings.chairman_model);
      setHasApiKey(resetSettings.has_api_key || false);
      setMaskedApiKey(resetSettings.masked_api_key || '');
      setApiKey('');
      onSettingsChange?.(resetSettings);
    } catch (err) {
      setError('Failed to reset settings');
      console.error(err);
    } finally {
      setSaving(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings-modal" onClick={(e) => e.stopPropagation()}>
        <div className="settings-header">
          <h2>Council Settings</h2>
          <button className="close-button" onClick={onClose}>×</button>
        </div>

        {loading ? (
          <div className="settings-loading">
            <div className="spinner"></div>
            <span>Loading settings...</span>
          </div>
        ) : (
          <>
            {error && <div className="settings-error">{error}</div>}

            <div className="settings-content">
              {/* API Key Setting */}
              <div className="settings-section">
                <h3>OpenRouter API Key</h3>
                <p className="settings-description">
                  Your OpenRouter API key is required to query the AI models.
                  Get your key at <a href="https://openrouter.ai/keys" target="_blank" rel="noopener noreferrer">openrouter.ai/keys</a>
                </p>
                <div className="api-key-control">
                  <div className="api-key-status">
                    {hasApiKey ? (
                      <span className="api-key-configured">
                        <span className="status-dot configured"></span>
                        Configured: <code>{maskedApiKey}</code>
                      </span>
                    ) : (
                      <span className="api-key-missing">
                        <span className="status-dot missing"></span>
                        Not configured
                      </span>
                    )}
                  </div>
                  <input
                    type="password"
                    placeholder={hasApiKey ? "Enter new key to update..." : "Enter your API key..."}
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    className="api-key-input"
                    autoComplete="off"
                  />
                </div>
              </div>

              {/* N_SAMPLES Setting */}
              <div className="settings-section">
                <h3>Samples per Model</h3>
                <p className="settings-description">
                  Number of response samples to collect from each model in Stage 1.
                  More samples = more diverse responses but higher cost.
                </p>
                <div className="n-samples-control">
                  <button
                    className="n-samples-btn"
                    onClick={() => setNSamples(Math.max(1, nSamples - 1))}
                    disabled={nSamples <= 1}
                  >
                    −
                  </button>
                  <input
                    type="number"
                    min="1"
                    max="10"
                    value={nSamples}
                    onChange={(e) => setNSamples(Math.max(1, Math.min(10, parseInt(e.target.value) || 1)))}
                    className="n-samples-input"
                  />
                  <button
                    className="n-samples-btn"
                    onClick={() => setNSamples(Math.min(10, nSamples + 1))}
                    disabled={nSamples >= 10}
                  >
                    +
                  </button>
                </div>
                <div className="n-samples-info">
                  Total Stage 1 calls: {nSamples * councilModels.length}
                </div>
              </div>

              {/* Council Models */}
              <div className="settings-section">
                <h3>Council Models ({councilModels.length} selected)</h3>
                <p className="settings-description">
                  Select the models that will participate in the council.
                  You can select multiple variants (Base, R, R+) of the same model.
                </p>
                
                {/* Quick Actions */}
                <div className="quick-actions">
                  <button 
                    className="quick-action-btn"
                    onClick={selectTopFreeModels}
                    title="Select 10 largest free models, one per family"
                  >
                    🆓 Top 10 Free
                  </button>
                  <button 
                    className="quick-action-btn"
                    onClick={selectTopPaidModels}
                    title="Select top 8 paid models"
                  >
                    💎 Top 8 Paid
                  </button>
                </div>

                {/* Selected Models - Pinned at Top */}
                {councilModels.length > 0 && (
                  <div className="selected-models-section">
                    <div className="selected-models-header">
                      <span className="selected-models-title">Selected Models</span>
                      <button 
                        className="clear-all-btn"
                        onClick={() => setCouncilModels([])}
                        title="Clear all selections"
                      >
                        Clear All
                      </button>
                    </div>
                    <div className="selected-models-list">
                      {sortedCouncilModels.map((modelId) => {
                        // Parse variant from model ID
                        let baseId = modelId;
                        let variant = 'base';
                        if (modelId.endsWith('-reasoning-high')) {
                          baseId = modelId.replace('-reasoning-high', '');
                          variant = 'reasoning-high';
                        } else if (modelId.endsWith('-reasoning')) {
                          baseId = modelId.replace('-reasoning', '');
                          variant = 'reasoning';
                        }
                        
                        const modelInfo = availableModels.find(m => m.id === baseId);
                        const displayName = modelInfo?.name || baseId.split('/').pop();
                        
                        return (
                          <div key={modelId} className="selected-model-chip">
                            <div className="chip-info">
                              <span className="chip-name">{displayName}</span>
                            </div>
                            <div className="chip-actions">
                              <div className="chip-mode-selector">
                                <button
                                  className={`chip-mode-btn ${variant === 'base' ? 'active' : ''}`}
                                  onClick={() => {
                                    setCouncilModels(prev => 
                                      prev.map(m => m === modelId ? baseId : m)
                                    );
                                  }}
                                  title="Base mode"
                                >
                                  B
                                </button>
                                <button
                                  className={`chip-mode-btn ${variant === 'reasoning' ? 'active' : ''}`}
                                  onClick={() => {
                                    setCouncilModels(prev => 
                                      prev.map(m => m === modelId ? `${baseId}-reasoning` : m)
                                    );
                                  }}
                                  title="Reasoning mode"
                                >
                                  R
                                </button>
                                <button
                                  className={`chip-mode-btn ${variant === 'reasoning-high' ? 'active' : ''}`}
                                  onClick={() => {
                                    setCouncilModels(prev => 
                                      prev.map(m => m === modelId ? `${baseId}-reasoning-high` : m)
                                    );
                                  }}
                                  title="Reasoning+ mode"
                                >
                                  R+
                                </button>
                              </div>
                              <button
                                className="chip-remove"
                                onClick={() => setCouncilModels(prev => prev.filter(m => m !== modelId))}
                                title="Remove from council"
                              >
                                ×
                              </button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                <input
                  type="text"
                  placeholder="Search models..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="model-search"
                />

                <div className="models-list">
                  {Object.entries(groupedModels).map(([provider, models]) => (
                    <div key={provider} className="provider-group">
                      <div className="provider-header">{provider}</div>
                      {models.map((model) => {
                        const hasAnySelected = isAnyVariantSelected(model.id);
                        return (
                          <div
                            key={model.id}
                            className={`model-item ${hasAnySelected ? 'selected' : ''}`}
                          >
                            <div className="model-info">
                              <span className="model-name">{model.name}</span>
                              <span className="model-id">{model.id}</span>
                            </div>
                            <div className="model-variants">
                              <button
                                className={`variant-btn ${isVariantSelected(model.id, 'base') ? 'active' : ''}`}
                                onClick={() => toggleModel(model.id, 'base')}
                                title="Base model"
                              >
                                Base
                              </button>
                              <button
                                className={`variant-btn ${isVariantSelected(model.id, 'reasoning') ? 'active' : ''}`}
                                onClick={() => toggleModel(model.id, 'reasoning')}
                                title="Reasoning mode"
                              >
                                R
                              </button>
                              <button
                                className={`variant-btn ${isVariantSelected(model.id, 'reasoning-high') ? 'active' : ''}`}
                                onClick={() => toggleModel(model.id, 'reasoning-high')}
                                title="High-effort reasoning"
                              >
                                R+
                              </button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  ))}
                </div>
              </div>

              {/* Chairman Model */}
              <div className="settings-section">
                <h3>Chairman Model</h3>
                <p className="settings-description">
                  The model that synthesizes the final response from all council outputs.
                </p>
                
                <div className="chairman-selector">
                  <select
                    value={getChairmanBaseId()}
                    onChange={(e) => setChairmanVariant(e.target.value, getChairmanVariant())}
                    className="chairman-select"
                  >
                    {availableModels.map((model) => (
                      <option key={model.id} value={model.id}>
                        {model.name}
                      </option>
                    ))}
                  </select>
                  <div className="chairman-variants">
                    <button
                      className={`variant-btn ${getChairmanVariant() === 'base' ? 'active' : ''}`}
                      onClick={() => setChairmanVariant(getChairmanBaseId(), 'base')}
                    >
                      Base
                    </button>
                    <button
                      className={`variant-btn ${getChairmanVariant() === 'reasoning' ? 'active' : ''}`}
                      onClick={() => setChairmanVariant(getChairmanBaseId(), 'reasoning')}
                    >
                      R
                    </button>
                    <button
                      className={`variant-btn ${getChairmanVariant() === 'reasoning-high' ? 'active' : ''}`}
                      onClick={() => setChairmanVariant(getChairmanBaseId(), 'reasoning-high')}
                    >
                      R+
                    </button>
                  </div>
                </div>
                <div className="chairman-current">
                  Current: <code>{chairmanModel}</code>
                </div>
              </div>
            </div>

            <div className="settings-footer">
              <button className="reset-button" onClick={handleReset} disabled={saving}>
                Reset to Defaults
              </button>
              <div className="footer-actions">
                <button className="cancel-button" onClick={onClose} disabled={saving}>
                  Cancel
                </button>
                <button className="save-button" onClick={handleSave} disabled={saving}>
                  {saving ? 'Saving...' : 'Save Settings'}
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

