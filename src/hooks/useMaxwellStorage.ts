import { useCallback } from 'react';
import type { MaxwellMessage } from './useMaxwell';

export interface EntityContext {
  entityId: string;
  entityType: 'action' | 'tool' | 'part' | 'observation';
  entityName: string;
  policy: string;
  implementation: string;
}

interface ConversationData {
  entityId: string;
  entityType: string;
  messages: MaxwellMessage[];
  lastAccessed: number;
}

interface SerializedMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: string; // ISO string for serialization
  trace?: any[];
}

interface SerializedConversation {
  entityId: string;
  entityType: string;
  messages: SerializedMessage[];
  lastAccessed: number;
}

const MAX_CONVERSATIONS = 5;
const LRU_KEY = 'maxwell_lru_order';

/**
 * Hook for managing Maxwell conversation persistence in localStorage with LRU eviction.
 * 
 * Features:
 * - Stores up to 5 conversations
 * - LRU eviction when limit exceeded
 * - Graceful error handling for localStorage issues
 * - Automatic timestamp tracking
 */
export function useMaxwellStorage() {
  /**
   * Generate storage key for a given entity context
   */
  const getStorageKey = useCallback((context: EntityContext): string => {
    return `maxwell_${context.entityType}_${context.entityId}`;
  }, []);

  /**
   * Get current LRU order from localStorage
   */
  const getLRUOrder = useCallback((): string[] => {
    try {
      const stored = localStorage.getItem(LRU_KEY);
      return stored ? JSON.parse(stored) : [];
    } catch (error) {
      console.warn('Failed to read LRU order:', error);
      return [];
    }
  }, []);

  /**
   * Update LRU order, moving the given key to the front
   */
  const updateLRUOrder = useCallback((key: string): void => {
    try {
      let order = getLRUOrder();
      
      // Remove key if it exists
      order = order.filter(k => k !== key);
      
      // Add key to front (most recently used)
      order.unshift(key);
      
      // Keep only MAX_CONVERSATIONS entries
      if (order.length > MAX_CONVERSATIONS) {
        // Evict oldest conversations
        const toEvict = order.slice(MAX_CONVERSATIONS);
        toEvict.forEach(oldKey => {
          try {
            localStorage.removeItem(oldKey);
          } catch (error) {
            console.warn(`Failed to evict conversation ${oldKey}:`, error);
          }
        });
        order = order.slice(0, MAX_CONVERSATIONS);
      }
      
      localStorage.setItem(LRU_KEY, JSON.stringify(order));
    } catch (error) {
      console.warn('Failed to update LRU order:', error);
    }
  }, [getLRUOrder]);

  /**
   * Serialize messages for storage (convert Date to ISO string)
   */
  const serializeMessages = useCallback((messages: MaxwellMessage[]): SerializedMessage[] => {
    return messages.map(msg => ({
      ...msg,
      timestamp: msg.timestamp.toISOString(),
    }));
  }, []);

  /**
   * Deserialize messages from storage (convert ISO string to Date)
   */
  const deserializeMessages = useCallback((messages: SerializedMessage[]): MaxwellMessage[] => {
    return messages.map(msg => ({
      ...msg,
      timestamp: new Date(msg.timestamp),
    }));
  }, []);

  /**
   * Save conversation to localStorage
   */
  const saveConversation = useCallback((
    context: EntityContext,
    messages: MaxwellMessage[]
  ): void => {
    const key = getStorageKey(context);
    
    try {
      const data: SerializedConversation = {
        entityId: context.entityId,
        entityType: context.entityType,
        messages: serializeMessages(messages),
        lastAccessed: Date.now(),
      };
      
      localStorage.setItem(key, JSON.stringify(data));
      updateLRUOrder(key);
    } catch (error) {
      // Handle QuotaExceededError and other localStorage errors
      if (error instanceof Error) {
        if (error.name === 'QuotaExceededError') {
          console.warn('localStorage quota exceeded. Conversation not saved.');
        } else if (error.name === 'SecurityError') {
          console.warn('localStorage access denied (private browsing?). Conversation not saved.');
        } else {
          console.warn('Failed to save conversation:', error);
        }
      }
    }
  }, [getStorageKey, serializeMessages, updateLRUOrder]);

  /**
   * Load conversation from localStorage
   */
  const loadConversation = useCallback((
    context: EntityContext
  ): MaxwellMessage[] | null => {
    const key = getStorageKey(context);
    
    try {
      const stored = localStorage.getItem(key);
      if (!stored) return null;
      
      const data: SerializedConversation = JSON.parse(stored);
      
      // Update last accessed timestamp and LRU order
      data.lastAccessed = Date.now();
      localStorage.setItem(key, JSON.stringify(data));
      updateLRUOrder(key);
      
      return deserializeMessages(data.messages);
    } catch (error) {
      console.warn('Failed to load conversation:', error);
      return null;
    }
  }, [getStorageKey, deserializeMessages, updateLRUOrder]);

  /**
   * Clear conversation from localStorage
   */
  const clearConversation = useCallback((context: EntityContext): void => {
    const key = getStorageKey(context);
    
    try {
      localStorage.removeItem(key);
      
      // Remove from LRU order
      const order = getLRUOrder();
      const newOrder = order.filter(k => k !== key);
      localStorage.setItem(LRU_KEY, JSON.stringify(newOrder));
    } catch (error) {
      console.warn('Failed to clear conversation:', error);
    }
  }, [getStorageKey, getLRUOrder]);

  return {
    saveConversation,
    loadConversation,
    clearConversation,
    getStorageKey,
  };
}
