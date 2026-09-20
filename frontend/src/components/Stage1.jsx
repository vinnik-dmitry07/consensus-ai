import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { markdownComponents, remarkGfmPlugin } from '../markdownComponents';
import CopyButton from './CopyButton';
import './Stage1.css';

export default function Stage1({ responses = [], progress, failures = [] }) {
  const [activeTab, setActiveTab] = useState(null);

  const tabs = [
    ...responses.map((resp, index) => ({
      key: `ok-${index}`,
      kind: 'ok',
      model: resp.model,
      response: resp.response,
    })),
    ...failures.map((failure, index) => ({
      key: `fail-${index}`,
      kind: 'fail',
      model: failure.model,
      error: failure.error || {},
    })),
  ];

  const countByModel = {};
  for (const tab of tabs) {
    countByModel[tab.model] = (countByModel[tab.model] || 0) + 1;
  }
  const seenByModel = {};

  const isStreaming = !!progress;
  const latestIndex = Math.max(tabs.length - 1, 0);
  const safeIndex = activeTab === null
    ? latestIndex
    : Math.min(activeTab, latestIndex);
  const active = tabs[safeIndex];

  return (
    <div className='stage stage1'>
      <h3 className='stage-title'>
        Stage 1: Individual Responses
        {isStreaming && (
          <span className='progress-indicator'>
            <span className='progress-spinner'></span>
            {progress.completed}/{progress.total}
          </span>
        )}
      </h3>

      {isStreaming && (
        <div className='progress-bar-container'>
          <div
            className='progress-bar'
            style={{ width: `${(progress.completed / progress.total) * 100}%` }}
          />
        </div>
      )}

      {active ? (
        <>
          <div className='tabs'>
            {tabs.map((tab, index) => {
              const modelName = tab.model.split('/')[1] || tab.model;
              seenByModel[tab.model] = (seenByModel[tab.model] || 0) + 1;
              const currentModelIndex = seenByModel[tab.model];
              const sameModelCount = countByModel[tab.model];

              return (
                <button
                  key={tab.key}
                  className={`tab ${safeIndex === index ? 'active' : ''} ${tab.kind === 'fail' ? 'tab-failed' : ''}`}
                  onClick={() => setActiveTab(index)}
                >
                  {modelName}
                  {sameModelCount > 1 && ` #${currentModelIndex}`}
                  {tab.kind === 'fail' && ' (failed)'}
                </button>
              );
            })}
          </div>

          <div className='tab-content'>
            <div className='model-name'>{active.model}</div>
            {active.kind === 'fail' ? (
              <div className='stage-error'>
                <div className='error-details'>
                  <strong>{active.error.message || 'Request failed'}</strong>
                  {active.error.detail && active.error.message !== active.error.detail && (
                    <p>{active.error.detail}</p>
                  )}
                </div>
              </div>
            ) : (
              <>
                <div className='response-text markdown-content'>
                  <ReactMarkdown remarkPlugins={[remarkGfmPlugin]} components={markdownComponents}>
                    {active.response}
                  </ReactMarkdown>
                </div>
                <div className='copy-row'>
                  <CopyButton text={active.response} label='Copy response' />
                </div>
              </>
            )}
          </div>
        </>
      ) : isStreaming ? (
        <div className='waiting-message'>Waiting for first response...</div>
      ) : null}
    </div>
  );
}
