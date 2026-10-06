import { useState, useEffect, useRef } from 'react';
import Sidebar from './components/Sidebar';
import ChatInterface from './components/ChatInterface';
import Settings from './components/Settings';
import { api } from './api';
import { getEngineMode } from './engine/index.js';
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
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [settingsVersion, setSettingsVersion] = useState(0);
  const [darkMode, setDarkMode] = useState(() => localStorage.getItem('theme') === 'dark');
  const [engineMode, setEngineMode] = useState(() => getEngineMode());

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', darkMode ? 'dark' : 'light');
    localStorage.setItem('theme', darkMode ? 'dark' : 'light');
  }, [darkMode]);

  // Sync URL with conversation ID, and remember which chat is on screen
  // so a run that finishes in the background does not clear this chat's spinner.
  useEffect(() => {
    currentIdRef.current = currentConversationId;
    const url = new URL(window.location);
    if (currentConversationId) {
      url.searchParams.set('c', currentConversationId);
    } else {
      url.searchParams.delete('c');
    }
    window.history.replaceState({}, '', url);
  }, [currentConversationId]);

  // Handle browser back/forward
  useEffect(() => {
    const handlePopState = () => {
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
    if (currentConversationId) {
      loadConversation(currentConversationId);
    }
  }, [currentConversationId]);

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

  const handleNewConversation = () => {
    currentIdRef.current = null;
    setIsLoading(false);
    // Don't create on backend yet - wait for first message
    const url = new URL(window.location);
    url.searchParams.delete('c');
    window.history.pushState({}, '', url);
    setCurrentConversationId(null);
    setCurrentConversation({ id: null, messages: [], title: 'New Conversation' });
  };

  const handleSelectConversation = (id) => {
    currentIdRef.current = id;
    setIsLoading(activeRunsRef.current.has(id));
    const url = new URL(window.location);
    if (id) {
      url.searchParams.set('c', id);
    } else {
      url.searchParams.delete('c');
    }
    window.history.pushState({}, '', url);
    setCurrentConversationId(id);
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
        updateIfCurrentConv((prev) => {
          const messages = [...prev.messages];
          const idx = getTargetMsgIndex(prev);
          messages[idx] = { 
            ...messages[idx], 
            loading: { ...messages[idx].loading, stage1: true }, 
            stage1Progress: null,
            stage1_failures: [],
            stage2: null,
            stage3: null,
            metadata: null,
            error: null 
          };
          return { ...prev, messages };
        });
        break;

      case 'stage1_init':
        updateIfCurrentConv((prev) => {
          const messages = [...prev.messages];
          const idx = getTargetMsgIndex(prev);
          messages[idx] = {
            ...messages[idx],
            stage1Progress: { 
              total: event.data.total_models, 
              completed: event.data.existing_count || 0, 
              results: [],
            }
          };
          return { ...prev, messages };
        });
        break;

      case 'stage1_model_complete':
        updateIfCurrentConv((prev) => {
          const messages = [...prev.messages];
          const idx = getTargetMsgIndex(prev);
          const progress = messages[idx].stage1Progress;
          if (progress) {
            // Only increment completed for NEW results, not existing ones being replayed
            const isExisting = event.data.existing;
            messages[idx] = {
              ...messages[idx],
              stage1Progress: {
                ...progress,
                completed: isExisting ? progress.completed : progress.completed + 1,
                results: [...progress.results, event.data.result]
              }
            };
          }
          return { ...prev, messages };
        });
        break;

      case 'stage1_model_failed':
        updateIfCurrentConv((prev) => {
          const messages = [...prev.messages];
          const idx = getTargetMsgIndex(prev);
          const progress = messages[idx].stage1Progress;
          const isExisting = event.data.existing;
          messages[idx] = {
            ...messages[idx],
            stage1_failures: [...(messages[idx].stage1_failures || []), event.data],
            ...(progress && {
              stage1Progress: {
                ...progress,
                completed: isExisting ? progress.completed : progress.completed + 1,
              },
            }),
          };
          return { ...prev, messages };
        });
        break;

      case 'stage1_complete':
        updateIfCurrentConv((prev) => {
          const messages = [...prev.messages];
          const idx = getTargetMsgIndex(prev);
          messages[idx] = { 
            ...messages[idx], 
            stage1: event.data,
            stage1_failures: event.failures || messages[idx].stage1_failures || [],
            stage1Progress: null,
            loading: { ...messages[idx].loading, stage1: false } 
          };
          return { ...prev, messages };
        });
        break;

      case 'stage1_error':
        updateIfCurrentConv((prev) => {
          const messages = [...prev.messages];
          const idx = getTargetMsgIndex(prev);
          const progressResults = messages[idx].stage1Progress?.results;
          messages[idx] = { 
            ...messages[idx],
            stage1: progressResults ?? messages[idx].stage1 ?? [],
            stage1_failures: event.failures || messages[idx].stage1_failures || [],
            loading: { ...messages[idx].loading, stage1: false }, 
            stage1Progress: null,
            error: { stage: 1, message: event.message } 
          };
          return { ...prev, messages };
        });
        finishRun(runConvId);
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
          const nextFailures = eventType === 'stage2_model_failed'
            ? [...(messages[idx].stage2_failures || []), event.data]
            : messages[idx].stage2_failures;
          if (progress) {
            messages[idx] = {
              ...messages[idx],
              stage2_failures: nextFailures,
              stage2Progress: {
                ...progress,
                completed: progress.completed + 1
              }
            };
          } else if (eventType === 'stage2_model_failed') {
            messages[idx] = { ...messages[idx], stage2_failures: nextFailures };
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
            stage2_failures: event.failures || messages[idx].stage2_failures || [],
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
            stage2_failures: event.failures ?? messages[idx].stage2_failures ?? [],
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

  const handleSendMessage = async (
    content,
    images = [],
    files = [],
  ) => {
    if (!currentConversation) return;

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

    activeRunsRef.current.add(convId);
    setIsLoading(true);
    try {
      setCurrentConversation((prev) => {
        if (!prev || prev.id !== convId) return prev;
        const messages = [...prev.messages];
        const msg = messages[messageIndex];
        messages[messageIndex] = {
          ...msg,
          error: null,
          streaming: false,
          stage1_failures: stage === 1 ? [] : msg.stage1_failures,
          stage2_failures: stage === 3 ? msg.stage2_failures : [],
          loading: {
            stage1: stage === 1,
            stage2: stage === 2,
            redteam: stage === 3,
            stage3: false,
          },
        };
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

  return (
    <div className="app">
      <Sidebar
        conversations={conversations}
        currentConversationId={currentConversationId}
        onSelectConversation={handleSelectConversation}
        onNewConversation={handleNewConversation}
        onRemoveConversation={handleRemoveConversation}
        onOpenSettings={() => setIsSettingsOpen(true)}
        darkMode={darkMode}
        onToggleDarkMode={() => setDarkMode(!darkMode)}
        engineMode={engineMode}
      />
      <ChatInterface
        key={currentConversationId ?? 'new'}
        conversation={currentConversation}
        onSendMessage={handleSendMessage}
        onRetryStage={handleRetryStage}
        isLoading={isLoading}
        settingsVersion={settingsVersion}
      />
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
