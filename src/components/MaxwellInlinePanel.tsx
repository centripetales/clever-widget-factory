import { useRef, useEffect, useState, KeyboardEvent } from 'react';
import { X, Send, RefreshCw, Loader2, Copy, Check, Code } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { cn } from '@/lib/utils';
import { useMaxwell, MaxwellSessionAttributes, MaxwellMessage, MaxwellMode } from '@/hooks/useMaxwell';
import { useMaxwellStorage } from '@/hooks/useMaxwellStorage';
import { EntityContext } from '@/hooks/useEntityContext';
import { PrismIcon } from '@/components/icons/PrismIcon';
import { getImageUrl } from '@/lib/imageUtils';
import { copyToClipboard, copyConversationRich } from '@/lib/urlUtils';
import { ExpandableMarkdownImage } from '@/components/ExpandableMarkdownImage';

const STARTER_QUESTIONS: Record<string, string[]> = {
  action: [
    'Summarize what has happened so far and given our policy and observations what are next steps',
    'Are we missing any information or materials to complete this action as defined in the policy.',
    'What might telos and entelechy look like for this action.',
    'Are there any high entropy policy steps we might resolve before starting this action',
  ],
  tool: [
    'Describe the telos (ultimate purpose) of this asset',
    "Look at the history and describe the degree to which we've achieved entelecheia (are we following the best practice).",
    'What are options on reducing entropy in this context in an energy efficient way.',
  ],
  part: [
    'Describe the telos (ultimate purpose) of this asset',
    "Look at the history and describe the degree to which we've achieved entelecheia (are we following the best practice).",
    'What are options on reducing entropy in this context in an energy efficient way.',
  ],
};

export interface MaxwellInlinePanelProps {
  context: EntityContext | null;
  onClose: () => void;
  /** Optional extra className for the outer container */
  className?: string;
  /** Hide the "Maxwell / entity name" header — useful when context is already visible */
  hideHeader?: boolean;
  /** Hide the starter question prompts */
  hidePrompts?: boolean;
}

