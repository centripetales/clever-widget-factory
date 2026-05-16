import { useRef, useEffect, useState, KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { X, Send, RefreshCw, Loader2, Copy, Check, Code, ArrowRight, Maximize2, Minimize2, Zap, BookOpen, Info } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import { cn } from '@/lib/utils';
import { useMaxwell, MaxwellSessionAttributes, MaxwellMessage, MaxwellMode } from '@/hooks/useMaxwell';
import { useMaxwellStorage, EntityContext } from '@/hooks/useMaxwellStorage';
import { extractRecordIdsFromTrace } from '@/lib/traceParser';
import { useMaxwellRecordHighlight } from '@/contexts/MaxwellRecordHighlightContext';
import { useEntityContext } from '@/hooks/useEntityContext';
import { PrismIcon } from '@/components/icons/PrismIcon';
import { getImageUrl } from '@/lib/imageUtils';
import { copyConversationRich } from '@/lib/urlUtils';

const STARTER_QUESTIONS_ACTION = [
  'Summarize what has happened so far and given our policy and observations what are next steps',
  'Are we missing any information or materials to complete this action as defined in the policy.',
  'What might telos and entelechy look like for this action.',
  'Are there any high entropy policy steps we might resolve before starting this action',
];

const STARTER_QUESTIONS_ASSET = [
  'Describe the telos (ultimate purpose) of this asset',
  'Look at the history and describe the degree to which we\'ve achieved entelecheia (are we following the best practice).',
  'What are options on reducing entropy in this context in an energy efficient way.',
];

const STARTER_QUESTIONS_GENERAL = [
  'Where should I store a new item?',
  'What tools do we have for metalworking?',
  'Help me find something in inventory',
];

interface GlobalMaxwellPanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  context: EntityContext | null;
}

