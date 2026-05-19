import { useRef, useEffect, useState, KeyboardEvent } from 'react';
import type { JSX } from 'react';
import { Drawer as DrawerPrimitive } from 'vaul';
import { Bot, ChevronDown, ChevronUp, Send, RefreshCw, Loader2, Copy, Check, Code } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useMaxwell, MaxwellSessionAttributes, MaxwellMessage } from '@/hooks/useMaxwell';

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

// Snap points: collapsed bar height and full screen
const SNAP_COLLAPSED = '60px';
const SNAP_EXPANDED = 1;

interface MaxwellPanelProps extends MaxwellSessionAttributes {
  open: boolean;
  onOpenChange: (open: boolean) => void;
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

  // Parse markdown images: ![alt](url) and render as <img> tags
  const renderContent = (text: string) => {
    const parts: (string | JSX.Element)[] = [];
    const imageRegex = /!\[([^\]]*)\]\(([^)]+)\)/g;
    let lastIndex = 0;
    let match;
    let imageIndex = 0;

    while ((match = imageRegex.exec(text)) !== null) {
      // Add text before the image
      if (match.index > lastIndex) {
        parts.push(text.slice(lastIndex, match.index));
      }

      // Add the image (clickable to open full resolution)
      const alt = match[1];
      const url = match[2];
      parts.push(
        <a
          key={`img-${imageIndex++}`}
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="block mt-2"
        >
          <img
            src={url}
            alt={alt}
            title={`${alt} (click to view full resolution)`}
            className="max-w-full rounded-lg cursor-pointer hover:opacity-90 transition-opacity"
            style={{ maxHeight: '300px', objectFit: 'contain' }}
          />
        </a>
      );

      lastIndex = match.index + match[0].length;
    }

    // Add remaining text
    if (lastIndex < text.length) {
      parts.push(text.slice(lastIndex));
    }

    return parts.length > 0 ? parts : text;
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
        <p className="whitespace-pre-wrap break-words">{renderContent(message.content)}</p>
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

