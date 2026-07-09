import { useState, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import { markdownComponents, remarkGfmPlugin } from '../markdownComponents';
import './Stage1.css';

export default function Stage1({ responses, progress }) {
  const [activeTab, setActiveTab] = useState(0);

  // Auto-select latest response when streaming
  useEffect(() => {
    if (progress && responses.length > 0) {
      setActiveTab(responses.length - 1);
    }
  }, [responses.length, progress]);

  const isStreaming = !!progress;
  const hasResponses = responses && responses.length > 0;

  return (
    <div className="stage stage1">
      <h3 className="stage-title">
        Stage 1: Individual Responses
        {isStreaming && (
          <span className="progress-indicator">
            <span className="progress-spinner"></span>
            {progress.completed}/{progress.total}
          </span>
        )}
      </h3>

      {isStreaming && (
        <div className="progress-bar-container">
          <div 
            className="progress-bar" 
            style={{ width: `${(progress.completed / progress.total) * 100}%` }}
          />
        </div>
      )}

      {hasResponses ? (
        <>
          <div className="tabs">
            {responses.map((resp, index) => {
              const modelName = resp.model.split('/')[1] || resp.model;
              const sameModelCount = responses.filter(r => r.model === resp.model).length;
              const currentModelIndex = responses.slice(0, index + 1).filter(r => r.model === resp.model).length;

              return (
                <button
                  key={index}
                  className={`tab ${activeTab === index ? 'active' : ''}`}
                  onClick={() => setActiveTab(index)}
                >
                  {modelName}
                  {sameModelCount > 1 && ` #${currentModelIndex}`}
                </button>
              );
            })}
          </div>

          <div className="tab-content">
            <div className="model-name">{responses[activeTab].model}</div>
            <div className="response-text markdown-content">
              <ReactMarkdown remarkPlugins={[remarkGfmPlugin]} components={markdownComponents}>{responses[activeTab].response}</ReactMarkdown>
            </div>
          </div>
        </>
      ) : isStreaming ? (
        <div className="waiting-message">Waiting for first response...</div>
      ) : null}
    </div>
  );
}
