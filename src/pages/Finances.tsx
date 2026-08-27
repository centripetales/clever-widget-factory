import { useState, useMemo, useRef, useEffect, KeyboardEvent } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useMaxwellRecordHighlight } from '@/contexts/MaxwellRecordHighlightContext';
import { useMaxwell, MaxwellSessionAttributes } from '@/hooks/useMaxwell';
import { extractRecordIdsFromTrace } from '@/lib/traceParser';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ArrowLeft, Plus, Loader2, ArrowUpDown, X, Send, Code, Copy, Check, RefreshCw, Maximize2, Minimize2 } from 'lucide-react';
import { useFinancialRecords } from '@/hooks/useFinancialRecords';
import { PrismIcon } from '@/components/icons/PrismIcon';

const TIME_FRAMES = [
  { value: '7', label: '7 Days' },
  { value: '30', label: '30 Days' },
  { value: '90', label: '90 Days' },
  { value: '365', label: '1 Year' },
  { value: 'all', label: 'All Time' },
] as const;

const PAYMENT_METHODS = ['Cash', 'SCash', 'GCash', 'Wise'] as const;

const METHOD_COLORS: Record<string, string> = {
  Cash: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300',
  SCash: 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300',
  GCash: 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300',
  Wise: 'bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300',
};

type SortField = 'transaction_date' | 'description' | 'amount';
type SortDir = 'asc' | 'desc';

const EMPTY_SESSION: MaxwellSessionAttributes = {
  entityId: '', entityType: 'action', entityName: '', policy: '', implementation: '',
};