export function MaxwellPanel({
  open,
  onOpenChange,
  entityId,
  entityType,
  entityName,
  policy,
  implementation,
}: MaxwellPanelProps) {
  const sessionAttributes: MaxwellSessionAttributes = {
    entityId,
    entityType,
    entityName,
    policy,
    implementation,
  };

  const { messages, isLoading, error, sendMessage, resetSession } = useMaxwell(sessionAttributes);
  const [input, setInput] = useState('');
  const [activeSnapPoint, setActiveSnapPoint] = useState<string | number>(SNAP_EXPANDED);
  const [copiedAll, setCopiedAll] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const isCollapsed = activeSnapPoint === SNAP_COLLAPSED;

  // Select starter questions based on entity type
  const starterQuestions = entityType === 'action' ? STARTER_QUESTIONS_ACTION : STARTER_QUESTIONS_ASSET;

  const handleCopyAll = async () => {
    const conversationText = messages
      .map((msg) => `${msg.role === 'user' ? 'You' : 'Maxwell'}: ${msg.content}`)
      .join('\n\n');
    await navigator.clipboard.writeText(conversationText);
    setCopiedAll(true);
    setTimeout(() => setCopiedAll(false), 2000);
  };

  // When parent opens the panel, always expand to full screen
  useEffect(() => {
    if (open) {
      setActiveSnapPoint(SNAP_EXPANDED);
    }
  }, [open]);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    if (!isCollapsed) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages, isLoading, isCollapsed]);

  const handleSend = async () => {
    const text = input.trim();
    if (!text || isLoading) return;
    setInput('');
    await sendMessage(text);
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleToggle = () => {
    if (isCollapsed) {
      setActiveSnapPoint(SNAP_EXPANDED);
    } else {
      setActiveSnapPoint(SNAP_COLLAPSED);
    }
  };

  // When vaul snaps to a point, sync our state; if drawer is fully closed, notify parent
  const handleSnapPointChange = (snapPoint: string | number | null) => {
    if (snapPoint === null) {
      // Drawer was dragged fully closed — treat as collapsed bar instead
      setActiveSnapPoint(SNAP_COLLAPSED);
    } else {
      setActiveSnapPoint(snapPoint);
    }
  };

  const entityTypeLabel = entityType.charAt(0).toUpperCase() + entityType.slice(1);

  return (
    <DrawerPrimitive.Root
      open={open}
      onOpenChange={(isOpen) => {
        if (!isOpen) {
          // Instead of closing, collapse to bar
          setActiveSnapPoint(SNAP_COLLAPSED);
        } else {
          onOpenChange(true);
        }
      }}
      snapPoints={[SNAP_COLLAPSED, SNAP_EXPANDED]}
      activeSnapPoint={activeSnapPoint}
      setActiveSnapPoint={handleSnapPointChange}
      modal={false}
      shouldScaleBackground={false}
    >
      <DrawerPrimitive.Portal>
        {/* No overlay - allows full interaction with content underneath */}
        <DrawerPrimitive.Content
          className={cn(
            "fixed inset-x-0 bottom-0 z-50 flex flex-col rounded-t-2xl border bg-background shadow-xl focus:outline-none",
            isCollapsed && "pointer-events-none"
          )}
          style={{ height: '100dvh', maxHeight: '100dvh' }}
        >
          {/* Drag handle — only visible when expanded */}
          {!isCollapsed && (
            <div className="mx-auto mt-3 h-1.5 w-12 flex-shrink-0 rounded-full bg-muted-foreground/30" />
          )}

          {/* Header — always visible, acts as the collapsed bar */}
          <div
            className={cn(
              'flex items-center justify-between px-4',
              isCollapsed ? 'py-0 h-[60px] cursor-pointer pointer-events-auto' : 'py-3'
            )}
            onClick={isCollapsed ? handleToggle : undefined}
          >
            <div className="flex items-center gap-2">
              <Bot className="h-5 w-5 text-primary" />
              <div>
                <DrawerPrimitive.Title className="text-sm font-semibold leading-none">
                  Maxwell
                </DrawerPrimitive.Title>
                {!isCollapsed && (
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {entityTypeLabel}: {entityName}
                  </p>
                )}
                {isCollapsed && (
                  <p className="text-xs text-muted-foreground">
                    {entityTypeLabel}: {entityName}
                  </p>
                )}
              </div>
            </div>
            <div className="flex items-center gap-1">
              {!isCollapsed && messages.length > 0 && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    handleCopyAll();
                  }}
                  className="rounded-full p-1.5 text-muted-foreground hover:bg-muted"
                  aria-label="Copy entire conversation"
                  title="Copy entire conversation"
                >
                  {copiedAll ? (
                    <Check className="h-4 w-4" />
                  ) : (
                    <Copy className="h-4 w-4" />
                  )}
                </button>
              )}
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  handleToggle();
                }}
                className="rounded-full p-1.5 text-muted-foreground hover:bg-muted"
                aria-label={isCollapsed ? 'Expand Maxwell' : 'Collapse Maxwell'}
              >
                {isCollapsed ? (
                  <ChevronUp className="h-4 w-4" />
                ) : (
                  <ChevronDown className="h-4 w-4" />
                )}
              </button>
            </div>
          </div>

          {/* Message area — hidden when collapsed */}
          {!isCollapsed && (
            <div className="flex-1 overflow-y-auto px-4 py-2 pb-4 space-y-3 overscroll-contain touch-pan-y">
              {messages.length === 0 && !isLoading && (
                <div className="space-y-2 pt-2">
                  <p className="text-xs text-muted-foreground text-center">Ask Maxwell about this {entityType}</p>
                  {starterQuestions.map((q) => (
                    <button
                      key={q}
                      onClick={() => sendMessage(q)}
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
                  <div className="maxwell-message-assistant bg-muted rounded-2xl rounded-bl-sm px-4 py-2">
                    <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
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
          )}

          {/* Input — hidden when collapsed */}
          {!isCollapsed && (
            <div className="flex items-center gap-2 border-t px-4 py-3 pb-safe">
              <input
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                disabled={isLoading}
                placeholder="Ask Maxwell…"
                className="flex-1 rounded-full border bg-muted px-4 py-2 text-sm outline-none placeholder:text-muted-foreground disabled:opacity-50 focus:ring-2 focus:ring-primary/30"
              />
              <button
                onClick={handleSend}
                disabled={isLoading || !input.trim()}
                className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground disabled:opacity-40"
                aria-label="Send message"
              >
                <Send className="h-4 w-4" />
              </button>
            </div>
          )}
        </DrawerPrimitive.Content>
      </DrawerPrimitive.Portal>
    </DrawerPrimitive.Root>
  );
}