function MessageBubble({ message }: { message: MaxwellMessage }) {
  const isUser = message.role === 'user';
  const [copied, setCopied] = useState(false);
  const [copiedTrace, setCopiedTrace] = useState(false);
  const [showTrace, setShowTrace] = useState(false);

  const handleCopy = async () => {
    await copyToClipboard(message.content);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleCopyTrace = async () => {
    if (message.trace) {
      await copyToClipboard(JSON.stringify(message.trace, null, 2));
      setCopiedTrace(true);
      setTimeout(() => setCopiedTrace(false), 2000);
    }
  };

  return (
    <div className={cn('flex flex-col gap-1 group', isUser ? 'items-end' : 'items-start')}>
      <div
        className={cn(
          'max-w-[85%] rounded-2xl px-4 py-2 text-sm relative',
          isUser
            ? 'bg-primary text-primary-foreground rounded-br-sm'
            : 'bg-muted text-foreground rounded-bl-sm'
        )}
      >
        {isUser ? (
          <p className="whitespace-pre-wrap break-words text-sm">{message.content}</p>
        ) : (
          <div className="maxwell-markdown prose prose-sm dark:prose-invert max-w-none break-words [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
            <ReactMarkdown 
              remarkPlugins={[remarkGfm]}
              components={{
                img: ({ node, ...props }) => <ExpandableMarkdownImage src={props.src} alt={props.alt} />
              }}
            >
              {message.content}
            </ReactMarkdown>
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
          {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
        </button>
      </div>

      {!isUser && message.trace && message.trace.length > 0 && (
        <div className="max-w-[85%] mt-1">
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
              >
                {copiedTrace ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                {copiedTrace ? 'Copied' : 'Copy'}
              </button>
            )}
          </div>
          {showTrace && (
            <div className="mt-2 mb-4 rounded-lg border bg-background p-3 text-xs font-mono overflow-x-auto max-h-64 overflow-y-auto shadow-lg">
              <pre className="whitespace-pre-wrap break-words">{JSON.stringify(message.trace, null, 2)}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * MaxwellInlinePanel — renders inline inside any container (no portal, no fixed positioning).
 * Safe to use inside Radix dialogs, sheets, or any other overlay.
 */
export function MaxwellInlinePanel({ context, onClose, className, hideHeader = false, hidePrompts = false }: MaxwellInlinePanelProps) {
  const { saveConversation, clearConversation } = useMaxwellStorage();
  const [input, setInput] = useState('');
  const [copiedAll, setCopiedAll] = useState(false);
  const [mode, setMode] = useState<MaxwellMode>('quick');
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const sessionAttributes: MaxwellSessionAttributes | null = context
    ? {
      entityId: context.entityId,
      entityType: context.entityType,
      entityName: context.entityName,
      policy: context.policy,
      implementation: context.implementation,
    }
    : null;

  const { messages, isLoading, progressStep, error, sendMessage, resetSession } = useMaxwell(
    sessionAttributes ?? { entityId: '', entityType: 'action', entityName: '', policy: '', implementation: '' }
  );

  // Focus input on mount
  useEffect(() => {
    const t = setTimeout(() => inputRef.current?.focus(), 50);
    return () => clearTimeout(t);
  }, []);

  // Auto-scroll on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isLoading]);

  // Persist conversation
  useEffect(() => {
    if (context && messages.length > 0) saveConversation(context, messages);
  }, [context, messages, saveConversation]);

  const starterQuestions = STARTER_QUESTIONS[context?.entityType ?? 'action'] ?? STARTER_QUESTIONS.action;

  const handleSend = async () => {
    const text = input.trim();
    if (!text || isLoading || !sessionAttributes) return;
    setInput('');
    await sendMessage(text, mode);
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleCopyAll = async () => {
    await copyConversationRich(messages);
    setCopiedAll(true);
    setTimeout(() => setCopiedAll(false), 2000);
  };

  const handleClear = () => {
    if (context) clearConversation(context);
    resetSession();
  };

  const entityTypeLabel = context
    ? context.entityType.charAt(0).toUpperCase() + context.entityType.slice(1)
    : '';

  return (
    <div className={cn('flex flex-col h-full border rounded-lg bg-background overflow-hidden', className)}>
      {/* Header */}
      {!hideHeader && (
        <div className="flex items-center justify-between px-3 py-2 border-b flex-shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <PrismIcon size={24} className="flex-shrink-0" />
            <div className="min-w-0">
              <span className="text-sm font-semibold">Maxwell</span>
              {context && (
                <p className="text-xs text-muted-foreground truncate">
                  {entityTypeLabel}: {context.entityName}
                </p>
              )}
            </div>
          </div>
          <div className="flex items-center gap-1 flex-shrink-0">
            <select
              value={mode}
              onChange={(e) => setMode(e.target.value as MaxwellMode)}
              disabled={isLoading}
              className="rounded-md border border-input bg-background px-2 py-1 text-xs font-semibold text-foreground ring-offset-background outline-none hover:bg-muted focus:ring-1 focus:ring-ring disabled:opacity-50 transition-colors cursor-pointer mr-1"
              title="Select Maxwell Model"
            >
              <option value="quick">⚡ Haiku (Fast)</option>
              <option value="deep">🧠 Sonnet (Deep)</option>
            </select>

            {messages.length > 0 && (
              <>
                <button
                  onClick={handleCopyAll}
                  className="rounded-full p-1.5 text-muted-foreground hover:bg-muted"
                  title="Copy conversation"
                >
                  {copiedAll ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                </button>
                <button
                  onClick={handleClear}
                  className="rounded-full p-1.5 text-muted-foreground hover:bg-muted"
                  title="Clear conversation"
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                </button>
              </>
            )}
            <button
              onClick={onClose}
              className="rounded-full p-1.5 text-muted-foreground hover:bg-muted"
              aria-label="Close Maxwell"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      )}

      {hideHeader && (
        <div className="flex items-center justify-end gap-1 px-2 pt-1 flex-shrink-0">
          <select
            value={mode}
            onChange={(e) => setMode(e.target.value as MaxwellMode)}
            disabled={isLoading}
            className="rounded-md border border-input bg-background px-2 py-1 text-xs font-semibold text-foreground ring-offset-background outline-none hover:bg-muted focus:ring-1 focus:ring-ring disabled:opacity-50 transition-colors cursor-pointer mr-1"
            title="Select Maxwell Model"
          >
            <option value="quick">⚡ Haiku (Fast)</option>
            <option value="deep">🧠 Sonnet (Deep)</option>
          </select>

          {messages.length > 0 && (
            <>
              <button
                onClick={handleCopyAll}
                className="rounded-full p-1.5 text-muted-foreground hover:bg-muted"
                title="Copy conversation"
              >
                {copiedAll ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
              </button>
              <button
                onClick={handleClear}
                className="rounded-full p-1.5 text-muted-foreground hover:bg-muted"
                title="Clear conversation"
              >
                <RefreshCw className="h-3.5 w-3.5" />
              </button>
            </>
          )}
        </div>
      )}

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-3 py-2 space-y-3 min-h-0">
        {messages.length === 0 && !isLoading && !hidePrompts && (
          <div className="space-y-2 pt-1">
            {starterQuestions.map((q) => (
              <button
                key={q}
                onClick={() => sendMessage(q, mode)}
                disabled={isLoading}
                className="w-full rounded-xl border border-border bg-muted/50 px-3 py-2 text-left text-xs text-foreground hover:bg-muted transition-colors"
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
          <div className="flex items-start">
            <div className="bg-muted rounded-2xl rounded-bl-sm px-4 py-2 flex items-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground flex-shrink-0" />
              {progressStep && (
                <span className="text-xs text-muted-foreground animate-fade-in">{progressStep}</span>
              )}
            </div>
          </div>
        )}

        {error && (
          <div className="rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            <p>{error}</p>
            <button onClick={resetSession} className="mt-1 flex items-center gap-1 underline-offset-2 hover:underline">
              <RefreshCw className="h-3 w-3" /> Retry
            </button>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div className="flex items-center gap-2 border-t px-3 py-2 flex-shrink-0">
        <input
          ref={inputRef}
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={isLoading}
          placeholder="Ask Maxwell…"
          className="flex-1 rounded-full border bg-muted px-3 py-1.5 text-sm outline-none placeholder:text-muted-foreground disabled:opacity-50 focus:ring-2 focus:ring-primary/30"
        />
        <button
          onClick={handleSend}
          disabled={isLoading || !input.trim()}
          className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground disabled:opacity-40"
          aria-label="Send"
        >
          <Send className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}