function MessageBubble({ message }: { message: MaxwellMessage }) {
  const isUser = message.role === 'user';
  const [copied, setCopied] = useState(false);
  const [copiedTrace, setCopiedTrace] = useState(false);
  const [showTrace, setShowTrace] = useState(false);
  
  const handleCopy = async () => {
    await navigator.clipboard.writeText(message.content);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  
  const handleCopyTrace = async () => {
    if (message.trace) {
      await navigator.clipboard.writeText(JSON.stringify(message.trace, null, 2));
      setCopiedTrace(true);
      setTimeout(() => setCopiedTrace(false), 2000);
    }
  };
  
  // Resolve S3 image URLs in markdown image syntax
  const resolveImageUrls = (text: string) => {
    return text.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_match, alt, url) => {
      const resolvedUrl = getImageUrl(url) || url;
      return `![${alt}](${resolvedUrl})`;
    });
  };

  return (
    <div className={cn('flex flex-col gap-1 group', isUser ? 'items-end' : 'items-start')}>
      <div
        className={cn(
          'max-w-[85%] rounded-2xl px-4 py-2 text-sm relative',
          isUser
            ? 'maxwell-message-user bg-primary text-primary-foreground rounded-br-sm'
            : 'maxwell-message-assistant bg-muted text-foreground rounded-bl-sm'
        )}
      >
        {isUser ? (
          <p className="whitespace-pre-wrap break-words">{message.content}</p>
        ) : (
          <div className="maxwell-markdown prose prose-sm dark:prose-invert max-w-none break-words [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
            <ReactMarkdown>{resolveImageUrls(message.content)}</ReactMarkdown>
          </div>
        )}
        <button
          onClick={handleCopy}
          className={cn(
            'absolute top-1 right-1 p-1 rounded opacity-0 group-hover:opacity-100 transition-opacity',
            isUser ? 'hover:bg-primary-foreground/20' : 'hover:bg-muted-foreground/10'
          )}
          aria-label="Copy message"
        >
          {copied ? (
            <Check className="h-3 w-3" />
          ) : (
            <Copy className="h-3 w-3" />
          )}
        </button>
      </div>
      
      {/* Trace section for assistant messages */}
      {!isUser && message.trace && message.trace.length > 0 && (
        <div className="max-w-[85%] mt-1 relative">
          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowTrace(!showTrace)}
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              <Code className="h-3 w-3" />
              {showTrace ? 'Hide' : 'Show'} trace ({message.trace.length} events)
            </button>
            {showTrace && (
              <button
                onClick={handleCopyTrace}
                className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
                aria-label="Copy trace"
              >
                {copiedTrace ? (
                  <Check className="h-3 w-3" />
                ) : (
                  <Copy className="h-3 w-3" />
                )}
                {copiedTrace ? 'Copied' : 'Copy'}
              </button>
            )}
          </div>
          {showTrace && (
            <div className="mt-2 mb-4 rounded-lg border bg-background p-3 text-xs font-mono overflow-x-auto max-h-64 overflow-y-auto shadow-lg">
              <pre className="whitespace-pre-wrap break-words">
                {JSON.stringify(message.trace, null, 2)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function GlobalMaxwellPanel({
  open,
  onOpenChange,
  context,
}: GlobalMaxwellPanelProps) {
  const currentPageContext = useEntityContext();
  const { saveConversation, loadConversation, clearConversation } = useMaxwellStorage();
  
  const [input, setInput] = useState('');
  const [copiedAll, setCopiedAll] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);
  const [maxwellMode, setMaxwellMode] = useState<MaxwellMode>('quick');
  const [activeContext, setActiveContext] = useState<EntityContext | null>(context);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  
  // Don't use focus trap - allow navigation while panel is open
  // useFocusTrap(panelRef, open);

  // Update active context when panel opens with new context
  useEffect(() => {
    if (open && context) {
      setActiveContext(context);
    }
  }, [open, context]);

  // Focus management: only auto-focus on non-touch devices.
  // On mobile, auto-focus immediately triggers the virtual keyboard before the
  // panel has settled, which pushes the input field off-screen.
  useEffect(() => {
    if (open) {
      const isTouchDevice = window.matchMedia('(hover: none) and (pointer: coarse)').matches;
      if (isTouchDevice) return;
      const timer = setTimeout(() => {
        inputRef.current?.focus();
      }, 100);
      return () => clearTimeout(timer);
    }
  }, [open]);

  // Keyboard support: Escape key closes panel (capture phase so it fires before Radix Dialog)
  useEffect(() => {
    const handleEscape = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape' && open) {
        e.stopPropagation();
        onOpenChange(false);
      }
    };
    
    // Block pointerdown events originating inside the panel from reaching Radix's
    // document-level outside-click listener (which runs in the capture phase)
    const blockOutsideClick = (e: PointerEvent) => {
      if (panelRef.current?.contains(e.target as Node)) {
        e.stopPropagation();
      }
    };
    
    if (open) {
      document.addEventListener('keydown', handleEscape, true); // capture phase
      document.addEventListener('pointerdown', blockOutsideClick, true); // capture phase
      return () => {
        document.removeEventListener('keydown', handleEscape, true);
        document.removeEventListener('pointerdown', blockOutsideClick, true);
      };
    }
  }, [open, onOpenChange]);

  // Build session attributes from active context
  const sessionAttributes: MaxwellSessionAttributes | null = activeContext
    ? {
        entityId: activeContext.entityId,
        entityType: activeContext.entityType,
        entityName: activeContext.entityName,
        policy: activeContext.policy,
        implementation: activeContext.implementation,
      }
    : null;

  const { messages, isLoading, progressStep, error, sendMessage, resetSession } = useMaxwell(
    sessionAttributes || {
      entityId: '',
      entityType: 'action',
      entityName: '',
      policy: '',
      implementation: '',
    }
  );

  const { setMaxwellRecordIds } = useMaxwellRecordHighlight();

  // Extract record IDs from assistant messages and update context
  useEffect(() => {
    const lastMessage = messages[messages.length - 1];
    if (lastMessage?.role === 'assistant' && lastMessage.trace?.length) {
      const ids = extractRecordIdsFromTrace(lastMessage.trace, lastMessage.rawReply);
      if (ids.length > 0) {
        setMaxwellRecordIds(ids);
      }
    }
  }, [messages]);

  // Load conversation from localStorage when context changes
  useEffect(() => {
    if (activeContext) {
      const stored = loadConversation(activeContext);
      if (stored && stored.length > 0) {
        // TODO: Restore messages to useMaxwell hook
        // This requires modifying useMaxwell to accept initial messages
        // For now, conversations are saved but not restored on mount
      }
    }
  }, [activeContext, loadConversation]);

  // Save conversation to localStorage whenever messages change
  useEffect(() => {
    if (activeContext && messages.length > 0) {
      saveConversation(activeContext, messages);
    }
  }, [activeContext, messages, saveConversation]);

  // Select starter questions based on entity type
  const starterQuestions = !activeContext
    ? STARTER_QUESTIONS_GENERAL
    : activeContext.entityType === 'action'
      ? STARTER_QUESTIONS_ACTION
      : STARTER_QUESTIONS_ASSET;

  const handleCopyAll = async () => {
    await copyConversationRich(messages);
    setCopiedAll(true);
    setTimeout(() => setCopiedAll(false), 2000);
  };

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    if (open) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages, isLoading, progressStep, open]);

  const handleSend = async () => {
    const text = input.trim();
    if (!text || isLoading) return;
    setInput('');
    // Reset textarea height after clearing
    if (inputRef.current) {
      inputRef.current.style.height = 'auto';
    }
    await sendMessage(text, maxwellMode);
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  // Auto-resize textarea as content grows
  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value);
    // Reset height to auto so it can shrink, then set to scrollHeight
    e.target.style.height = 'auto';
    e.target.style.height = `${Math.min(e.target.scrollHeight, 120)}px`;
  };

  const handleClearConversation = () => {
    if (activeContext) {
      clearConversation(activeContext);
    }
    resetSession();
  };

  const handleSwitchToCurrentPage = () => {
    if (currentPageContext) {
      setActiveContext(currentPageContext);
      resetSession();
    }
  };

  const entityTypeLabel = activeContext
    ? activeContext.entityType.charAt(0).toUpperCase() + activeContext.entityType.slice(1)
    : '';

  // Check if current page context differs from active context
  const showSwitchButton =
    currentPageContext &&
    activeContext &&
    (currentPageContext.entityId !== activeContext.entityId ||
      currentPageContext.entityType !== activeContext.entityType);

  if (!open) return null;

  return createPortal(
    <>
      {/* No backdrop overlay - allow interaction with main content */}

      {/* Panel */}
      <div
        ref={panelRef}
        role="complementary"
        aria-label="Maxwell Assistant"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
        className={cn(
          'fixed z-[200] bg-background shadow-xl flex flex-col overflow-hidden',
          'transition-all duration-300 ease-out',
          isExpanded
            ? 'inset-0 w-full h-full border-none'
            : cn(
                'border-l',
                'max-md:bottom-0 max-md:left-0 max-md:right-0 max-md:w-full max-md:h-[90dvh] max-md:rounded-t-2xl',
                'md:top-0 md:right-0 md:h-full md:w-[40%] lg:w-[35%]',
              ),
          !isExpanded && (open
            ? 'max-md:translate-y-0 md:translate-x-0'
            : 'max-md:translate-y-full md:translate-x-full')
        )}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b">
          <div className="flex items-center gap-2 flex-1 min-w-0">
            <PrismIcon size={32} className="flex-shrink-0" />
            <div className="flex-1 min-w-0">
              <h2 id="maxwell-panel-title" className="text-sm font-semibold leading-none">
                Maxwell
              </h2>
              {activeContext && (
                <p className="mt-0.5 text-xs text-muted-foreground truncate">
                  {entityTypeLabel}: {activeContext.entityName}
                </p>
              )}
            </div>
          </div>
          <div className="flex items-center gap-1">
            {messages.length > 0 && (
              <button
                onClick={handleCopyAll}
                className="rounded-full p-1.5 text-muted-foreground hover:bg-muted"
                aria-label="Copy entire conversation"
                title="Copy entire conversation"
              >
                {copiedAll ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
              </button>
            )}
            <button
              onClick={() => setIsExpanded(!isExpanded)}
              className="rounded-full p-1.5 text-muted-foreground hover:bg-muted"
              aria-label={isExpanded ? 'Collapse panel' : 'Expand panel'}
              title={isExpanded ? 'Collapse panel' : 'Expand panel'}
            >
              {isExpanded ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); onOpenChange(false); }}
              className="rounded-full p-1.5 text-muted-foreground hover:bg-muted"
              aria-label="Close Maxwell"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Context controls */}
        {(showSwitchButton || messages.length > 0) && (
          <div className="flex items-center gap-2 px-4 py-2 border-b bg-muted/30">
            {showSwitchButton && (
              <button
                onClick={handleSwitchToCurrentPage}
                className="flex items-center gap-1 text-xs text-primary hover:underline"
              >
                <ArrowRight className="h-3 w-3" />
                Switch to current page
              </button>
            )}
            {messages.length > 0 && (
              <button
                onClick={handleClearConversation}
                className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
              >
                <RefreshCw className="h-3 w-3" />
                Clear conversation
              </button>
            )}
          </div>
        )}

        {/* Message area */}
        <div className="flex-1 overflow-y-auto px-4 py-2 pb-4 space-y-3 overscroll-contain touch-pan-y">
          {messages.length === 0 && !isLoading && (
            <div className="space-y-2 pt-2">
              {starterQuestions.map((q) => (
                <button
                  key={q}
                  onClick={() => sendMessage(q, maxwellMode)}
                  disabled={isLoading}
                  className="w-full rounded-xl border border-border bg-muted/50 px-4 py-2.5 text-left text-sm text-foreground hover:bg-muted transition-colors"
                >
                  {q}
                </button>
              ))}
            </div>
          )}

          {messages.map((msg, i) => (
            <MessageBubble key={i} message={msg} />
          ))}

          {isLoading && (
            <div className="flex items-start gap-2">
              <div className="maxwell-message-assistant bg-muted rounded-2xl rounded-bl-sm px-4 py-2 flex items-center gap-2">
                <Loader2 className="h-4 w-4 animate-spin text-muted-foreground flex-shrink-0" />
                {progressStep && (
                  <span className="text-xs text-muted-foreground animate-fade-in">{progressStep}</span>
                )}
              </div>
            </div>
          )}

          {error && (
            <div className="rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
              <p>{error}</p>
              <button
                onClick={() => resetSession()}
                className="mt-1.5 flex items-center gap-1 text-xs font-medium underline-offset-2 hover:underline"
              >
                <RefreshCw className="h-3 w-3" />
                Retry
              </button>
            </div>
          )}

          {/* Spacer to ensure last message and trace are visible above input */}
          <div ref={messagesEndRef} className="h-32" />
        </div>

        {/* Input */}
        <div className="flex flex-col border-t">
          {/* Mode selector row */}
          <div className="flex items-center gap-2 px-4 pt-2 pb-1 min-w-0">
            <button
              onClick={() => setMaxwellMode(m => m === 'quick' ? 'deep' : 'quick')}
              disabled={isLoading}
              className={cn(
                'flex h-7 items-center gap-1 flex-shrink-0 rounded-full px-2.5 text-xs font-medium transition-colors',
                maxwellMode === 'quick'
                  ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400'
                  : 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400'
              )}
              aria-label={`Switch to ${maxwellMode === 'quick' ? 'deep' : 'quick'} mode`}
            >
              {maxwellMode === 'quick' ? (
                <><Zap className="h-3 w-3" />Quick</>
              ) : (
                <><BookOpen className="h-3 w-3" />Deep</>
              )}
            </button>
            <span className="text-[10px] text-muted-foreground truncate min-w-0 flex-1">
              {maxwellMode === 'quick' ? '~20s' : '~40s'}
            </span>
            <div className="relative group ml-auto">
              <Info className="h-3.5 w-3.5 text-muted-foreground/50 cursor-help" />
              <div className="absolute bottom-full right-0 mb-2 w-52 rounded-lg border bg-popover p-2.5 text-xs text-popover-foreground shadow-md opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto transition-opacity z-50">
                <p className="font-medium mb-1">Maxwell Modes</p>
                <p className="text-muted-foreground"><strong>⚡ Quick:</strong> 1 search, concise answer under 200 words. Best for simple lookups.</p>
                <p className="text-muted-foreground mt-1"><strong>📖 Deep:</strong> 2 searches, thorough analysis with sources. Best for strategic questions.</p>
              </div>
            </div>
          </div>
          {/* Input row */}
          <div
            className="flex items-end gap-2 px-4 pt-1 pb-3"
            style={{ paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom))' }}
          >
          <textarea
            ref={inputRef}
            rows={1}
            value={input}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            onFocus={() => {
              // On mobile, after the keyboard opens the layout shifts — scroll
              // the input into view so it stays visible above the keyboard.
              setTimeout(() => {
                inputRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
              }, 300);
            }}
            disabled={isLoading}
            placeholder="Ask Maxwell…"
            inputMode="text"
            enterKeyHint="send"
            className="flex-1 resize-none rounded-2xl border bg-muted px-4 py-2 text-sm outline-none placeholder:text-muted-foreground disabled:opacity-50 focus:ring-2 focus:ring-primary/30 overflow-hidden leading-5"
            style={{ minHeight: '2.25rem', maxHeight: '7.5rem' }}
          />
          <button
            onClick={handleSend}
            disabled={isLoading || !input.trim()}
            className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground disabled:opacity-40 mb-0.5"
            aria-label="Send message"
          >
            <Send className="h-4 w-4" />
          </button>
          </div>
        </div>
      </div>
    </>,
    document.body
  );
}
