import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { engineLabel } from '../engine/index.js';
import './Sidebar.css';

export default function Sidebar({
  conversations,
  currentConversationId,
  onSelectConversation,
  onNewConversation,
  onRemoveConversation,
  onOpenSettings,
  darkMode,
  onToggleDarkMode,
  engineMode = 'browser',
  settingsVersion = 0,
}) {
  const [credits, setCredits] = useState(null);
  const creditsContext = `${engineMode}:${settingsVersion}`;
  const [seenCreditsContext, setSeenCreditsContext] = useState(creditsContext);
  const creditsRequest = useRef(creditsContext);
  creditsRequest.current = creditsContext;
  if (seenCreditsContext !== creditsContext) {
    setSeenCreditsContext(creditsContext);
    setCredits(null);
  }

  useEffect(() => {
    const generation = creditsContext;
    let intervalId = null;
    let cancelled = false;
    const current = () => !cancelled && creditsRequest.current === generation;

    const poll = async () => {
      if (!current()) return;
      try {
        const data = await api.getCredits();
        if (current()) setCredits(data);
      } catch (error) {
        if (current()) console.error('Failed to fetch credits:', error);
      }
    };

    const load = async () => {
      let settingsData;
      try {
        settingsData = await Promise.resolve(api.getSettings());
      } catch (error) {
        if (current()) console.error('Failed to fetch credits:', error);
        return;
      }
      if (!current() || !settingsData?.has_api_key) return;
      await poll();
      if (!current()) return;
      intervalId = setInterval(poll, 30000);
    };

    load();
    return () => {
      cancelled = true;
      if (intervalId != null) clearInterval(intervalId);
    };
  }, [creditsContext]);

  return (
    <div className="sidebar">
      <div className="sidebar-header">
        <div className="header-row">
          <div className="brand">
            <h1 className="brand-logo">
              <img
                className="theme-light"
                src={`${import.meta.env.BASE_URL}logo-light.svg`}
                alt="Consensus AI"
              />
              <img
                className="theme-dark"
                src={`${import.meta.env.BASE_URL}logo-dark.svg`}
                alt=""
              />
            </h1>
            <span className="slogan">Search Wide</span>
            <span className="engine-indicator">
              {engineLabel(engineMode)}
            </span>
          </div>
          <button className="theme-toggle" onClick={onToggleDarkMode} title={darkMode ? 'Switch to light mode' : 'Switch to dark mode'}>
            {darkMode ? '☀️' : '🌙'}
          </button>
        </div>
        <button className="new-conversation-btn" onClick={onNewConversation}>
          + New Conversation
        </button>
      </div>

      <div className="conversation-list">
        {conversations.length === 0 ? (
          <div className="no-conversations">No conversations yet</div>
        ) : (
          conversations.map((conv) => (
            <div
              key={conv.id}
              className={`conversation-item ${
                conv.id === currentConversationId ? 'active' : ''
              }`}
              onClick={() => onSelectConversation(conv.id)}
            >
              <div className="conversation-header">
                <div className="conversation-title">
                  {conv.title || 'New Conversation'}
                </div>
                <button
                  className="remove-btn"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (confirm('Remove this conversation?')) {
                      onRemoveConversation(conv.id);
                    }
                  }}
                  title="Remove conversation"
                >
                  ×
                </button>
              </div>
              <div className="conversation-meta">
                {conv.message_count} messages
              </div>
            </div>
          ))
        )}
      </div>

      <div className="sidebar-footer">
        <button className="settings-btn" onClick={onOpenSettings}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3"/>
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>
          </svg>
          Settings
        </button>

        {credits && (
          <div className="credits-display">
            <div className="credits-icon">💳</div>
            <div className='credits-info'>
              <span className='credits-label'>Credits</span>
              <span className='credits-value'>${credits.remaining.toFixed(2)}</span>
              {credits.limit_remaining != null && (
                <span className='credits-key-limit'>
                  Key ${Number(credits.limit_remaining).toFixed(2)} left
                  {credits.limit_reset ? ` (${credits.limit_reset})` : ''}
                </span>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
