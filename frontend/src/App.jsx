import { useState, useEffect, useRef } from 'react';
import Sidebar from './components/Sidebar';
import ChatInterface from './components/ChatInterface';
import Settings from './components/Settings';
import { api } from './api';
import { applyStage1Event, knownList, stageRetryPatch } from './stage1State.js';
import { getEngineMode } from './engine/index.js';
import { runAllowedBySettings } from './engine/browser/roster.js';
import { SETTINGS_CHANGED_EVENT, STORAGE_KEY } from './engine/browser/settings.js';
import { openShare, parseShareLocation, sameShareRef } from './share/index.js';
import './App.css';

function App() {
  const [conversations, setConversations] = useState([]);
  const [currentConversationId, setCurrentConversationId] = useState(() => {
    const params = new URLSearchParams(window.location.search);
    return params.get('c');
  });
  const [currentConversation, setCurrentConversation] = useState(null);
  const [isLoading, setIsLoading] = useState(false);
  const activeRunsRef = useRef(new Set());
  const currentIdRef = useRef(currentConversationId);
  const shareTokenRef = useRef(0);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [settingsVersion, setSettingsVersion] = useState(0);
  const [darkMode, setDarkMode] = useState(() => localStorage.getItem('theme') === 'dark');
  const [engineMode, setEngineMode] = useState(() => getEngineMode());
  const [shareRef, setShareRef] = useState(() => parseShareLocation(window.location));
  const [sharedView, setSharedView] = useState(null);
  const [shareSaving, setShareSaving] = useState(false);
  const [shareSaveError, setShareSaveError] = useState(null);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', darkMode ? 'dark' : 'light');
    localStorage.setItem('theme', darkMode ? 'dark' : 'light');
  }, [darkMode]);

  useEffect(() => {
    const bumpBrowserSettings = () => {
      if (getEngineMode() !== 'browser') return;
      setSettingsVersion((version) => version + 1);
    };
    const onStorage = (event) => {
      if (event.key !== STORAGE_KEY) return;
      bumpBrowserSettings();
    };
    window.addEventListener('storage', onStorage);
    window.addEventListener(SETTINGS_CHANGED_EVENT, bumpBrowserSettings);
    return () => {
      window.removeEventListener('storage', onStorage);
      window.removeEventListener(SETTINGS_CHANGED_EVENT, bumpBrowserSettings);
    };
  }, []);

  // Sync URL with conversation ID, and remember which chat is on screen
  // so a run that finishes in the background does not clear this chat's spinner.
  useEffect(() => {
    currentIdRef.current = currentConversationId;
    const url = new URL(window.location);
    // A share link keeps its query and the key in the fragment.
    if (url.searchParams.has('share')) return;
    if (currentConversationId) {
      url.searchParams.set('c', currentConversationId);
    } else {
      url.searchParams.delete('c');
    }
    window.history.replaceState({}, '', url);
  }, [currentConversationId]);

  useEffect(() => {
    if (!shareRef) return undefined;
    let active = true;
    setShareSaving(false);
    setShareSaveError(null);
    setSharedView({ status: 'loading' });
    openShare(shareRef)
      .then((conversation) => {
        if (active) setSharedView({ status: 'ready', conversation });
      })
      .catch((error) => {
        if (!active) return;
        setSharedView({
          status: 'error',
          message: error instanceof Error ? error.message : 'Could not open this share.',
        });
      });
    return () => {
      active = false;
    };
  }, [shareRef]);

  // Handle browser back/forward
  useEffect(() => {
    const handlePopState = () => {
      const nextShare = parseShareLocation(window.location);
      setShareRef((current) => {
        if (sameShareRef(current, nextShare)) return current;
        shareTokenRef.current += 1;
        return nextShare;
      });
      if (!nextShare) setSharedView(null);
      const params = new URLSearchParams(window.location.search);
      setCurrentConversationId(params.get('c'));
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  // Load conversations on mount
  useEffect(() => {
    loadConversations();
  }, []);

  // Load conversation details when selected
  useEffect(() => {
    if (shareRef) return;
    if (currentConversationId) {
      loadConversation(currentConversationId);
    }
  }, [currentConversationId, shareRef]);

  const loadConversations = async () => {
    try {
      const convs = await api.listConversations();
      setConversations(convs);
    } catch (error) {
      console.error('Failed to load conversations:', error);
    }
  };

  const finishRun = (runConvId) => {
    activeRunsRef.current.delete(runConvId);
    if (currentIdRef.current === runConvId) setIsLoading(false);
  };

  const loadConversation = async (id) => {
    try {
      const conv = await api.getConversation(id);
      setCurrentConversation((prev) => (
        prev?.id === id && activeRunsRef.current.has(id) ? prev : conv
      ));
    } catch (error) {
      console.error('Failed to load conversation:', error);
    }
  };

  const leaveShareUrl = (adjust) => {
    shareTokenRef.current += 1;
    const url = new URL(window.location);
    url.searchParams.delete('share');
    url.hash = '';
    if (adjust) adjust(url);
    window.history.pushState({}, '', url);
    setShareRef(null);
    setSharedView(null);
    setShareSaving(false);
    setShareSaveError(null);
  };

  const handleNewConversation = () => {
    currentIdRef.current = null;
    setIsLoading(false);
    // Don't create on backend yet - wait for first message
    leaveShareUrl((url) => url.searchParams.delete('c'));
    setCurrentConversationId(null);
    setCurrentConversation({ id: null, messages: [], title: 'New Conversation' });
  };

  const handleSelectConversation = (id) => {
    currentIdRef.current = id;
    setIsLoading(activeRunsRef.current.has(id));
    leaveShareUrl((url) => {
      if (id) url.searchParams.set('c', id);
      else url.searchParams.delete('c');
    });
    setCurrentConversationId(id);
  };

  const closeShare = () => {
    leaveShareUrl();
    if (!currentConversationId) {
      setCurrentConversation({ id: null, messages: [], title: 'New Conversation' });
    }
  };

  const handleSaveShare = async () => {
    const conversation = sharedView?.status === 'ready' ? sharedView.conversation : null;
    if (!conversation || shareSaving) return;
    const token = shareTokenRef.current;
    setShareSaving(true);
    setShareSaveError(null);
    try {
      await api.importConversations({ conversations: [conversation] });
      await loadConversations();
      if (shareTokenRef.current !== token) return;
      setCurrentConversation(conversation);
      handleSelectConversation(conversation.id);
    } catch (error) {
      if (shareTokenRef.current !== token) return;
      setShareSaveError(error instanceof Error ? error.message : 'Could not save this conversation.');
      setShareSaving(false);
    }
  };

  const handleRemoveConversation = async (id) => {
    try {
      await api.removeConversation(id);
      setConversations((prev) => prev.filter((c) => c.id !== id));
      if (currentConversationId === id) {
        handleNewConversation();
      }
    } catch (error) {
      console.error('Failed to remove conversation:', error);
    }
  };

  // Handle streaming events for both new messages and retries
  const handleStreamEvent = (eventType, event, messageIndex, runConvId) => {
    // Helper to get the message to update
    const getTargetMsgIndex = (prev) => {
      return messageIndex !== null ? messageIndex : prev.messages.length - 1;
    };

    // Only the conversation that started this run accepts its events.
    const updateIfCurrentConv = (updater) => {
      setCurrentConversation((prev) => {
        if (!prev || prev.id !== runConvId) return prev;
        return updater(prev);
      });
    };

    switch (eventType) {
      case 'stage1_start':
      case 'stage1_init':
      case 'stage1_model_complete':
      case 'stage1_model_failed':
      case 'stage1_complete':
      case 'stage1_error':
        updateIfCurrentConv((prev) => {
          const messages = [...prev.messages];
          const idx = getTargetMsgIndex(prev);
          if (!messages[idx]) return prev;
          messages[idx] = applyStage1Event(messages[idx], eventType, event);
          return { ...prev, messages };
        });
        if (eventType === 'stage1_error') finishRun(runConvId);
        break;

      case 'stage2_start':
        updateIfCurrentConv((prev) => {
          const messages = [...prev.messages];
          const idx = getTargetMsgIndex(prev);
          messages[idx] = { 
            ...messages[idx], 
            loading: { ...messages[idx].loading, stage2: true },
            stage2Progress: null,
            stage2_failures: [],
            stage2_skipped: [],
            stage2: null,
            stage3: null,
            metadata: null,
          };
          return { ...prev, messages };
        });
        break;

      case 'stage2_init':
        updateIfCurrentConv((prev) => {
          const messages = [...prev.messages];
          const idx = getTargetMsgIndex(prev);
          messages[idx] = {
            ...messages[idx],
            stage2Progress: { 
              total: event.data.total_models, 
              completed: 0
            }
          };
          return { ...prev, messages };
        });
        break;

      case 'stage2_model_complete':
      case 'stage2_model_failed':
        updateIfCurrentConv((prev) => {
          const messages = [...prev.messages];
          const idx = getTargetMsgIndex(prev);
          const progress = messages[idx].stage2Progress;
          const recordFailure = eventType === 'stage2_model_failed' && !event.data.skipped;
          const nextFailures = recordFailure
            ? [...(messages[idx].stage2_failures || []), event.data]
            : messages[idx].stage2_failures;
          const nextSkipped = eventType === 'stage2_model_failed' && event.data.skipped
            ? [...(messages[idx].stage2_skipped || []), event.data]
            : messages[idx].stage2_skipped;
          if (progress) {
            messages[idx] = {
              ...messages[idx],
              stage2_failures: nextFailures,
              stage2_skipped: nextSkipped,
              stage2Progress: {
                ...progress,
                completed: progress.completed + 1
              }
            };
          } else if (eventType === 'stage2_model_failed') {
            messages[idx] = {
              ...messages[idx],
              stage2_failures: nextFailures,
              stage2_skipped: nextSkipped,
            };
          }
          return { ...prev, messages };
        });
        break;

      case 'stage2_complete':
        updateIfCurrentConv((prev) => {
          const messages = [...prev.messages];
          const idx = getTargetMsgIndex(prev);
          messages[idx] = { 
            ...messages[idx], 
            stage2: event.data,
            stage2_failures: knownList(event.failures, messages[idx].stage2_failures),
            stage2_skipped: knownList(event.skipped, messages[idx].stage2_skipped),
            metadata: event.metadata, 
            loading: { ...messages[idx].loading, stage2: false },
            stage2Progress: null
          };
          return { ...prev, messages };
        });
        break;

      case 'redteam_start':
        updateIfCurrentConv((prev) => {
          const messages = [...prev.messages];
          const idx = getTargetMsgIndex(prev);
          messages[idx] = {
            ...messages[idx],
            stage3: null,
            loading: { ...messages[idx].loading, redteam: true },
          };
          return { ...prev, messages };
        });
        break;

      case 'redteam_complete':
        updateIfCurrentConv((prev) => {
          const messages = [...prev.messages];
          const idx = getTargetMsgIndex(prev);
          messages[idx] = {
            ...messages[idx],
            metadata: event.metadata || messages[idx].metadata,
            loading: { ...messages[idx].loading, redteam: false },
          };
          return { ...prev, messages };
        });
        break;

      case 'redteam_error':
        updateIfCurrentConv((prev) => {
          const messages = [...prev.messages];
          const idx = getTargetMsgIndex(prev);
          messages[idx] = {
            ...messages[idx],
            metadata: event.metadata || messages[idx].metadata,
            loading: { ...messages[idx].loading, redteam: false },
          };
          return { ...prev, messages };
        });
        break;

      case 'stage2_error':
        updateIfCurrentConv((prev) => {
          const messages = [...prev.messages];
          const idx = getTargetMsgIndex(prev);
          messages[idx] = {
            ...messages[idx],
            loading: { ...messages[idx].loading, stage2: false },
            error: { stage: 2, message: event.message },
            stage2_failures: knownList(event.failures, messages[idx].stage2_failures),
            stage2_skipped: knownList(event.skipped, messages[idx].stage2_skipped),
          };
          return { ...prev, messages };
        });
        finishRun(runConvId);
        break;

      case 'stage3_start':
        updateIfCurrentConv((prev) => {
          const messages = [...prev.messages];
          const idx = getTargetMsgIndex(prev);
          messages[idx] = { ...messages[idx], loading: { ...messages[idx].loading, stage3: true } };
          return { ...prev, messages };
        });
        break;

      case 'stage3_complete':
        updateIfCurrentConv((prev) => {
          const messages = [...prev.messages];
          const idx = getTargetMsgIndex(prev);
          messages[idx] = { ...messages[idx], stage3: event.data, loading: { ...messages[idx].loading, stage3: false } };
          return { ...prev, messages };
        });
        break;

      case 'stage3_error':
        updateIfCurrentConv((prev) => {
          const messages = [...prev.messages];
          const idx = getTargetMsgIndex(prev);
          messages[idx] = { ...messages[idx], loading: { ...messages[idx].loading, stage3: false }, error: { stage: 3, message: event.message } };
          return { ...prev, messages };
        });
        finishRun(runConvId);
        break;

      case 'title_complete':
        setConversations((prev) => prev.map((conv) => (
          conv.id === runConvId
            ? { ...conv, title: event.data?.title || conv.title }
            : conv
        )));
        break;

      case 'complete':
        // Clear any error state on success
        updateIfCurrentConv((prev) => {
          const messages = [...prev.messages];
          const idx = getTargetMsgIndex(prev);
          if (messages[idx]) {
            messages[idx] = { ...messages[idx], error: null };
          }
          return { ...prev, messages };
        });
        loadConversations();
        finishRun(runConvId);
        break;

      case 'error':
        updateIfCurrentConv((prev) => {
          const messages = [...prev.messages];
          const idx = getTargetMsgIndex(prev);
          if (!messages[idx]) return prev;
          const stage = event.stage;
          const stagedError = stage === 1 || stage === 2 || stage === 3;
          messages[idx] = {
            ...messages[idx],
            loading: { stage1: false, stage2: false, redteam: false, stage3: false },
            streaming: false,
            error: {
              stage: stagedError ? stage : null,
              message: event.message,
            },
          };
          return { ...prev, messages };
        });
        finishRun(runConvId);
        break;

      default:
        console.log('Unknown event type:', eventType);
    }
  };

  const readCanRun = async () => {
    try {
      const data = await Promise.resolve(api.getSettings());
      return runAllowedBySettings(data);
    } catch (error) {
      console.error('Failed to read settings:', error);
      return false;
    }
  };

  const refuseRun = () => {
    setSettingsVersion((version) => version + 1);
  };

  const handleSendMessage = async (
    content,
    images = [],
    files = [],
  ) => {
    if (!currentConversation) return false;
    if (!(await readCanRun())) {
      refuseRun();
      return false;
    }
    void sendAdmittedMessage(content, images, files);
    return true;
  };

  const sendAdmittedMessage = async (
    content,
    images = [],
    files = [],
  ) => {
    let convId = currentConversationId;
    setIsLoading(true);
    try {
      // Create conversation on backend if this is a new conversation
      if (!convId) {
        const newConv = await api.createConversation();
        convId = newConv.id;
        // Mark the run before changing the id, so the load effect keeps
        // the optimistic transcript instead of replacing it.
        activeRunsRef.current.add(convId);
        currentIdRef.current = convId;
        setCurrentConversationId(convId);
        setConversations((prev) => [
          { id: newConv.id, created_at: newConv.created_at, title: 'New Conversation', message_count: 0 },
          ...prev,
        ]);
      } else {
        activeRunsRef.current.add(convId);
      }

      const userMessage = {
        role: 'user',
        content,
        images: images.length > 0 ? images : undefined,
        files: files.length > 0 ? files : undefined,
      };
      const assistantMessage = {
        role: 'assistant',
        stage1: null,
        stage2: null,
        stage3: null,
        metadata: null,
        error: null,
        stage1_failures: [],
        stage1_skipped: [],
        loading: {
          stage1: true,
          stage2: false,
          redteam: false,
          stage3: false,
        },
      };
      setCurrentConversation((prev) => {
        if (!prev || (prev.id && prev.id !== convId)) return prev;
        return {
          ...prev,
          id: convId,
          messages: [...prev.messages, userMessage, assistantMessage],
        };
      });

      await api.sendMessageStream(
        convId,
        content,
        images,
        files,
        (eventType, event) => {
          handleStreamEvent(eventType, event, null, convId);
        },
      );
    } catch (error) {
      console.error('Failed to send message:', error);
      setCurrentConversation((prev) => {
        if (!prev || prev.id !== convId) return prev;
        return { ...prev, messages: prev.messages.slice(0, -2) };
      });
      if (convId) finishRun(convId);
      else setIsLoading(false);
    }
  };

  const handleRetryStage = async (messageIndex, stage) => {
    const convId = currentConversationId;
    if (!convId) return;
    if (!(await readCanRun())) {
      refuseRun();
      return;
    }

    activeRunsRef.current.add(convId);
    setIsLoading(true);
    try {
      setCurrentConversation((prev) => {
        if (!prev || prev.id !== convId) return prev;
        const messages = [...prev.messages];
        const msg = messages[messageIndex];
        messages[messageIndex] = stageRetryPatch(msg, stage);
        return { ...prev, messages };
      });

      await api.retryStage(convId, stage, messageIndex, (eventType, event) => {
        handleStreamEvent(eventType, event, messageIndex, convId);
      });
    } catch (error) {
      console.error(`Failed to retry stage ${stage}:`, error);
      setCurrentConversation((prev) => {
        if (!prev || prev.id !== convId) return prev;
        const messages = [...prev.messages];
        if (!messages[messageIndex]) return prev;
        messages[messageIndex] = {
          ...messages[messageIndex],
          loading: { stage1: false, stage2: false, redteam: false, stage3: false },
          error: { stage, message: error.message },
        };
        return { ...prev, messages };
      });
      finishRun(convId);
    }
  };

  const viewingShare = Boolean(shareRef);
  const shownConversation = viewingShare
    ? (sharedView?.status === 'ready'
      ? sharedView.conversation
      : { id: null, messages: [], title: 'Shared conversation' })
    : currentConversation;
  const shareStatus = sharedView?.status;
  let shareBanner = 'Opening shared conversation...';
  if (shareStatus === 'error') shareBanner = sharedView.message || 'Could not open this share.';
  if (shareStatus === 'ready') shareBanner = 'Shared conversation, read-only';
  if (shareSaveError) shareBanner = `${shareBanner} ${shareSaveError}`;

  return (
    <div className="app">
      <Sidebar
        conversations={conversations}
        currentConversationId={viewingShare ? null : currentConversationId}
        onSelectConversation={handleSelectConversation}
        onNewConversation={handleNewConversation}
        onRemoveConversation={handleRemoveConversation}
        onOpenSettings={() => setIsSettingsOpen(true)}
        darkMode={darkMode}
        onToggleDarkMode={() => setDarkMode(!darkMode)}
        engineMode={engineMode}
        settingsVersion={settingsVersion}
      />
      <div className="main-column">
        {viewingShare && (
          <div className="share-banner" role="status">
            <div className="share-banner-text">{shareBanner}</div>
            <div className="share-banner-actions">
              {shareStatus === 'ready' && (
                <button
                  type="button"
                  className="share-banner-save"
                  onClick={handleSaveShare}
                  disabled={shareSaving}
                >
                  {shareSaving ? 'Saving...' : 'Save to my chats'}
                </button>
              )}
              <button type="button" onClick={closeShare}>Close</button>
            </div>
          </div>
        )}
        <ChatInterface
          key={viewingShare ? `share:${shareRef.provider || 'invalid'}:${shareRef.id || 'link'}` : (currentConversationId ?? 'new')}
          conversation={shownConversation}
          onSendMessage={handleSendMessage}
          onRetryStage={handleRetryStage}
          isLoading={viewingShare ? false : isLoading}
          settingsVersion={settingsVersion}
          onOpenSettings={() => setIsSettingsOpen(true)}
          readOnly={viewingShare}
        />
      </div>
      <Settings
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
        onSettingsChange={() => {
          setSettingsVersion((v) => v + 1);
        }}
        onEngineChange={() => {
          setEngineMode(getEngineMode());
          setSettingsVersion((v) => v + 1);
          handleNewConversation();
          loadConversations();
        }}
        onConversationsChanged={() => {
          loadConversations();
          if (currentIdRef.current) loadConversation(currentIdRef.current);
        }}
      />
    </div>
  );
}

export default App;
