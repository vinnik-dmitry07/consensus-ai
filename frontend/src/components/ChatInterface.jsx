import { useState, useEffect, useRef, useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import { markdownComponents, remarkGfmPlugin } from '../markdownComponents';
import { api } from '../api';
import Stage1 from './Stage1';
import Stage2 from './Stage2';
import Stage3 from './Stage3';
import './ChatInterface.css';

const MAX_FILE_SIZE = 100 * 1024;
const MAX_ATTACHMENTS = 10;

const TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'json', 'csv', 'py', 'js', 'jsx', 'ts', 'tsx',
  'html', 'css', 'xml', 'yaml', 'yml', 'log', 'sh', 'bat',
  'rs', 'go', 'java', 'c', 'cpp', 'h', 'sql', 'toml', 'ini',
  'rb', 'php', 'swift', 'kt', 'r', 'lua', 'vue', 'svelte', 'env',
  'tex', 'bib', 'sty', 'cls',
]);

const TEXT_MIME_TYPES = new Set([
  'application/json',
  'application/xml',
  'application/x-tex',
  'application/x-latex',
  'text/x-tex',
  'text/x-latex',
]);

const FILE_ACCEPT = [
  'image/*',
  ...[...TEXT_EXTENSIONS].map((ext) => `.${ext}`),
].join(',');

function isImageFile(file) {
  return file.type.startsWith('image/');
}

function isTextFile(file) {
  if (file.type.startsWith('text/')) return true;
  if (TEXT_MIME_TYPES.has(file.type)) return true;
  const ext = file.name.split('.').pop()?.toLowerCase();
  return TEXT_EXTENSIONS.has(ext);
}

