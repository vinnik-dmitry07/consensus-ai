import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import './Stage1.css';

export default function Stage1({ responses }) {
  const [activeTab, setActiveTab] = useState(0);

  if (!responses || responses.length === 0) {
    return null;
  }

  return (
    <div className="stage stage1">
      <h3 className="stage-title">Stage 1: Individual Responses</h3>

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
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{responses[activeTab].response}</ReactMarkdown>
        </div>
      </div>
    </div>
  );
}
