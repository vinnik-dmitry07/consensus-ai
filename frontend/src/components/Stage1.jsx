import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { markdownComponents, remarkGfmPlugin } from '../markdownComponents';
import { answerTabsFrom, pickAnswerTab, safeNoteReason, shortModelName } from '../stage1State.js';
import CopyButton from './CopyButton';
import './Stage1.css';

function noteLine(kind, item) {
  const name = shortModelName(item?.model);
  const reason = safeNoteReason(kind, item?.error?.message);
  const label = kind === 'skip' ? 'Skipped' : 'Failed';
  if (!reason) return `${label}: ${name}`;
  return `${label}: ${name} — ${reason}`;
}

export default function Stage1({
  responses = [],
  progress,
  failures = [],
  skipped = [],
  isRunning = false,
  components = markdownComponents,
}) {
  const [selectedSource, setSelectedSource] = useState(null);
  const [seenRunning, setSeenRunning] = useState(isRunning);
  if (isRunning !== seenRunning) {
    setSeenRunning(isRunning);
    if (isRunning) setSelectedSource(null);
  }

  const failureNotes = Array.isArray(failures) ? failures : [];
  const skippedNotes = Array.isArray(skipped) ? skipped : [];
  const answerTabs = answerTabsFrom(responses);
  const active = pickAnswerTab(answerTabs, selectedSource);
  const showProgress = isRunning && progress != null;
  const total = Number(progress?.total);
  const completed = Number(progress?.completed);
  const hasTotal = Number.isFinite(total) && total > 0;
  const progressText = hasTotal ? `${answerTabs.length}/${total} responses` : '0 responses';
  const progressPct = hasTotal && Number.isFinite(completed)
    ? Math.min(100, Math.max(0, (completed / total) * 100))
    : 0;
  const counts = new Map();
  for (const tab of answerTabs) {
    const key = typeof tab.model === 'string' ? tab.model : '';
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const seen = new Map();

  return (
    <div className='stage stage1'>
      <h3 className='stage-title'>
        Stage 1: Individual Responses
        {showProgress && (
          <span className='progress-indicator'>
            <span className='progress-spinner'></span>
            {progressText}
          </span>
        )}
      </h3>

      {showProgress && (
        <div className='progress-bar-container'>
          <div
            className='progress-bar'
            style={{ width: `${progressPct}%` }}
          />
        </div>
      )}

      {active ? (
        <>
          <div className='tabs'>
            {answerTabs.map((tab) => {
              const key = typeof tab.model === 'string' ? tab.model : '';
              const sampleNumber = (seen.get(key) || 0) + 1;
              seen.set(key, sampleNumber);
              const sameModelCount = counts.get(key) || 0;
              const isActive = active.sourceIndex === tab.sourceIndex;
              return (
                <button
                  key={`answer-${tab.sourceIndex}`}
                  type='button'
                  className={`tab${isActive ? ' active' : ''}`}
                  onClick={() => setSelectedSource(tab.sourceIndex)}
                >
                  {shortModelName(tab.model)}
                  {sameModelCount > 1 ? ` #${sampleNumber}` : ''}
                </button>
              );
            })}
          </div>

          <div className='tab-content'>
            <div className='model-name'>{active.model}</div>
            <div className='response-text markdown-content'>
              <ReactMarkdown remarkPlugins={[remarkGfmPlugin]} components={components}>
                {active.response}
              </ReactMarkdown>
            </div>
            <div className='copy-row'>
              <CopyButton text={active.response} label='Copy response' />
            </div>
          </div>
        </>
      ) : isRunning ? (
        <div className='waiting-message'>Waiting for first response...</div>
      ) : (
        <div className='waiting-message'>No successful responses</div>
      )}

      {(failureNotes.length > 0 || skippedNotes.length > 0) && (
        <div className='stage-skipped stage1-notes'>
          {failureNotes.map((item, index) => (
            <p key={`fail-${item?.model || 'model'}-${index}`}>{noteLine('fail', item)}</p>
          ))}
          {skippedNotes.map((item, index) => (
            <p key={`skip-${item?.model || 'model'}-${index}`}>{noteLine('skip', item)}</p>
          ))}
        </div>
      )}
    </div>
  );
}
