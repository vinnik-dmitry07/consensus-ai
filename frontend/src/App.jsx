import { useState, useEffect } from 'react';
import Sidebar from './components/Sidebar';
import ChatInterface from './components/ChatInterface';
import { api } from './api';
import './App.css';

function App() {
  const [conversations, setConversations] = useState([]);
  const [currentConversationId, setCurrentConversationId] = useState(null);
  const [currentConversation, setCurrentConversation] = useState(null);
  const [isLoading, setIsLoading] = useState(false);

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
    try {
      const conv = await api.getConversation(id);
      setCurrentConversation(conv);
    } catch (error) {
      console.error('Failed to load conversation:', error);
    }
  };

  const handleNewConversation = async () => {
    try {
      const newConv = await api.createConversation();
      setConversations([
        { id: newConv.id, created_at: newConv.created_at, message_count: 0 },
        ...conversations,
      ]);
      setCurrentConversationId(newConv.id);
    } catch (error) {
      console.error('Failed to create conversation:', error);
    }
  };

  const handleSelectConversation = (id) => {
    setCurrentConversationId(id);
  };

  // Handle streaming events for both new messages and retries
  const handleStreamEvent = (eventType, event, messageIndex = null) => {
    // Helper to get the message to update
    const getTargetMsgIndex = (prev) => {
      return messageIndex !== null ? messageIndex : prev.messages.length - 1;
    };

    switch (eventType) {
      case 'stage1_start':
        setCurrentConversation((prev) => {
          const messages = [...prev.messages];
          const idx = getTargetMsgIndex(prev);
          messages[idx] = { ...messages[idx], loading: { ...messages[idx].loading, stage1: true }, error: null };
          return { ...prev, messages };
        });
        break;

      case 'stage1_complete':
        setCurrentConversation((prev) => {
          const messages = [...prev.messages];
          const idx = getTargetMsgIndex(prev);
          messages[idx] = { ...messages[idx], stage1: event.data, loading: { ...messages[idx].loading, stage1: false } };
          return { ...prev, messages };
        });
        break;

      case 'stage1_error':
        setCurrentConversation((prev) => {
          const messages = [...prev.messages];
          const idx = getTargetMsgIndex(prev);
          messages[idx] = { ...messages[idx], loading: { ...messages[idx].loading, stage1: false }, error: { stage: 1, message: event.message } };
          return { ...prev, messages };
        });
        setIsLoading(false);
        break;

      case 'stage2_start':
        setCurrentConversation((prev) => {
          const messages = [...prev.messages];
          const idx = getTargetMsgIndex(prev);
          messages[idx] = { ...messages[idx], loading: { ...messages[idx].loading, stage2: true } };
          return { ...prev, messages };
        });
        break;

      case 'stage2_complete':
        setCurrentConversation((prev) => {
          const messages = [...prev.messages];
          const idx = getTargetMsgIndex(prev);
          messages[idx] = { ...messages[idx], stage2: event.data, metadata: event.metadata, loading: { ...messages[idx].loading, stage2: false } };
          return { ...prev, messages };
        });
        break;

      case 'stage2_error':
        setCurrentConversation((prev) => {
          const messages = [...prev.messages];
          const idx = getTargetMsgIndex(prev);
          messages[idx] = { ...messages[idx], loading: { ...messages[idx].loading, stage2: false }, error: { stage: 2, message: event.message } };
          return { ...prev, messages };
        });
        setIsLoading(false);
        break;

      case 'stage3_start':
        setCurrentConversation((prev) => {
          const messages = [...prev.messages];
          const idx = getTargetMsgIndex(prev);
          messages[idx] = { ...messages[idx], loading: { ...messages[idx].loading, stage3: true } };
          return { ...prev, messages };
        });
        break;

      case 'stage3_complete':
        setCurrentConversation((prev) => {
          const messages = [...prev.messages];
          const idx = getTargetMsgIndex(prev);
          messages[idx] = { ...messages[idx], stage3: event.data, loading: { ...messages[idx].loading, stage3: false } };
          return { ...prev, messages };
        });
        break;

      case 'stage3_error':
        setCurrentConversation((prev) => {
          const messages = [...prev.messages];
          const idx = getTargetMsgIndex(prev);
          messages[idx] = { ...messages[idx], loading: { ...messages[idx].loading, stage3: false }, error: { stage: 3, message: event.message } };
          return { ...prev, messages };
        });
        setIsLoading(false);
        break;

      case 'title_complete':
        loadConversations();
        break;

      case 'complete':
        // Clear any error state on success
        setCurrentConversation((prev) => {
          const messages = [...prev.messages];
          const idx = getTargetMsgIndex(prev);
          if (messages[idx]) {
            messages[idx] = { ...messages[idx], error: null };
          }
          return { ...prev, messages };
        });
        loadConversations();
        setIsLoading(false);
        break;

      case 'error':
        console.error('Stream error:', event.message);
        setIsLoading(false);
        break;

      default:
        console.log('Unknown event type:', eventType);
    }
  };

  const handleSendMessage = async (content, images = []) => {
    if (!currentConversationId) return;

    setIsLoading(true);
    try {
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
          stage1: false,
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
      await api.sendMessageStream(currentConversationId, content, images, (eventType, event) => {
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
    }
  };

  const handleRetryStage = async (messageIndex, stage) => {
    if (!currentConversationId) return;

    setIsLoading(true);
    try {
      // Clear the error and set loading state for the retry
      setCurrentConversation((prev) => {
        const messages = [...prev.messages];
        const msg = messages[messageIndex];
        messages[messageIndex] = {
          ...msg,
          error: null,
          loading: {
            stage1: stage === 1,
            stage2: stage === 2,
            stage3: stage === 3,
          },
        };
        return { ...prev, messages };
      });

      // Retry the stage
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
    }
  };

  return (
    <div className="app">
      <Sidebar
        conversations={conversations}
        currentConversationId={currentConversationId}
        onSelectConversation={handleSelectConversation}
        onNewConversation={handleNewConversation}
      />
      <ChatInterface
        conversation={currentConversation}
        onSendMessage={handleSendMessage}
        onRetryStage={handleRetryStage}
        isLoading={isLoading}
      />
    </div>
  );
}

export default App;
