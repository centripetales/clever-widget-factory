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

const MAXWELL_WS_RESPONSE_TIMEOUT_MS = 35_000;

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
  const responseTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearResponseTimeout = useCallback(() => {
    if (responseTimeoutRef.current) {
      clearTimeout(responseTimeoutRef.current);
      responseTimeoutRef.current = null;
    }
  }, []);

  const stopStreaming = useCallback(() => {
    clearResponseTimeout();
    accumulatedChunksRef.current = '';
    isStreamingRef.current = false;
    setProgressStep(null);
    setIsLoading(false);
  }, [clearResponseTimeout]);

  const resetSession = useCallback(() => {
    setMessages([]);
    setSessionId(null);
    setError(null);
    stopStreaming();
  }, [stopStreaming]);

  // Reset session when entity changes (session isolation)
  useEffect(() => {
    resetSession();
  }, [sessionAttributes.entityId, resetSession]);

  useEffect(() => {
    if (!isStreamingRef.current) return;
    if (status !== 'disconnected' && status !== 'reconnecting') return;

    setError('Maxwell lost its connection before the response finished. Please try again.');
    stopStreaming();
  }, [status, stopStreaming]);

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
      stopStreaming();
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
      stopStreaming();
    });

    return () => {
      unsubChunk();
      unsubComplete();
      unsubProgress();
      unsubError();
    };
  }, [subscribe, stopStreaming]);

  const sendMessage = useCallback(async (text: string, mode: MaxwellMode = 'quick') => {
    if (!text.trim() || isLoading) return;

    // Prepend mode instruction so the agent adjusts its behavior
    const modePrefix = mode === 'quick'
      ? '[Mode: Quick — answer directly from the provided context and general knowledge. Do not call tools unless the user explicitly asks you to search organizational records. Use 0 tool calls by default, 1 maximum if truly necessary. Answer concisely in under 200 words. Skip detailed sourcing.]\n\n'
      : '';
    const enhancedText = modePrefix + text;

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
      clearResponseTimeout();

      const sent = wsSendMessage('maxwell:chat', {
        message: enhancedText,
        sessionId: sessionId ?? undefined,
        sessionAttributes: {
          entityId: sessionAttributes.entityId,
          entityType: sessionAttributes.entityType,
          entityName: sessionAttributes.entityName,
          policy: sessionAttributes.policy,
          implementation: sessionAttributes.implementation,
        },
      });

      if (!sent) {
        setError('Maxwell connection was not ready. Please try again.');
        stopStreaming();
        return;
      }

      responseTimeoutRef.current = setTimeout(() => {
        if (!isStreamingRef.current) return;
        setError('Maxwell did not finish responding. Please try again.');
        stopStreaming();
      }, MAXWELL_WS_RESPONSE_TIMEOUT_MS);
      // isLoading will be set to false by the response_complete or error handler
    } else {
      // --- REST fallback path ---
      try {
        const response = await apiService.post<MaxwellChatResponse>('/agent/maxwell-chat', {
          message: enhancedText,
          sessionId,
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
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Maxwell failed to respond. Please try again.';
        setError(message);
      } finally {
        setIsLoading(false);
      }
    }
  }, [clearResponseTimeout, isLoading, sessionId, sessionAttributes, status, stopStreaming, wsSendMessage]);

  return { messages, isLoading, progressStep, error, sessionId, sendMessage, resetSession };
}