function getAttachmentText(attachments) {
  return attachments
    .filter((item) => item.kind === 'file')
    .map((item) => item.content)
    .join('');
}

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
  const [attachments, setAttachments] = useState([]);
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

  // Calculate estimated cost when input or attachments change
  const estimatedCost = useMemo(() => {
    if (!input.trim() && attachments.length === 0) return null;
    const textForCost = input + getAttachmentText(attachments);
    const numImages = attachments.filter((item) => item.kind === 'image').length;
    return calculateEstimatedCost(textForCost, numImages, pricingData);
  }, [input, attachments, pricingData]);

  const [showScrollBtn, setShowScrollBtn] = useState(false);
  const [scrollDirection, setScrollDirection] = useState('down');
  const containerRef = useRef(null);
  const lastScrollTop = useRef(0);
  const scrollBtnRef = useRef(false);
  const scrollDirRef = useRef('down');

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
    
    const delta = scrollTop - lastScrollTop.current;
    lastScrollTop.current = scrollTop;
    
    // Only update if scroll delta is significant (prevents micro-adjustments)
    if (Math.abs(delta) < 5) return;
    
    if (delta > 0) {
      // Scrolling down
      const shouldShow = !atBottom;
      if (scrollDirRef.current !== 'down') {
        scrollDirRef.current = 'down';
        setScrollDirection('down');
      }
      if (scrollBtnRef.current !== shouldShow) {
        scrollBtnRef.current = shouldShow;
        setShowScrollBtn(shouldShow);
      }
    } else {
      // Scrolling up
      const shouldShow = !atTop;
      if (scrollDirRef.current !== 'up') {
        scrollDirRef.current = 'up';
        setScrollDirection('up');
      }
      if (scrollBtnRef.current !== shouldShow) {
        scrollBtnRef.current = shouldShow;
        setShowScrollBtn(shouldShow);
      }
    }
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    if ((input.trim() || attachments.length > 0) && !isLoading) {
      const images = attachments
        .filter((item) => item.kind === 'image')
        .map((item) => item.data);
      const files = attachments
        .filter((item) => item.kind === 'file')
        .map((item) => ({ name: item.name, content: item.content }));
      onSendMessage(input, images, files);
      setInput('');
      setAttachments([]);
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

  const handleFileSelect = async (e) => {
    const selectedFiles = Array.from(e.target.files);
    if (selectedFiles.length === 0) return;

    const remainingSlots = MAX_ATTACHMENTS - attachments.length;
    if (remainingSlots <= 0) {
      alert(`Maximum ${MAX_ATTACHMENTS} attachments allowed.`);
      e.target.value = '';
      return;
    }

    const newAttachments = [];

    for (const file of selectedFiles.slice(0, remainingSlots)) {
      if (file.size > MAX_FILE_SIZE) {
        alert(`"${file.name}" is too large. Maximum size is 100 KB.`);
        continue;
      }

      if (isImageFile(file)) {
        const data = await new Promise((resolve) => {
          const reader = new FileReader();
          reader.onload = (event) => resolve(event.target.result);
          reader.readAsDataURL(file);
        });
        newAttachments.push({ kind: 'image', data });
      } else if (isTextFile(file)) {
        const content = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = (event) => resolve(event.target.result);
          reader.onerror = () => reject(new Error(`Failed to read ${file.name}`));
          reader.readAsText(file);
        });
        newAttachments.push({ kind: 'file', name: file.name, content });
      } else {
        alert(`"${file.name}" is not a supported file type.`);
      }
    }

    if (newAttachments.length > 0) {
      setAttachments((prev) => [...prev, ...newAttachments]);
    }

    e.target.value = '';
  };

  const removeAttachment = (index) => {
    setAttachments((prev) => prev.filter((_, i) => i !== index));
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
                    {msg.files && msg.files.length > 0 && (
                      <div className="message-files">
                        {msg.files.map((file, fileIndex) => (
                          <span key={fileIndex} className="message-file-chip">
                            📄 {file.name}
                          </span>
                        ))}
                      </div>
                    )}
                    <div className="markdown-content">
                      <ReactMarkdown remarkPlugins={[remarkGfmPlugin]} components={markdownComponents}>{msg.content}</ReactMarkdown>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="assistant-message">
                  <div className="message-label">LLM Council</div>

                  {/* Stage 1 */}
                  {msg.loading?.stage1 && !msg.stage1Progress && (
                    <div className="stage-loading">
                      <div className="spinner"></div>
                      <span>Running Stage 1: Collecting individual responses...</span>
                    </div>
                  )}
                  {msg.stage1Progress && (
                    <Stage1 
                      responses={msg.stage1Progress.results} 
                      progress={msg.stage1Progress}
                    />
                  )}
                  {msg.stage1 && !msg.stage1Progress && <Stage1 responses={msg.stage1} />}
                  {/* Interrupted during Stage 1 - partial results collected */}
                  {msg.streaming && !msg.loading?.stage1 && !msg.stage1Progress && !msg.stage2 && !msg.error && (!msg.stage1 || msg.stage1.length === 0) && (
                    <div className="stage-interrupted">
                      <div className="interrupted-content">
                        <span className="interrupted-icon">⏸️</span>
                        <div className="interrupted-details">
                          <strong>Processing Interrupted</strong>
                          <p>No responses collected yet</p>
                        </div>
                      </div>
                      <button 
                        className="retry-button"
                        onClick={() => onRetryStage(index, 1)}
                        disabled={isLoading}
                      >
                        Resume from Stage 1
                      </button>
                    </div>
                  )}
                  {/* Interrupted during Stage 1 - some results collected but not complete */}
                  {msg.streaming && !msg.loading?.stage1 && !msg.stage1Progress && !msg.stage2 && !msg.error && msg.stage1?.length > 0 && !msg.stage1_complete && (
                    <div className="stage-interrupted">
                      <div className="interrupted-content">
                        <span className="interrupted-icon">⏸️</span>
                        <div className="interrupted-details">
                          <strong>Processing Interrupted</strong>
                          <p>{msg.stage1.length} response(s) collected. Resume to continue or restart.</p>
                        </div>
                      </div>
                      <div className="interrupted-buttons">
                        <button 
                          className="retry-button"
                          onClick={() => onRetryStage(index, 1)}
                          disabled={isLoading}
                        >
                          Resume Stage 1
                        </button>
                        <button 
                          className="retry-button secondary"
                          onClick={() => onRetryStage(index, 2)}
                          disabled={isLoading}
                        >
                          Skip to Stage 2
                        </button>
                      </div>
                    </div>
                  )}
                  {/* Stage 1 complete but Stage 2 was interrupted */}
                  {msg.streaming && !msg.loading?.stage2 && msg.stage1_complete && !msg.stage2 && !msg.error && (
                    <div className="stage-interrupted">
                      <div className="interrupted-content">
                        <span className="interrupted-icon">⏸️</span>
                        <div className="interrupted-details">
                          <strong>Processing Interrupted</strong>
                          <p>Stage 1 complete. Ready for peer rankings.</p>
                        </div>
                      </div>
                      <button 
                        className="retry-button"
                        onClick={() => onRetryStage(index, 2)}
                        disabled={isLoading}
                      >
                        Resume from Stage 2
                      </button>
                    </div>
                  )}
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
                      {msg.stage2Progress && (
                        <span className="progress-count">
                          {msg.stage2Progress.completed}/{msg.stage2Progress.total}
                        </span>
                      )}
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
                  {/* Interrupted after Stage 2 complete, before Stage 3 */}
                  {msg.streaming && !msg.loading?.stage3 && msg.stage2 && !msg.stage3 && !msg.error && (
                    <div className="stage-interrupted">
                      <div className="interrupted-content">
                        <span className="interrupted-icon">⏸️</span>
                        <div className="interrupted-details">
                          <strong>Processing Interrupted</strong>
                          <p>Rankings complete. Ready for final synthesis.</p>
                        </div>
                      </div>
                      <button 
                        className="retry-button"
                        onClick={() => onRetryStage(index, 3)}
                        disabled={isLoading}
                      >
                        Resume from Stage 3
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

        <div ref={messagesEndRef} data-scroll-anchor />
      </div>

      <button 
        className={`scroll-to-bottom-btn ${showScrollBtn ? 'visible' : ''}`} 
        onClick={scrollTo} 
        title={scrollDirection === 'down' ? 'Scroll to bottom' : 'Scroll to top'}
        style={{ opacity: showScrollBtn ? 1 : 0, pointerEvents: showScrollBtn ? 'auto' : 'none' }}
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ transform: scrollDirection === 'up' ? 'rotate(180deg)' : 'none' }}>
          <polyline points="6 9 12 15 18 9"/>
        </svg>
      </button>

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
                {attachments.filter((item) => item.kind === 'image').length > 0 && (
                  <div className="cost-note">
                    📷 {attachments.filter((item) => item.kind === 'image').length} image
                    {attachments.filter((item) => item.kind === 'image').length > 1 ? 's' : ''} included in cost
                  </div>
                )}
                {attachments.filter((item) => item.kind === 'file').length > 0 && (
                  <div className="cost-note">
                    📄 {attachments.filter((item) => item.kind === 'file').length} file
                    {attachments.filter((item) => item.kind === 'file').length > 1 ? 's' : ''} included in token estimate
                  </div>
                )}
              </div>
            </div>
          )}

          <div className="input-container">
            {attachments.length > 0 && (
              <div className="attached-files-preview">
                {attachments.map((item, index) => (
                  <div key={index} className="preview-attachment">
                    {item.kind === 'image' ? (
                      <img src={item.data} alt={`Preview ${index + 1}`} className="preview-image" />
                    ) : (
                      <div className="preview-file-chip" title={item.name}>
                        <span className="preview-file-icon">📄</span>
                        <span className="preview-file-name">{item.name}</span>
                      </div>
                    )}
                    <button
                      type="button"
                      className="remove-attachment-btn"
                      onClick={() => removeAttachment(index)}
                      aria-label="Remove attachment"
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
                title="Attach images or text files (.tex, .md, code, etc.)"
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/>
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
                disabled={(!input.trim() && attachments.length === 0) || isLoading}
              >
                Send
              </button>
            </div>
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept={FILE_ACCEPT}
            multiple
            onChange={handleFileSelect}
            className="hidden-file-input"
          />
        </form>
      )}
    </div>
  );
}
