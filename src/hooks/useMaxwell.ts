import { useState, useCallback, useEffect, useRef } from 'react';
import { apiService } from '@/lib/apiService';
import { useWebSocket } from './useWebSocket';

export interface MaxwellMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
  trace?: any[]; // Bedrock Agent trace events
  rawReply?: string; // Original reply before stripping tags
}

export interface MaxwellSessionAttributes {
  entityId: string;
  entityType: 'tool' | 'part' | 'action';
  entityName: string;
  policy: string;
  implementation: string;
}

interface MaxwellChatResponse {
  reply: string;
  sessionId: string;
  trace?: any[];
}

export type MaxwellMode = 'quick' | 'deep';

export interface UseMaxwellReturn {
  messages: MaxwellMessage[];
  isLoading: boolean;
  progressStep: string | null;
  error: string | null;
  sessionId: string | null;
  sendMessage: (text: string, mode?: MaxwellMode) => Promise<void>;
  resetSession: () => void;
}

/**
 * Strip referenced_records XML tags from Maxwell replies.
 */
function stripReferencedRecords(reply: string): string {
  return reply.replace(/<referenced_records>.*?<\/referenced_records>/s, '').trim();
}

export function useMaxwell(sessionAttributes: MaxwellSessionAttributes): UseMaxwellReturn {
  const [messages, setMessages] = useState<MaxwellMessage[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [progressStep, setProgressStep] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);

  const { status, sendMessage: wsSendMessage, subscribe } = useWebSocket();

  // Track accumulated chunks for the current streaming response
  const accumulatedChunksRef = useRef<string>('');
  // Track whether we're currently streaming via WebSocket
  const isStreamingRef = useRef(false);
  // Track last user question and mode for save-on-complete
  const lastQuestionRef = useRef<string>('');
  const lastModeRef = useRef<MaxwellMode>('deep');
  const lastStartTimeRef = useRef<number>(0);

  const resetSession = useCallback(() => {
    setMessages([]);
    setSessionId(null);
    setError(null);
    setIsLoading(false);
    setProgressStep(null);
    accumulatedChunksRef.current = '';
    isStreamingRef.current = false;
  }, []);

  // Reset session when entity changes (session isolation)
  useEffect(() => {
    resetSession();
  }, [sessionAttributes.entityId, resetSession]);

  // Abort streaming if WebSocket connection drops
  useEffect(() => {
    if (isStreamingRef.current && (status === 'disconnected' || status === 'reconnecting')) {
      setError('Connection lost while waiting for response. Please try again.');
      setIsLoading(false);
      setProgressStep(null);
      isStreamingRef.current = false;
      accumulatedChunksRef.current = '';
    }
  }, [status]);

  // Subscribe to WebSocket maxwell events
  useEffect(() => {
    const unsubChunk = subscribe('maxwell:response_chunk', (payload: any) => {
      if (!isStreamingRef.current) return;

      // Clear progress step once actual content starts arriving
      setProgressStep(null);

      const chunk = payload?.chunk ?? '';
      accumulatedChunksRef.current += chunk;

      // Update the last assistant message in-place with accumulated text
      const currentText = stripReferencedRecords(accumulatedChunksRef.current);
      setMessages(prev => {
        const last = prev[prev.length - 1];
        if (last && last.role === 'assistant') {
          // Update existing streaming assistant message
          const updated = [...prev];
          updated[updated.length - 1] = {
            ...last,
            content: currentText,
          };
          return updated;
        }
        // First chunk — create the assistant message placeholder
        return [
          ...prev,
          {
            role: 'assistant' as const,
            content: currentText,
            timestamp: new Date(),
          },
        ];
      });
    });

    const unsubComplete = subscribe('maxwell:response_complete', (payload: any) => {
      if (!isStreamingRef.current) return;

      const reply = payload?.reply ?? accumulatedChunksRef.current;
      const newSessionId = payload?.sessionId ?? null;
      const trace = payload?.trace ?? [];

      if (newSessionId) {
        setSessionId(newSessionId);
      }

      // Finalize the assistant message with the complete reply
      const finalContent = stripReferencedRecords(reply);
      setMessages(prev => {
        const last = prev[prev.length - 1];
        if (last && last.role === 'assistant') {
          const updated = [...prev];
          updated[updated.length - 1] = {
            ...last,
            content: finalContent,
            trace,
            rawReply: reply,
          };
          return updated;
        }
        // Edge case: complete arrived without any chunks
        return [
          ...prev,
          {
            role: 'assistant' as const,
            content: finalContent,
            timestamp: new Date(),
            trace,
            rawReply: reply,
          },
        ];
      });

      accumulatedChunksRef.current = '';
      isStreamingRef.current = false;
      setProgressStep(null);
      setIsLoading(false);

      // Fire-and-forget: save interaction to backend
      const durationMs = lastStartTimeRef.current ? Date.now() - lastStartTimeRef.current : null;
      apiService.post('/maxwell/interactions', {
        question: lastQuestionRef.current,
        response: reply,
        model: lastModeRef.current,
        input_tokens: null,
        output_tokens: null,
        duration_ms: durationMs,
        entity_type: sessionAttributes.entityType || null,
        entity_id: sessionAttributes.entityId || null,
      }).catch(() => {}); // Silent failure
    });

    const unsubProgress = subscribe('maxwell:progress', (payload: any) => {
      if (!isStreamingRef.current) return;
      const step = payload?.step ?? 'Processing...';
      setProgressStep(step);
    });

    const unsubError = subscribe('maxwell:error', (payload: any) => {
      if (!isStreamingRef.current) return;

      const errorMessage = payload?.message ?? 'Maxwell failed to respond. Please try again.';
      setError(errorMessage);
      accumulatedChunksRef.current = '';
      isStreamingRef.current = false;
      setProgressStep(null);
      setIsLoading(false);
    });

    return () => {
      unsubChunk();
      unsubComplete();
      unsubProgress();
      unsubError();
    };
  }, [subscribe]);

  const sendMessage = useCallback(async (text: string, mode: MaxwellMode = 'deep') => {
    if (!text.trim() || isLoading) return;

    // Prepend mode instruction so the agent adjusts its behavior
    const modePrefix = mode === 'quick'
      ? '[Mode: Quick — use 1 tool call maximum. Answer concisely in under 200 words. Skip detailed sourcing.]\n\n'
      : '';
    const enhancedText = modePrefix + text;

    const history = messages.map(msg => ({
      role: msg.role,
      content: msg.content,
    }));

    const userMsg: MaxwellMessage = {
      role: 'user',
      content: text,
      timestamp: new Date(),
    };

    setMessages(prev => [...prev, userMsg]);
    setIsLoading(true);
    setError(null);

    if (status === 'connected') {
      // --- WebSocket path: send via WS and stream response ---
      accumulatedChunksRef.current = '';
      isStreamingRef.current = true;
      lastQuestionRef.current = text;
      lastModeRef.current = mode;
      lastStartTimeRef.current = Date.now();

      wsSendMessage('maxwell:chat', {
        message: enhancedText,
        sessionId: sessionId ?? undefined,
        mode,
        history,
        sessionAttributes: {
          entityId: sessionAttributes.entityId,
          entityType: sessionAttributes.entityType,
          entityName: sessionAttributes.entityName,
          policy: sessionAttributes.policy,
          implementation: sessionAttributes.implementation,
        },
      });
      // isLoading will be set to false by the response_complete or error handler
    } else {
      // --- Explicit validation instead of silent fallback ---
      if (mode === 'deep') {
        const errorMsg = `Deep mode requires an active WebSocket connection to stream real-time results. Connection status: ${status}`;
        console.error('[MAXWELL] ' + errorMsg);
        setError(errorMsg);
        setIsLoading(false);
        return;
      }

      // Quick queries (Haiku) take <2 seconds and are safe to run over REST
      try {
        const response = await apiService.post<MaxwellChatResponse>('/agent/maxwell-chat', {
          message: enhancedText,
          sessionId,
          mode,
          history,
          sessionAttributes,
        });

        setSessionId(response.sessionId);

        const assistantMsg: MaxwellMessage = {
          role: 'assistant',
          content: stripReferencedRecords(response.reply),
          timestamp: new Date(),
          trace: response.trace,
          rawReply: response.reply,
        };

        setMessages(prev => [...prev, assistantMsg]);

        // Fire-and-forget: save interaction to backend
        apiService.post('/maxwell/interactions', {
          question: text,
          response: response.reply,
          model: mode,
          input_tokens: null,
          output_tokens: null,
          duration_ms: null,
          entity_type: sessionAttributes.entityType || null,
          entity_id: sessionAttributes.entityId || null,
        }).catch(() => {}); // Silent failure
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Maxwell failed to respond. Please try again.';
        setError(message);
      } finally {
        setIsLoading(false);
      }
    }
  }, [isLoading, messages, sessionId, sessionAttributes, status, wsSendMessage]);

  return { messages, isLoading, progressStep, error, sessionId, sendMessage, resetSession };
}
