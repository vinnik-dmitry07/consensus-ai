import { useState, useEffect, useRef, useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import { api } from '../api';
import Stage1 from './Stage1';
import Stage2 from './Stage2';
import Stage3 from './Stage3';
import './ChatInterface.css';

// Estimate tokens from text (rough: ~4 chars per token)
function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

// Calculate estimated cost for the full council process
function calculateEstimatedCost(inputText, numImages, pricingData) {
  if (!pricingData || !pricingData.pricing) return null;

  const { council_models, chairman_model, pricing, n_samples = 1 } = pricingData;
  
  const inputTokens = estimateTokens(inputText);
  const numModels = council_models.length;
  const totalStage1Responses = n_samples * numModels;
  
  // Estimation constants - calibrated from actual usage data
  const avgResponseTokens = 2500;       // Average Stage 1 response length (actual ~2550)
  const avgReasoningTokens = 1500;      // Reasoning tokens for reasoning models
  const stage2SystemTokens = 500;       // Ranking prompt template overhead
  const avgRankingTokens = 3000;        // Stage 2 output per model (actual ~2930)
  const stage3SystemTokens = 500;       // Chairman prompt template overhead
  const stage3OutputTokens = 2500;      // Chairman response length (actual ~2270)
  
  // Stage 1 prompt: just user input
  const stage1PromptTokens = inputTokens;
  
  // Stage 2 prompt: template + question + ALL Stage 1 responses (N_SAMPLES × MODELS)
  const stage2PromptTokens = stage2SystemTokens + inputTokens + (totalStage1Responses * avgResponseTokens);
  
  // Stage 3 prompt: template + question + all Stage 1 responses + all Stage 2 rankings
  const stage3PromptTokens = stage3SystemTokens + inputTokens + 
    (totalStage1Responses * avgResponseTokens) + (numModels * avgRankingTokens);
  
  let totalCost = 0;
  const breakdown = {
    stage1: { models: [], total: 0, callCount: 0 },
    stage2: { models: [], total: 0, callCount: 0 },
    stage3: { model: null, total: 0 },
  };

  // Stage 1: N_SAMPLES calls per model
  for (const model of council_models) {
    const baseModel = model.replace('-reasoning-high', '').replace('-reasoning', '');
    const isReasoning = model.includes('reasoning');
    const modelPricing = pricing[baseModel]?.pricing || {};
    
    const promptPrice = parseFloat(modelPricing.prompt || '0');
    const completionPrice = parseFloat(modelPricing.completion || '0');
    const imagePrice = parseFloat(modelPricing.image || '0');
    const reasoningPrice = parseFloat(modelPricing.internal_reasoning || '0');
    
    // Cost per call
    let costPerCall = stage1PromptTokens * promptPrice;
    costPerCall += avgResponseTokens * completionPrice;
    costPerCall += numImages * imagePrice;
    if (isReasoning) {
      costPerCall += avgReasoningTokens * reasoningPrice;
    }
    
    // Multiply by N_SAMPLES
    const totalModelCost = costPerCall * n_samples;
    
    breakdown.stage1.models.push({ model: baseModel, cost: totalModelCost, isReasoning, calls: n_samples });
    breakdown.stage1.total += totalModelCost;
    breakdown.stage1.callCount += n_samples;
    totalCost += totalModelCost;
  }

  // Stage 2: One call per model, but evaluating ALL N_SAMPLES×MODELS responses
  for (const model of council_models) {
    const baseModel = model.replace('-reasoning-high', '').replace('-reasoning', '');
    const isReasoning = model.includes('reasoning');
    const modelPricing = pricing[baseModel]?.pricing || {};
    
    const promptPrice = parseFloat(modelPricing.prompt || '0');
    const completionPrice = parseFloat(modelPricing.completion || '0');
    const reasoningPrice = parseFloat(modelPricing.internal_reasoning || '0');
    
    let cost = stage2PromptTokens * promptPrice;
    cost += avgRankingTokens * completionPrice;
    if (isReasoning) {
      cost += avgReasoningTokens * reasoningPrice;
    }
    
    breakdown.stage2.models.push({ model: baseModel, cost, isReasoning });
    breakdown.stage2.total += cost;
    breakdown.stage2.callCount += 1;
    totalCost += cost;
  }

  // Stage 3: Chairman model synthesizes final answer
  const chairmanBase = chairman_model.replace('-reasoning-high', '').replace('-reasoning', '');
  const isChairmanReasoning = chairman_model.includes('reasoning');
  const isHighEffort = chairman_model.includes('-reasoning-high');
  const chairmanPricing = pricing[chairmanBase]?.pricing || {};
  
  const promptPrice = parseFloat(chairmanPricing.prompt || '0');
  const completionPrice = parseFloat(chairmanPricing.completion || '0');
  const reasoningPrice = parseFloat(chairmanPricing.internal_reasoning || '0');
  
  let stage3Cost = stage3PromptTokens * promptPrice;
  stage3Cost += stage3OutputTokens * completionPrice;
  if (isChairmanReasoning) {
    const reasoningMultiplier = isHighEffort ? 2 : 1;
    stage3Cost += avgReasoningTokens * reasoningMultiplier * reasoningPrice;
  }
  
  breakdown.stage3.model = chairmanBase;
  breakdown.stage3.total = stage3Cost;
  breakdown.stage3.isReasoning = isChairmanReasoning;
  totalCost += stage3Cost;

  // Store estimated tokens for debugging
  const estimatedTokens = {
    stage1: {
      promptPerCall: stage1PromptTokens,
      completionPerCall: avgResponseTokens,
      totalPrompt: stage1PromptTokens * totalStage1Responses,
      totalCompletion: avgResponseTokens * totalStage1Responses,
    },
    stage2: {
      promptPerCall: stage2PromptTokens,
      completionPerCall: avgRankingTokens,
      totalPrompt: stage2PromptTokens * numModels,
      totalCompletion: avgRankingTokens * numModels,
    },
    stage3: {
      prompt: stage3PromptTokens,
      completion: stage3OutputTokens,
    },
  };

  return { totalCost, breakdown, n_samples, estimatedTokens };
}

// Calculate actual usage from message data
function calculateActualUsage(msg) {
  if (!msg.stage1 && !msg.stage2 && !msg.stage3) return null;
  
  const usage = {
    stage1: { promptTokens: 0, completionTokens: 0, totalTokens: 0, calls: 0 },
    stage2: { promptTokens: 0, completionTokens: 0, totalTokens: 0, calls: 0 },
    stage3: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  };
  
  // Stage 1 usage
  if (msg.stage1) {
    for (const resp of msg.stage1) {
      if (resp.usage) {
        usage.stage1.promptTokens += resp.usage.prompt_tokens || 0;
        usage.stage1.completionTokens += resp.usage.completion_tokens || 0;
        usage.stage1.totalTokens += resp.usage.total_tokens || 0;
        usage.stage1.calls++;
      }
    }
  }
  
  // Stage 2 usage
  if (msg.stage2) {
    for (const resp of msg.stage2) {
      if (resp.usage) {
        usage.stage2.promptTokens += resp.usage.prompt_tokens || 0;
        usage.stage2.completionTokens += resp.usage.completion_tokens || 0;
        usage.stage2.totalTokens += resp.usage.total_tokens || 0;
        usage.stage2.calls++;
      }
    }
  }
  
  // Stage 3 usage
  if (msg.stage3?.usage) {
    usage.stage3.promptTokens = msg.stage3.usage.prompt_tokens || 0;
    usage.stage3.completionTokens = msg.stage3.usage.completion_tokens || 0;
    usage.stage3.totalTokens = msg.stage3.usage.total_tokens || 0;
  }
  
  return usage;
}

export default function ChatInterface({
  conversation,
  onSendMessage,
  onRetryStage,
  isLoading,
  settingsVersion = 0,
}) {
  const [input, setInput] = useState('');
  const [attachedImages, setAttachedImages] = useState([]);
  const [pricingData, setPricingData] = useState(null);
  const messagesEndRef = useRef(null);
  const fileInputRef = useRef(null);

  // Fetch pricing data on mount and when settings change
  useEffect(() => {
    const fetchPricing = async () => {
      try {
        const data = await api.getPricing();
        setPricingData(data);
      } catch (error) {
        console.error('Failed to fetch pricing:', error);
      }
    };
    fetchPricing();
  }, [settingsVersion]);

  // Calculate estimated cost when input or images change
  const estimatedCost = useMemo(() => {
    if (!input.trim() && attachedImages.length === 0) return null;
    return calculateEstimatedCost(input, attachedImages.length, pricingData);
  }, [input, attachedImages.length, pricingData]);

  const [showScrollBtn, setShowScrollBtn] = useState(false);
  const [scrollDirection, setScrollDirection] = useState('down');
  const containerRef = useRef(null);
  const lastScrollTop = useRef(0);

  const scrollTo = () => {
    if (scrollDirection === 'down') {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    } else {
      containerRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
    }
  };

  const handleScroll = () => {
    if (!containerRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = containerRef.current;
    const atBottom = scrollHeight - scrollTop - clientHeight < 100;
    const atTop = scrollTop < 100;
    
    if (scrollTop > lastScrollTop.current) {
      setScrollDirection('down');
      setShowScrollBtn(!atBottom);
    } else if (scrollTop < lastScrollTop.current) {
      setScrollDirection('up');
      setShowScrollBtn(!atTop);
    }
    lastScrollTop.current = scrollTop;
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    if ((input.trim() || attachedImages.length > 0) && !isLoading) {
      onSendMessage(input, attachedImages);
      setInput('');
      setAttachedImages([]);
    }
  };

  const handleKeyDown = (e) => {
    // Submit on Enter (without Shift)
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e);
    }
  };

  const handlePaste = (e) => {
    const text = e.clipboardData.getData('text');
    const lines = text.split('\n');
    // Detect code: 3+ lines with 30%+ indented
    if (lines.length >= 3) {
      const indentedLines = lines.filter(l => /^[ \t]{2,}/.test(l) && l.trim());
      if (indentedLines.length >= lines.length * 0.3) {
        e.preventDefault();
        const lang = /^\s*(def |class |import |from )/.test(text) ? 'python' : '';
        const wrapped = `\`\`\`${lang}\n${text}\n\`\`\``;
        const el = e.target;
        const start = el.selectionStart;
        const end = el.selectionEnd;
        setInput(input.slice(0, start) + wrapped + input.slice(end));
      }
    }
  };

  const handleImageSelect = (e) => {
    const files = Array.from(e.target.files);
    if (files.length === 0) return;
  
    // Read all files and preserve order
    Promise.all(
      files
        .filter((file) => file.type.startsWith('image/'))
        .map((file) => {
          return new Promise((resolve) => {
            const reader = new FileReader();
            reader.onload = (event) => resolve(event.target.result);
            reader.readAsDataURL(file);
          });
        })
    ).then((results) => {
      setAttachedImages((prev) => [...prev, ...results]);
    });
  
    // Clear the input so the same file can be selected again
    e.target.value = '';
  };

  const removeImage = (index) => {
    setAttachedImages((prev) => prev.filter((_, i) => i !== index));
  };

  const triggerFileInput = () => {
    fileInputRef.current?.click();
  };

  if (!conversation) {
    return (
      <div className="chat-interface">
        <div className="empty-state">
          <h2>Welcome to LLM Council</h2>
          <p>Create a new conversation to get started</p>
        </div>
      </div>
    );
  }

  return (
    <div className="chat-interface">
      <div className="messages-container" ref={containerRef} onScroll={handleScroll}>
        {conversation.messages.length === 0 ? (
          <div className="empty-state">
            <h2>Start a conversation</h2>
            <p>Ask a question to consult the LLM Council</p>
          </div>
        ) : (
          conversation.messages.map((msg, index) => (
            <div key={index} className="message-group">
              {msg.role === 'user' ? (
                <div className="user-message">
                  <div className="message-label">You</div>
                  <div className="message-content">
                    {msg.images && msg.images.length > 0 && (
                      <div className="message-images">
                        {msg.images.map((img, imgIndex) => (
                          <img
                            key={imgIndex}
                            src={img}
                            alt={`Attached ${imgIndex + 1}`}
                            className="message-image"
                          />
                        ))}
                      </div>
                    )}
                    <div className="markdown-content">
                      <ReactMarkdown>{msg.content}</ReactMarkdown>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="assistant-message">
                  <div className="message-label">LLM Council</div>

                  {/* Stage 1 */}
                  {msg.loading?.stage1 && (
                    <div className="stage-loading">
                      <div className="spinner"></div>
                      <span>Running Stage 1: Collecting individual responses...</span>
                    </div>
                  )}
                  {msg.stage1 && <Stage1 responses={msg.stage1} />}
                  {msg.error?.stage === 1 && (
                    <div className="stage-error">
                      <div className="error-content">
                        <span className="error-icon">⚠️</span>
                        <div className="error-details">
                          <strong>Stage 1 Failed</strong>
                          <p>{msg.error.message}</p>
                        </div>
                      </div>
                      <button 
                        className="retry-button"
                        onClick={() => onRetryStage(index, 1)}
                        disabled={isLoading}
                      >
                        Retry Stage 1
                      </button>
                    </div>
                  )}

                  {/* Stage 2 */}
                  {msg.loading?.stage2 && (
                    <div className="stage-loading">
                      <div className="spinner"></div>
                      <span>Running Stage 2: Peer rankings...</span>
                    </div>
                  )}
                  {msg.stage2 && (
                    <Stage2
                      rankings={msg.stage2}
                      labelToModel={msg.metadata?.label_to_model}
                      aggregateRankings={msg.metadata?.aggregate_rankings}
                    />
                  )}
                  {msg.error?.stage === 2 && (
                    <div className="stage-error">
                      <div className="error-content">
                        <span className="error-icon">⚠️</span>
                        <div className="error-details">
                          <strong>Stage 2 Failed</strong>
                          <p>{msg.error.message}</p>
                        </div>
                      </div>
                      <button 
                        className="retry-button"
                        onClick={() => onRetryStage(index, 2)}
                        disabled={isLoading}
                      >
                        Retry Stage 2
                      </button>
                    </div>
                  )}

                  {/* Stage 3 */}
                  {msg.loading?.stage3 && (
                    <div className="stage-loading">
                      <div className="spinner"></div>
                      <span>Running Stage 3: Final synthesis...</span>
                    </div>
                  )}
                  {msg.stage3 && !msg.stage3.response?.startsWith('Error:') && (
                    <Stage3 finalResponse={msg.stage3} />
                  )}
                  {(msg.error?.stage === 3 || msg.stage3?.response?.startsWith('Error:')) && (
                    <div className="stage-error">
                      <div className="error-content">
                        <span className="error-icon">⚠️</span>
                        <div className="error-details">
                          <strong>Stage 3 Failed</strong>
                          <p>{msg.error?.message || msg.stage3?.response || 'Unable to generate final synthesis'}</p>
                        </div>
                      </div>
                      <button 
                        className="retry-button"
                        onClick={() => onRetryStage(index, 3)}
                        disabled={isLoading}
                      >
                        Retry Stage 3
                      </button>
                    </div>
                  )}

                  {/* Debug: Actual Usage Stats */}
                  {msg.stage3 && !msg.stage3.response?.startsWith('Error:') && (() => {
                    const actualUsage = calculateActualUsage(msg);
                    if (!actualUsage) return null;
                    return (
                      <div className="usage-debug">
                        <div className="usage-debug-header">📊 Actual Token Usage</div>
                        <div className="usage-debug-content">
                          <div className="usage-stage">
                            <strong>Stage 1</strong> ({actualUsage.stage1.calls} calls)
                            <div>Prompt: {actualUsage.stage1.promptTokens.toLocaleString()} | Completion: {actualUsage.stage1.completionTokens.toLocaleString()}</div>
                          </div>
                          <div className="usage-stage">
                            <strong>Stage 2</strong> ({actualUsage.stage2.calls} calls)
                            <div>Prompt: {actualUsage.stage2.promptTokens.toLocaleString()} | Completion: {actualUsage.stage2.completionTokens.toLocaleString()}</div>
                          </div>
                          <div className="usage-stage">
                            <strong>Stage 3</strong> (1 call)
                            <div>Prompt: {actualUsage.stage3.promptTokens.toLocaleString()} | Completion: {actualUsage.stage3.completionTokens.toLocaleString()}</div>
                          </div>
                          <div className="usage-total">
                            <strong>Total: </strong>
                            {(actualUsage.stage1.totalTokens + actualUsage.stage2.totalTokens + actualUsage.stage3.totalTokens).toLocaleString()} tokens
                          </div>
                        </div>
                      </div>
                    );
                  })()}
                </div>
              )}
            </div>
          ))
        )}

        {isLoading && (
          <div className="loading-indicator">
            <div className="spinner"></div>
            <span>Consulting the council...</span>
          </div>
        )}

        <div ref={messagesEndRef} />
        {showScrollBtn && (
          <button className="scroll-to-bottom-btn" onClick={scrollTo} title={scrollDirection === 'down' ? 'Scroll to bottom' : 'Scroll to top'}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ transform: scrollDirection === 'up' ? 'rotate(180deg)' : 'none' }}>
              <polyline points="6 9 12 15 18 9"/>
            </svg>
          </button>
        )}
      </div>

      {conversation.messages.length === 0 && (
        <form className="input-form" onSubmit={handleSubmit}>
          {/* Cost Estimate Display */}
          {estimatedCost && (
            <div className="cost-estimate">
              <div className="cost-estimate-header">
                <span className="cost-icon">💰</span>
                <span className="cost-label">Estimated Cost</span>
                <span className="cost-total">${estimatedCost.totalCost.toFixed(4)}</span>
              </div>
              <div className="cost-breakdown">
                <div className="cost-stage">
                  <span>Stage 1 ({estimatedCost.breakdown.stage1.callCount} calls)</span>
                  <span>${estimatedCost.breakdown.stage1.total.toFixed(4)}</span>
                </div>
                <div className="cost-stage-tokens">
                  Est. tokens: {estimatedCost.estimatedTokens.stage1.totalPrompt.toLocaleString()} prompt + {estimatedCost.estimatedTokens.stage1.totalCompletion.toLocaleString()} completion
                </div>
                <div className="cost-stage">
                  <span>Stage 2 ({estimatedCost.breakdown.stage2.callCount} calls)</span>
                  <span>${estimatedCost.breakdown.stage2.total.toFixed(4)}</span>
                </div>
                <div className="cost-stage-tokens">
                  Est. tokens: {estimatedCost.estimatedTokens.stage2.totalPrompt.toLocaleString()} prompt + {estimatedCost.estimatedTokens.stage2.totalCompletion.toLocaleString()} completion
                </div>
                <div className="cost-stage">
                  <span>Stage 3 (1 call)</span>
                  <span>${estimatedCost.breakdown.stage3.total.toFixed(4)}</span>
                </div>
                <div className="cost-stage-tokens">
                  Est. tokens: {estimatedCost.estimatedTokens.stage3.prompt.toLocaleString()} prompt + {estimatedCost.estimatedTokens.stage3.completion.toLocaleString()} completion
                </div>
                {attachedImages.length > 0 && (
                  <div className="cost-note">
                    📷 {attachedImages.length} image{attachedImages.length > 1 ? 's' : ''} included in cost
                  </div>
                )}
              </div>
            </div>
          )}

          <div className="input-container">
            {attachedImages.length > 0 && (
              <div className="attached-images-preview">
                {attachedImages.map((img, index) => (
                  <div key={index} className="preview-image-container">
                    <img src={img} alt={`Preview ${index + 1}`} className="preview-image" />
                    <button
                      type="button"
                      className="remove-image-btn"
                      onClick={() => removeImage(index)}
                      aria-label="Remove image"
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            )}
            <div className="input-row">
              <button
                type="button"
                className="attach-button"
                onClick={triggerFileInput}
                disabled={isLoading}
                title="Attach images"
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
                  <circle cx="8.5" cy="8.5" r="1.5"/>
                  <polyline points="21 15 16 10 5 21"/>
                </svg>
              </button>
              <textarea
                className="message-input"
                placeholder="Ask your question... (Shift+Enter for new line, Enter to send)"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                onPaste={handlePaste}
                disabled={isLoading}
                rows={3}
              />
              <button
                type="submit"
                className="send-button"
                disabled={(!input.trim() && attachedImages.length === 0) || isLoading}
              >
                Send
              </button>
            </div>
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            onChange={handleImageSelect}
            className="hidden-file-input"
          />
        </form>
      )}
    </div>
  );
}
