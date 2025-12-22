import { useState, useEffect, useRef } from 'react';
import Sidebar from './components/Sidebar';
import ChatInterface from './components/ChatInterface';
import Settings from './components/Settings';
import { api } from './api';
import './App.css';

function App() {
  const [conversations, setConversations] = useState([]);
  const [currentConversationId, setCurrentConversationId] = useState(() => {
    const params = new URLSearchParams(window.location.search);
    return params.get('c');
  });
  const [currentConversation, setCurrentConversation] = useState(null);
  const [isLoading, setIsLoading] = useState(false);
  const streamingConvIdRef = useRef(null);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [settingsVersion, setSettingsVersion] = useState(0);
  const [darkMode, setDarkMode] = useState(() => localStorage.getItem('theme') === 'dark');

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', darkMode ? 'dark' : 'light');
    localStorage.setItem('theme', darkMode ? 'dark' : 'light');
  }, [darkMode]);

  // Sync URL with conversation ID
  useEffect(() => {
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

  const loadConversation = async (id) => {
    // Don't reload if we're currently streaming to this conversation
    if (streamingConvIdRef.current === id) return;
    
    try {
      const conv = await api.getConversation(id);
      setCurrentConversation(conv);
    } catch (error) {
      console.error('Failed to load conversation:', error);
    }
  };

  const handleNewConversation = () => {
    // Reset loading if switching away from streaming conversation
    if (streamingConvIdRef.current) {
      setIsLoading(false);
    }
    // Don't create on backend yet - wait for first message
    const url = new URL(window.location);
    url.searchParams.delete('c');
    window.history.pushState({}, '', url);
    setCurrentConversationId(null);
    setCurrentConversation({ id: null, messages: [], title: 'New Conversation' });
  };

  const handleSelectConversation = (id) => {
    // Reset loading if switching away from streaming conversation
    if (streamingConvIdRef.current && id !== streamingConvIdRef.current) {
      setIsLoading(false);
    }
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
  const handleStreamEvent = (eventType, event, messageIndex = null) => {
    // Helper to get the message to update
    const getTargetMsgIndex = (prev) => {
      return messageIndex !== null ? messageIndex : prev.messages.length - 1;
    };

    // Helper to only update if we're on the streaming conversation
    const updateIfCurrentConv = (updater) => {
      setCurrentConversation((prev) => {
        if (!prev || prev.id !== streamingConvIdRef.current) return prev;
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
              results: [] 
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

      case 'stage1_complete':
        updateIfCurrentConv((prev) => {
          const messages = [...prev.messages];
          const idx = getTargetMsgIndex(prev);
          messages[idx] = { 
            ...messages[idx], 
            stage1: event.data, 
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
          messages[idx] = { 
            ...messages[idx], 
            loading: { ...messages[idx].loading, stage1: false }, 
            stage1Progress: null,
            error: { stage: 1, message: event.message } 
          };
          return { ...prev, messages };
        });
        setIsLoading(false);
        streamingConvIdRef.current = null;
        break;

      case 'stage2_start':
        updateIfCurrentConv((prev) => {
          const messages = [...prev.messages];
          const idx = getTargetMsgIndex(prev);
          messages[idx] = { 
            ...messages[idx], 
            loading: { ...messages[idx].loading, stage2: true },
            stage2Progress: null
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
        updateIfCurrentConv((prev) => {
          const messages = [...prev.messages];
          const idx = getTargetMsgIndex(prev);
          const progress = messages[idx].stage2Progress;
          if (progress) {
            messages[idx] = {
              ...messages[idx],
              stage2Progress: {
                ...progress,
                completed: progress.completed + 1
              }
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
            metadata: event.metadata, 
            loading: { ...messages[idx].loading, stage2: false },
            stage2Progress: null
          };
          return { ...prev, messages };
        });
        break;

      case 'stage2_error':
        updateIfCurrentConv((prev) => {
          const messages = [...prev.messages];
          const idx = getTargetMsgIndex(prev);
          messages[idx] = { ...messages[idx], loading: { ...messages[idx].loading, stage2: false }, error: { stage: 2, message: event.message } };
          return { ...prev, messages };
        });
        setIsLoading(false);
        streamingConvIdRef.current = null;
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
        setIsLoading(false);
        streamingConvIdRef.current = null;
        break;

      case 'title_complete':
        loadConversations();
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
        setIsLoading(false);
        streamingConvIdRef.current = null;
        break;

      case 'error':
        console.error('Stream error:', event.message);
        setIsLoading(false);
        streamingConvIdRef.current = null;
        break;

      default:
        console.log('Unknown event type:', eventType);
    }
  };

  const handleSendMessage = async (content, images = []) => {
    if (!currentConversation) return;

    setIsLoading(true);
    try {
      // Create conversation on backend if this is a new conversation
      let convId = currentConversationId;
      if (!convId) {
        const newConv = await api.createConversation();
        convId = newConv.id;
        // Set streaming ref BEFORE setCurrentConversationId to prevent useEffect from reloading
        streamingConvIdRef.current = convId;
        setCurrentConversationId(convId);
        setConversations((prev) => [
          { id: newConv.id, created_at: newConv.created_at, title: 'New Conversation', message_count: 0 },
          ...prev,
        ]);
        setCurrentConversation((prev) => ({ ...prev, id: convId }));
      }

      // Optimistically add user message to UI
      const userMessage = { role: 'user', content, images: images.length > 0 ? images : undefined };
      setCurrentConversation((prev) => ({
        ...prev,
        messages: [...prev.messages, userMessage],
      }));

      // Create a partial assistant message that will be updated progressively
      const assistantMessage = {
        role: 'assistant',
        stage1: null,
        stage2: null,
        stage3: null,
        metadata: null,
        error: null,
        loading: {
          stage1: true,  // Start with stage1 loading
          stage2: false,
          stage3: false,
        },
      };

      // Add the partial assistant message
      setCurrentConversation((prev) => ({
        ...prev,
        messages: [...prev.messages, assistantMessage],
      }));

      // Send message with streaming
      streamingConvIdRef.current = convId;
      await api.sendMessageStream(convId, content, images, (eventType, event) => {
        handleStreamEvent(eventType, event);
      });
    } catch (error) {
      console.error('Failed to send message:', error);
      // Remove optimistic messages on error
      setCurrentConversation((prev) => ({
        ...prev,
        messages: prev.messages.slice(0, -2),
      }));
      setIsLoading(false);
      streamingConvIdRef.current = null;
    }
  };

  const handleRetryStage = async (messageIndex, stage) => {
    if (!currentConversationId) return;

    setIsLoading(true);
    try {
      // Clear the error/streaming and set loading state for the retry
      setCurrentConversation((prev) => {
        const messages = [...prev.messages];
        const msg = messages[messageIndex];
        messages[messageIndex] = {
          ...msg,
          error: null,
          streaming: false,
          loading: {
            stage1: stage === 1,
            stage2: stage === 2,
            stage3: stage === 3,
          },
        };
        return { ...prev, messages };
      });

      // Retry the stage
      streamingConvIdRef.current = currentConversationId;
      await api.retryStage(currentConversationId, stage, messageIndex, (eventType, event) => {
        handleStreamEvent(eventType, event, messageIndex);
      });
    } catch (error) {
      console.error(`Failed to retry stage ${stage}:`, error);
      setCurrentConversation((prev) => {
        const messages = [...prev.messages];
        messages[messageIndex] = {
          ...messages[messageIndex],
          loading: { stage1: false, stage2: false, stage3: false },
          error: { stage, message: error.message },
        };
        return { ...prev, messages };
      });
      setIsLoading(false);
      streamingConvIdRef.current = null;
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
      />
      <ChatInterface
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
      />
    </div>
  );
}

export default App;
