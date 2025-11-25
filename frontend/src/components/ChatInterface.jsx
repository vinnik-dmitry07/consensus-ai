import { useState, useEffect, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import Stage1 from './Stage1';
import Stage2 from './Stage2';
import Stage3 from './Stage3';
import './ChatInterface.css';

export default function ChatInterface({
  conversation,
  onSendMessage,
  onRetryStage,
  isLoading,
}) {
  const [input, setInput] = useState('');
  const [attachedImages, setAttachedImages] = useState([]);
  const messagesEndRef = useRef(null);
  const fileInputRef = useRef(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [conversation]);

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
      <div className="messages-container">
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
                  {msg.stage3 && <Stage3 finalResponse={msg.stage3} />}
                  {msg.error?.stage === 3 && (
                    <div className="stage-error">
                      <div className="error-content">
                        <span className="error-icon">⚠️</span>
                        <div className="error-details">
                          <strong>Stage 3 Failed</strong>
                          <p>{msg.error.message}</p>
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
      </div>

      {conversation.messages.length === 0 && (
        <form className="input-form" onSubmit={handleSubmit}>
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