export default function Finances() {
  const navigate = useNavigate();
  const location = useLocation();
  const { maxwellRecordIds, setMaxwellRecordIds, clearMaxwellRecordIds, isFilterActive, setIsFilterActive } = useMaxwellRecordHighlight();
  const [timeFrame, setTimeFrame] = useState('30');
  const [descSearch, setDescSearch] = useState('');
  const [methodFilter, setMethodFilter] = useState('All');
  const [creatorFilter, setCreatorFilter] = useState('All');
  const [sortField, setSortField] = useState<SortField>('transaction_date');
  const [sortDir, setSortDir] = useState<SortDir>('desc');

  // Inline Maxwell
  const [maxwellOpen, setMaxwellOpen] = useState(false);
  const [maxwellExpanded, setMaxwellExpanded] = useState(false);
  const [maxwellInput, setMaxwellInput] = useState('');
  const [showTrace, setShowTrace] = useState(false);
  const [copiedResponse, setCopiedResponse] = useState(false);
  const [copiedTrace, setCopiedTrace] = useState(false);
  const { messages, isLoading: maxwellLoading, sendMessage, resetSession } = useMaxwell(EMPTY_SESSION);
  const maxwellInputRef = useRef<HTMLInputElement>(null);

  const { startDate, endDate } = useMemo(() => {
    const today = new Date().toISOString().split('T')[0];
    if (timeFrame === 'all') return { startDate: undefined, endDate: today };
    const d = new Date();
    d.setDate(d.getDate() - parseInt(timeFrame));
    // Numeric time frames are a lookback window only; leaving end_date uncapped
    // surfaces future-dated transactions (e.g. accidental typos) instead of
    // hiding them until their date arrives.
    return { startDate: d.toISOString().split('T')[0], endDate: undefined };
  }, [timeFrame]);

  const filters = useMemo(() => (
    { ...(startDate ? { start_date: startDate } : {}), ...(endDate ? { end_date: endDate } : {}) }
  ), [startDate, endDate]);

  const { data: financialData, isLoading, dataUpdatedAt } = useFinancialRecords(filters);

  const creatorNames = useMemo(() => {
    if (!financialData?.records) return ['All'];
    const names = new Set(financialData.records.map(r => r.created_by_name || 'Unknown'));
    return ['All', ...Array.from(names).sort()];
  }, [financialData?.records]);

  const firstHighlightRef = useRef<HTMLTableRowElement>(null);
  const prevRecordIdsRef = useRef<string[]>([]);
  const maxwellRecordIdSet = useMemo(() => new Set(maxwellRecordIds), [maxwellRecordIds]);

  const matchCount = useMemo(() => {
    if (!financialData?.records || maxwellRecordIds.length === 0) return 0;
    return financialData.records.filter(r => maxwellRecordIdSet.has(r.id)).length;
  }, [financialData?.records, maxwellRecordIds, maxwellRecordIdSet]);

  useEffect(() => {
    const lastMessage = messages[messages.length - 1];
    if (lastMessage?.role === 'assistant' && lastMessage.trace?.length) {
      const ids = extractRecordIdsFromTrace(lastMessage.trace, lastMessage.rawReply);
      if (ids.length > 0) setMaxwellRecordIds(ids);
    }
  }, [messages]);

  useEffect(() => {
    if (maxwellRecordIds.length > 0 && prevRecordIdsRef.current.length === 0 && firstHighlightRef.current) {
      firstHighlightRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    prevRecordIdsRef.current = maxwellRecordIds;
  }, [maxwellRecordIds]);

  useEffect(() => { return () => { clearMaxwellRecordIds(); }; }, []);
  useEffect(() => { if (maxwellOpen) setTimeout(() => maxwellInputRef.current?.focus(), 100); }, [maxwellOpen]);

  const handleMaxwellSend = async () => {
    const text = maxwellInput.trim();
    if (!text || maxwellLoading) return;
    setMaxwellInput('');
    await sendMessage(text);
  };

  const handleMaxwellKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleMaxwellSend(); }
  };

  const filteredAndSorted = useMemo(() => {
    if (!financialData?.records) return [];
    let records = [...financialData.records];
    if (descSearch.trim()) {
      const q = descSearch.toLowerCase();
      records = records.filter(r => (r.description || '').toLowerCase().includes(q));
    }
    if (methodFilter !== 'All') records = records.filter(r => r.payment_method === methodFilter);
    if (creatorFilter !== 'All') records = records.filter(r => (r.created_by_name || 'Unknown') === creatorFilter);
    if (isFilterActive && maxwellRecordIds.length > 0) records = records.filter(r => maxwellRecordIdSet.has(r.id));

    records.sort((a, b) => {
      let cmp = 0;
      switch (sortField) {
        case 'transaction_date': cmp = new Date(a.transaction_date).getTime() - new Date(b.transaction_date).getTime(); break;
        case 'description': cmp = (a.description || '').localeCompare(b.description || ''); break;
        case 'amount': cmp = a.amount - b.amount; break;
      }
      return sortDir === 'asc' ? cmp : -cmp;
    });
    return records;
  }, [financialData?.records, descSearch, methodFilter, creatorFilter, sortField, sortDir, isFilterActive, maxwellRecordIds, maxwellRecordIdSet]);

  const toggleSort = (field: SortField) => {
    if (sortField === field) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortField(field); setSortDir(field === 'transaction_date' ? 'desc' : 'asc'); }
  };

  const hasFilters = descSearch || methodFilter !== 'All' || creatorFilter !== 'All';
  const lastAssistantMessage = [...messages].reverse().find(m => m.role === 'assistant');
  const lastUserMessage = [...messages].reverse().find(m => m.role === 'user');
  const updatedTime = dataUpdatedAt ? new Date(dataUpdatedAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : null;

  return (
    <div className="container mx-auto p-4 max-w-6xl">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon" onClick={() => navigate('/')}>
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <h1 className="text-2xl font-bold">Transactions</h1>
          {!isLoading && (
            <span className="text-sm text-muted-foreground">
              ({filteredAndSorted.length}{hasFilters ? `/${financialData?.records?.length || 0}` : ''})
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            className="h-10 w-10 rounded-md overflow-hidden cursor-pointer"
            onClick={() => setMaxwellOpen(!maxwellOpen)}
            aria-label="Ask Maxwell"
          >
            <PrismIcon size={40} />
          </button>
          <Button onClick={() => navigate('/financial-records/new')}>
            <Plus className="h-4 w-4 mr-1" />
            Record Transaction
          </Button>
        </div>
      </div>

      {/* Inline Maxwell Chat */}
      {maxwellOpen && (
        <div className={cn(
          maxwellExpanded
            ? 'fixed inset-0 z-[200] bg-background flex flex-col'
            : ''
        )}>
          {/* Expanded header */}
          {maxwellExpanded && (
            <div className="flex items-center justify-between px-4 py-3 border-b">
              <div className="flex items-center gap-2">
                <PrismIcon size={28} />
                <span className="text-sm font-semibold">Maxwell</span>
              </div>
              <div className="flex items-center gap-1">
                <button
                  onClick={() => setMaxwellExpanded(false)}
                  className="rounded-full p-1.5 text-muted-foreground hover:bg-muted"
                  aria-label="Collapse panel"
                  title="Collapse panel"
                >
                  <Minimize2 className="h-4 w-4" />
                </button>
                <button
                  onClick={() => { setMaxwellExpanded(false); setMaxwellOpen(false); }}
                  className="rounded-full p-1.5 text-muted-foreground hover:bg-muted"
                  aria-label="Close Maxwell"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>
          )}

          {/* Expanded: full conversation scroll area */}
          {maxwellExpanded && (
            <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3">
              {messages.map((msg, i) => {
                const isUser = msg.role === 'user';
                return (
                  <div key={i} className={cn('flex', isUser ? 'justify-end' : 'justify-start')}>
                    <div className={cn(
                      'max-w-[75%] rounded-2xl px-4 py-2 text-sm',
                      isUser
                        ? 'bg-primary text-primary-foreground rounded-br-sm'
                        : 'bg-muted text-foreground rounded-bl-sm'
                    )}>
                      <p className="whitespace-pre-wrap break-words">
                        {msg.content.split(/(\*\*.*?\*\*)/g).map((part, j) =>
                          part.startsWith('**') && part.endsWith('**')
                            ? <strong key={j}>{part.slice(2, -2)}</strong>
                            : <span key={j}>{part}</span>
                        )}
                      </p>
                    </div>
                  </div>
                );
              })}
              {maxwellLoading && (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" /> Maxwell is thinking...
                </div>
              )}
              <div className="h-1" />
            </div>
          )}

          {/* Collapsed: inline card (original behavior) */}
          {!maxwellExpanded && (
            <Card className="mb-4 border-primary/30">
              <CardContent className="pt-4 pb-3">
                {lastUserMessage && (
                  <div className="mb-2 flex justify-end">
                    <div className="bg-primary text-primary-foreground rounded-2xl rounded-br-sm px-4 py-2 text-sm max-w-[85%]">
                      {lastUserMessage.content}
                    </div>
                  </div>
                )}
                {lastAssistantMessage && (
                  <div className="mb-3 relative group">
                    <div className="max-h-64 overflow-y-auto text-sm bg-muted rounded-lg p-3 pr-8">
                      {lastAssistantMessage.content.split('\n').map((line, i) => {
                        const parts = line.split(/(\*\*.*?\*\*)/g);
                        return (
                          <p key={i} className={cn("break-words", line.trim() === '' ? 'h-2' : '')}>
                            {parts.map((part, j) =>
                              part.startsWith('**') && part.endsWith('**')
                                ? <strong key={j}>{part.slice(2, -2)}</strong>
                                : <span key={j}>{part}</span>
                            )}
                          </p>
                        );
                      })}
                    </div>
                    <div className="absolute top-2 right-2 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                      <button
                        onClick={() => setMaxwellExpanded(true)}
                        className="p-1 rounded hover:bg-muted-foreground/10"
                        aria-label="Expand conversation"
                        title="Expand conversation"
                      >
                        <Maximize2 className="h-3 w-3" />
                      </button>
                      <button
                        onClick={async () => { await navigator.clipboard.writeText(lastAssistantMessage.content); setCopiedResponse(true); setTimeout(() => setCopiedResponse(false), 2000); }}
                        className="p-1 rounded hover:bg-muted-foreground/10"
                        aria-label="Copy response"
                      >
                        {copiedResponse ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                      </button>
                    </div>
                  </div>
                )}
                {lastAssistantMessage?.trace && lastAssistantMessage.trace.length > 0 && (
                  <div className="mb-3">
                    <div className="flex items-center gap-2">
                      <button onClick={() => setShowTrace(!showTrace)} className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors">
                        <Code className="h-3 w-3" />
                        {showTrace ? 'Hide' : 'Show'} trace ({lastAssistantMessage.trace.length} events)
                      </button>
                      {showTrace && (
                        <button
                          onClick={async () => { await navigator.clipboard.writeText(JSON.stringify(lastAssistantMessage.trace, null, 2)); setCopiedTrace(true); setTimeout(() => setCopiedTrace(false), 2000); }}
                          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
                          aria-label="Copy trace"
                        >
                          {copiedTrace ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                          {copiedTrace ? 'Copied' : 'Copy'}
                        </button>
                      )}
                    </div>
                    {showTrace && (
                      <div className="mt-2 rounded-lg border bg-background p-3 text-xs font-mono overflow-x-auto max-h-48 overflow-y-auto">
                        <pre className="whitespace-pre-wrap break-words">{JSON.stringify(lastAssistantMessage.trace, null, 2)}</pre>
                      </div>
                    )}
                  </div>
                )}
                {maxwellLoading && (
                  <div className="mb-3 flex items-center gap-2 text-sm text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin" /> Maxwell is thinking...
                  </div>
                )}
                <div className="flex items-center gap-2">
                  <PrismIcon size={20} />
                  <Input
                    ref={maxwellInputRef}
                    value={maxwellInput}
                    onChange={(e) => setMaxwellInput(e.target.value)}
                    onKeyDown={handleMaxwellKeyDown}
                    placeholder="Ask about expenses..."
                    className="flex-1 h-9 text-sm"
                    disabled={maxwellLoading}
                  />
                  <Button size="icon" variant="ghost" onClick={handleMaxwellSend} disabled={!maxwellInput.trim() || maxwellLoading}>
                    <Send className="h-4 w-4" />
                  </Button>
                  {messages.length > 0 && (
                    <Button size="icon" variant="ghost" onClick={() => { resetSession(); clearMaxwellRecordIds(); }} title="Clear conversation">
                      <RefreshCw className="h-4 w-4" />
                    </Button>
                  )}
                </div>
              </CardContent>
            </Card>
          )}

          {/* Input bar — expanded mode only */}
          {maxwellExpanded && (
            <div className="flex items-center gap-2 border-t px-4 py-3">
              <Input
                ref={maxwellInputRef}
                value={maxwellInput}
                onChange={(e) => setMaxwellInput(e.target.value)}
                onKeyDown={handleMaxwellKeyDown}
                placeholder="Ask about expenses..."
                className="flex-1 h-9 text-sm"
                disabled={maxwellLoading}
              />
              <Button size="icon" variant="ghost" onClick={handleMaxwellSend} disabled={!maxwellInput.trim() || maxwellLoading}>
                <Send className="h-4 w-4" />
              </Button>
              {messages.length > 0 && (
                <Button size="icon" variant="ghost" onClick={() => { resetSession(); clearMaxwellRecordIds(); }} title="Clear conversation">
                  <RefreshCw className="h-4 w-4" />
                </Button>
              )}
            </div>
          )}
        </div>
      )}

      {/* Compact Balance Card */}
      <div className="flex items-center justify-between mb-4 px-1">
        <div className="flex items-baseline gap-2">
          <span className="text-sm text-muted-foreground">Cash Balance</span>
          {isLoading ? (
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          ) : (
            <span className={cn("text-xl font-bold", (financialData?.running_balance ?? 0) < 0 ? 'text-red-600' : 'text-green-600')}>
              ₱{(financialData?.running_balance ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </span>
          )}
        </div>
        {updatedTime && <span className="text-xs text-muted-foreground">Updated {updatedTime}</span>}
      </div>

      {/* Search & Filter Bar */}
      <div className="flex items-center gap-2 mb-3">
        <Input
          placeholder="Search descriptions..."
          value={descSearch}
          onChange={(e) => setDescSearch(e.target.value)}
          className="h-9 text-sm flex-1"
        />
        <Select value={methodFilter} onValueChange={setMethodFilter}>
          <SelectTrigger className="w-[100px] h-9 text-xs">
            <SelectValue>{methodFilter === 'All' ? 'Method' : methodFilter}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="All">All Methods</SelectItem>
            {PAYMENT_METHODS.map((m) => <SelectItem key={m} value={m}>{m}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={creatorFilter} onValueChange={setCreatorFilter}>
          <SelectTrigger className="w-[110px] h-9 text-xs">
            <SelectValue>{creatorFilter === 'All' ? 'Created By' : creatorFilter}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="All">All People</SelectItem>
            {creatorNames.filter(n => n !== 'All').map((name) => <SelectItem key={name} value={name}>{name}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={timeFrame} onValueChange={setTimeFrame}>
          <SelectTrigger className="w-[100px] h-9 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {TIME_FRAMES.map((tf) => <SelectItem key={tf.value} value={tf.value}>{tf.label}</SelectItem>)}
          </SelectContent>
        </Select>
        {hasFilters && (
          <Button variant="ghost" size="sm" className="h-9 px-2" onClick={() => { setDescSearch(''); setMethodFilter('All'); setCreatorFilter('All'); }}>
            <X className="h-3 w-3" />
          </Button>
        )}
      </div>

      {/* Maxwell highlight indicator */}
      {maxwellRecordIds.length > 0 && matchCount > 0 && (
        <div className="flex items-center justify-between px-4 py-2 mb-3 rounded-lg bg-orange-100 border border-orange-300 dark:bg-orange-900/30 dark:border-orange-700">
          <span className="text-sm text-orange-700 dark:text-orange-300">
            {matchCount} records from Maxwell
          </span>
          <Button variant="ghost" size="icon" className="h-6 w-6" onClick={clearMaxwellRecordIds}>
            <X className="h-3 w-3" />
          </Button>
        </div>
      )}

      {/* Transaction Table */}
      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : financialData?.records && financialData.records.length > 0 ? (
        <div className="rounded-lg border overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/50">
                <TableHead className="w-[80px]">
                  <button className="flex items-center gap-1 hover:text-foreground text-xs" onClick={() => toggleSort('transaction_date')}>
                    Date
                    <ArrowUpDown className={cn("h-3 w-3", sortField === 'transaction_date' ? 'text-foreground' : 'text-muted-foreground/50')} />
                  </button>
                </TableHead>
                <TableHead>
                  <button className="flex items-center gap-1 hover:text-foreground text-xs" onClick={() => toggleSort('description')}>
                    Description
                    <ArrowUpDown className={cn("h-3 w-3", sortField === 'description' ? 'text-foreground' : 'text-muted-foreground/50')} />
                  </button>
                </TableHead>
                <TableHead className="w-[100px] text-right">
                  <button className="flex items-center gap-1 ml-auto hover:text-foreground text-xs whitespace-nowrap" onClick={() => toggleSort('amount')}>
                    Amount
                    <ArrowUpDown className={cn("h-3 w-3", sortField === 'amount' ? 'text-foreground' : 'text-muted-foreground/50')} />
                  </button>
                </TableHead>
                <TableHead className="w-[90px] text-right text-xs whitespace-nowrap">Balance</TableHead>
                <TableHead className="w-[80px] text-xs">Method</TableHead>
                <TableHead className="w-[100px] text-xs">By</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(() => {
                let firstHighlightAssigned = false;
                return filteredAndSorted.map((record, idx) => {
                  const isHighlighted = maxwellRecordIdSet.has(record.id);
                  const isFirstHighlight = isHighlighted && !firstHighlightAssigned;
                  if (isFirstHighlight) firstHighlightAssigned = true;
                  const isEven = idx % 2 === 0;

                  return (
                    <TableRow
                      key={record.id}
                      ref={isFirstHighlight ? firstHighlightRef : undefined}
                      className={cn(
                        "cursor-pointer",
                        isHighlighted
                          ? "bg-orange-100 hover:bg-orange-200 dark:bg-orange-900/30 dark:hover:bg-orange-900/50"
                          : isEven
                            ? "bg-background hover:bg-muted/50"
                            : "bg-muted/20 hover:bg-muted/50"
                      )}
                      onClick={() => navigate(`/financial-records/${record.id}`)}
                    >
                      <TableCell className="text-xs py-2">
                        {new Date(record.transaction_date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                      </TableCell>
                      <TableCell className="truncate max-w-[200px] py-2 text-sm">{record.description}</TableCell>
                      <TableCell className={cn("text-right font-medium whitespace-nowrap py-2 text-sm", record.amount < 0 ? 'text-green-600' : '')}>
                        {record.amount < 0 ? '+' : '-'}{Math.abs(record.amount).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                      </TableCell>
                      <TableCell className="text-right text-xs text-muted-foreground whitespace-nowrap py-2">
                        {record.balance_after != null ? record.balance_after.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—'}
                      </TableCell>
                      <TableCell className="py-2">
                        <span className="text-[10px] text-muted-foreground">
                          {record.payment_method}
                        </span>
                      </TableCell>
                      <TableCell className="text-xs py-2 text-muted-foreground">
                        {record.created_by_name || 'Unknown'}
                      </TableCell>
                    </TableRow>
                  );
                });
              })()}
            </TableBody>
          </Table>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground text-center py-8">No transactions found</p>
      )}
    </div>
  );
}
