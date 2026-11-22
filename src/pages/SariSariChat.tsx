import { useState, useEffect, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Badge } from '@/components/ui/badge';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Send, User, Loader2, RefreshCw, ChevronDown, ChevronUp, History } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { apiService, getApiData } from '@/lib/apiService';
import { getThumbnailUrl, getImageUrl } from '@/lib/imageUtils';
import { InventoryHistoryDialog } from '@/components/InventoryHistoryDialog';
import { StoreCredit } from '@/components/StoreCredit';
import { usePositiveSumOrgs } from '@/hooks/positiveSum/usePositiveSumOrgs';

interface Message {
  id: string;
  role: 'user' | 'agent';
  content: string;
  timestamp: Date;
  suggestions?: string[];
  products?: ProductInfo[];
  showProductCards?: boolean;
}

interface ProductInfo {
  id: string;
  name: string;
  price: number;
  availability: 'in-stock' | 'low-stock' | 'out-of-stock';
  description?: string;
  unit?: string;
  current_quantity?: number;
  image_url?: string;
}

interface Part {
  id: string;
  name: string;
  description: string | null;
  current_quantity: number;
  minimum_quantity: number | null;
  cost_per_unit: number | null;
  unit: string | null;
  sellable: boolean;
  image_url: string | null;
  created_at?: string;
}

export default function SariSariChat() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const positiveSumOrgs = usePositiveSumOrgs();
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputMessage, setInputMessage] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [conversationHistory, setConversationHistory] = useState<any[]>([]);
  const [expandedCards, setExpandedCards] = useState<Set<string>>(new Set());
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Use TanStack Query for sellable products with caching and refresh
  const {
    data: availableProducts = [],
    isLoading: loadingProducts,
    error: productsError,
    refetch: refetchProducts
  } = useQuery({
    queryKey: ['parts', 'sellable'],
    queryFn: async (): Promise<Part[]> => {
      const response = await apiService.get<{ data: Part[] }>('/parts/sellable');
      const sellableProducts = getApiData(response) || [];
      
      return sellableProducts;
    },
    staleTime: 5 * 60 * 1000, // 5 minutes
    gcTime: 10 * 60 * 1000, // 10 minutes (formerly cacheTime)
    retry: 2,
    refetchOnWindowFocus: true, // Refresh when user comes back to the tab
    refetchOnMount: true, // Always fetch fresh data when component mounts
  });

  // Handle products error
  useEffect(() => {
    if (productsError) {
      console.error('❌ Error fetching products:', productsError);
      toast({
        title: "Error",
        description: "Failed to load available products. Click refresh to try again.",
        variant: "destructive",
      });
    }
  }, [productsError, toast]);

  // Manual refresh function
  const handleRefreshProducts = async () => {
    toast({
      title: "Refreshing Products",
      description: "Loading latest inventory...",
    });
    
    try {
      await refetchProducts();
      toast({
        title: "Products Refreshed",
        description: `Found ${availableProducts.length} available items`,
      });
    } catch (error) {
      toast({
        title: "Refresh Failed",
        description: "Could not refresh products. Please try again.",
        variant: "destructive",
      });
    }
  };

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  useEffect(() => {
    // Initialize session and get welcome message
    initializeChat();
  }, []);

  const initializeChat = async () => {
    try {
      const welcomeMessage: Message = {
        id: 'welcome-1',
        role: 'agent',
        content: "Welcome to ![Stargazer Farm](/stargazer-farm-logo.svg). What brings you here?",
        timestamp: new Date(),
        suggestions: [
          "Show me available products",
          "What's new?"
        ]
      };
      
      setMessages([welcomeMessage]);
      setSessionId('live-session-' + Date.now());
      
      toast({
        title: "Connected to Sari Sari Store",
        description: "Browse our real inventory and chat with our assistant!",
      });
    } catch (error) {
      toast({
        title: "Connection Error",
        description: "Unable to load store data.",
        variant: "destructive",
      });
    }
  };

  const sendMessage = async () => {
    if (!inputMessage.trim() || isLoading) return;
    await sendMessageWithText(inputMessage);
  };

  const sendMessageWithText = async (text: string) => {
    if (!text.trim() || isLoading) return;

    const userMessage: Message = {
      id: 'user-' + Date.now(),
      role: 'user',
      content: text,
      timestamp: new Date()
    };

    setMessages(prev => [...prev, userMessage]);
    setInputMessage('');
    setIsLoading(true);

    try {
      const agentResponse = await simulateAgentResponse(text);
      
      const agentMessage: Message = {
        id: 'agent-' + Date.now(),
        role: 'agent',
        content: agentResponse.text,
        timestamp: new Date(),
        suggestions: agentResponse.suggestions,
        products: agentResponse.products
      };

      setMessages(prev => [...prev, agentMessage]);
    } catch (error) {
      toast({
        title: "Error",
        description: "Failed to get response from agent",
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  const convertPartToProductInfo = (part: Part): ProductInfo => {
    const getAvailability = (part: Part): 'in-stock' | 'low-stock' | 'out-of-stock' => {
      if (part.current_quantity <= 0) return 'out-of-stock';
      if (part.minimum_quantity && part.current_quantity <= part.minimum_quantity) return 'low-stock';
      return 'in-stock';
    };

    return {
      id: part.id,
      name: part.name,
      price: part.cost_per_unit || 0,
      availability: getAvailability(part),
      description: part.description || undefined,
      unit: part.unit || undefined,
      current_quantity: part.current_quantity
    };
  };

  const simulateAgentResponse = async (message: string): Promise<{
    text: string;
    suggestions?: string[];
    products?: ProductInfo[];
  }> => {
    try {
      // Call Lambda - it now uses SearchPipeline for all queries
      const response = await apiService.post('/sari-sari/chat', {
        message,
        sessionId,
        conversationHistory
      });
      
      // Extract data from response
      const data = response.data || response;
      
      // Update conversation history
      if (data.conversationHistory) {
        setConversationHistory(data.conversationHistory);
      }

      // Convert products to ProductInfo format
      const products: ProductInfo[] = (data.products || []).map((p: any) => ({
        id: p.id,
        name: p.name,
        price: p.price,
        availability: p.in_stock ? 'in-stock' : 'out-of-stock',
        description: p.description,
        unit: p.unit,
        current_quantity: p.stock_level,
        image_url: p.image_url
      }));
      
      return {
        text: data.response,
        products,
        suggestions: ["Tell me more", "Show similar items"]
      };
    } catch (error) {
      console.error('❌ Chat service error:', error);
      return {
        text: "I'm having trouble right now. Could you try rephrasing or browse our available products?",
        suggestions: ["Show me products", "What's available today?", "Try again"]
      };
    }
  };

  // Convert a Part to the ProductInfo shape used by message cards
  const partToProductInfo = (part: Part): ProductInfo => ({
    id: part.id,
    name: part.name,
    price: part.cost_per_unit || 0,
    availability: part.current_quantity > 0 ? 'in-stock' : 'out-of-stock',
    description: part.description || undefined,
    unit: part.unit || undefined,
    current_quantity: part.current_quantity,
    image_url: part.image_url || undefined,
  });

  const handleSuggestionClick = (suggestion: string) => {
    // Quick actions — serve from cache, no API call
    if (suggestion === "Show me available products" && availableProducts.length > 0) {
      const inStock = availableProducts.filter(p => p.current_quantity > 0);
      const userMsg: Message = {
        id: `user-${Date.now()}`,
        role: 'user',
        content: suggestion,
        timestamp: new Date(),
      };
      const agentMsg: Message = {
        id: `agent-${Date.now()}`,
        role: 'agent',
        content: `Here are our ${inStock.length} available products:`,
        timestamp: new Date(),
        products: inStock.map(partToProductInfo),
        showProductCards: true,
        suggestions: ["What's new?", "Tell me about a product"],
      };
      setMessages(prev => [...prev, userMsg, agentMsg]);
      return;
    }

    if (suggestion === "What's new?" && availableProducts.length > 0) {
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
      const newProducts = availableProducts.filter(p =>
        p.current_quantity > 0 && p.created_at && new Date(p.created_at) >= thirtyDaysAgo
      );
      const userMsg: Message = {
        id: `user-${Date.now()}`,
        role: 'user',
        content: suggestion,
        timestamp: new Date(),
      };
      const agentMsg: Message = {
        id: `agent-${Date.now()}`,
        role: 'agent',
        content: newProducts.length > 0
          ? `We have ${newProducts.length} new product${newProducts.length === 1 ? '' : 's'} added this month:`
          : "No new products added this month, but check out what we have available!",
        timestamp: new Date(),
        products: newProducts.length > 0 ? newProducts.map(partToProductInfo) : undefined,
        showProductCards: newProducts.length > 0,
        suggestions: ["Show me available products", "Tell me about a product"],
      };
      setMessages(prev => [...prev, userMsg, agentMsg]);
      return;
    }

    // Default: send as a regular message to the agent
    setInputMessage(suggestion);
    setTimeout(() => {
      sendMessageWithText(suggestion);
    }, 100);
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  const getAvailabilityColor = (availability: string) => {
    switch (availability) {
      case 'in-stock': return 'bg-green-500';
      case 'low-stock': return 'bg-yellow-500';
      case 'out-of-stock': return 'bg-red-500';
      default: return 'bg-gray-500';
    }
  };

  // Parse markdown images ![alt](url) and render as <img> tags
  const renderMessageContent = (text: string) => {
    const parts: (string | React.ReactElement)[] = [];
    const imageRegex = /!\[([^\]]*)\]\(([^)]+)\)/g;
    let lastIndex = 0;
    let match;
    let idx = 0;

    while ((match = imageRegex.exec(text)) !== null) {
      if (match.index > lastIndex) {
        parts.push(text.slice(lastIndex, match.index));
      }
      // If there's text before and after the image on the same line, render inline
      const before = text.slice(0, match.index);
      const after = text.slice(match.index + match[0].length);
      const isInline = (before.length > 0 && !before.endsWith('\n')) || (after.length > 0 && !after.startsWith('\n'));

      // Resolve relative S3 paths but leave absolute/local paths alone
      const imgSrc = match[2].startsWith('/') || match[2].startsWith('http')
        ? match[2]
        : getThumbnailUrl(match[2]) || getImageUrl(match[2]) || match[2];
      const fullSrc = match[2].startsWith('/') || match[2].startsWith('http')
        ? match[2]
        : getImageUrl(match[2]) || match[2];

      parts.push(
        <img
          key={`img-${idx++}`}
          src={imgSrc}
          alt={match[1]}
          onClick={() => { if (imgSrc !== fullSrc) window.open(fullSrc, '_blank'); }}
          className={isInline ? 'inline-block align-middle h-[2.4em]' : 'max-w-full rounded-lg my-2 cursor-pointer'}
          style={isInline ? undefined : { maxHeight: '300px', objectFit: 'contain' as const }}
          onError={(e) => {
            const target = e.target as HTMLImageElement;
            if (fullSrc && target.src !== fullSrc) {
              target.src = fullSrc;
            }
          }}
        />
      );
      lastIndex = match.index + match[0].length;
    }

    if (lastIndex < text.length) {
      parts.push(text.slice(lastIndex));
    }

    // Second pass: process **bold** in string segments
    const finalParts: (string | React.ReactElement)[] = [];
    const boldRegex = /\*\*(.+?)\*\*/g;
    for (const part of (parts.length > 0 ? parts : [text])) {
      if (typeof part !== 'string') {
        finalParts.push(part);
        continue;
      }
      let boldLastIndex = 0;
      let boldMatch;
      while ((boldMatch = boldRegex.exec(part)) !== null) {
        if (boldMatch.index > boldLastIndex) {
          finalParts.push(part.slice(boldLastIndex, boldMatch.index));
        }
        finalParts.push(
          <span key={`bold-${idx++}`} className="font-semibold text-base">{boldMatch[1]}</span>
        );
        boldLastIndex = boldMatch.index + boldMatch[0].length;
      }
      if (boldLastIndex < part.length) {
        finalParts.push(part.slice(boldLastIndex));
      }
      boldRegex.lastIndex = 0;
    }

    return finalParts.length > 0 ? finalParts : text;
  };

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="border-b bg-card">
        <div className="flex items-center justify-between p-4">
          <div className="flex items-center gap-4">
            <Button
              onClick={() => navigate('/dashboard')}
              variant="outline"
              size="sm"
            >
              <ArrowLeft className="h-4 w-4 mr-2" />
              Back to Dashboard
            </Button>
            <div className="min-w-0">
              <h1 className="text-2xl font-bold flex items-center gap-2">
                <img src="/stargazer-farm-logo.svg" alt="Stargazer Farm" className="h-6 w-6" />
                Stargazer Farm
              </h1>
              {positiveSumOrgs.map(org => (
                <StoreCredit key={org.id} orgId={org.id} orgName={positiveSumOrgs.length > 1 ? org.name : ''} />
              ))}
            </div>
          </div>
        </div>
      </header>

      {/* Chat Interface */}
      <main className="flex flex-col h-[calc(100vh-80px)]">
        {/* Messages Area */}
        <ScrollArea className="flex-1 p-4">
          <div className="max-w-4xl mx-auto space-y-4">
            {messages.map((message) => (
              <div
                key={message.id}
                className={`flex gap-3 ${
                  message.role === 'user' ? 'justify-end' : 'justify-start'
                }`}
              >
                <div
                  className={`flex gap-3 max-w-[80%] ${
                    message.role === 'user' ? 'flex-row-reverse' : 'flex-row'
                  }`}
                >
                  <div
                    className={`w-8 h-8 rounded-full flex items-center justify-center ${
                      message.role === 'user'
                        ? 'bg-blue-500 text-white'
                        : 'bg-white border'
                    }`}
                  >
                    {message.role === 'user' ? (
                      <User className="h-4 w-4" />
                    ) : (
                      <img src="/stargazer-farm-logo.svg" alt="Stargazer Farm" className="h-5 w-5" />
                    )}
                  </div>
                  <div className="space-y-2">
                    <Card
                      className={`${
                        message.role === 'user'
                          ? 'bg-blue-500 text-white'
                          : 'bg-card'
                      }`}
                    >
                      <CardContent className="p-3">
                        <div className="text-sm whitespace-pre-wrap">{renderMessageContent(message.content)}</div>
                        <p className="text-xs opacity-70 mt-1">
                          {message.timestamp.toLocaleTimeString()}
                        </p>
                      </CardContent>
                    </Card>

                    {/* History buttons for agent responses with inline products */}
                    {!message.showProductCards && message.products && message.products.length > 0 && (
                      <div className="flex flex-wrap gap-2">
                        {message.products.map((product) => (
                          <InventoryHistoryDialog key={product.id} partId={product.id} partName={product.name} observationsOnly>
                            <Button size="sm" variant="outline" className="h-7 text-xs">
                              <History className="h-3 w-3 mr-1" />
                              {product.name} History
                            </Button>
                          </InventoryHistoryDialog>
                        ))}
                      </div>
                    )}

                    {/* Product cards — only for local shortcut messages */}
                    {message.showProductCards && message.products && message.products.length > 0 && (
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                        {message.products.map((product) => {
                          const isExpanded = expandedCards.has(product.id);
                          const toggleExpand = () => {
                            setExpandedCards(prev => {
                              const next = new Set(prev);
                              if (next.has(product.id)) next.delete(product.id);
                              else next.add(product.id);
                              return next;
                            });
                          };
                          return (
                          <Card key={product.id} className="border overflow-hidden cursor-pointer" onClick={toggleExpand}>
                            <CardContent className="p-0">
                              <div className="p-3 pb-1 flex justify-between items-center">
                                <h4 className="font-medium text-sm">{product.name}</h4>
                                {isExpanded ? <ChevronUp className="h-3 w-3 text-muted-foreground" /> : <ChevronDown className="h-3 w-3 text-muted-foreground" />}
                              </div>
                              <div className="w-full h-32 bg-gradient-to-br from-green-50 to-green-100 flex items-center justify-center overflow-hidden">
                                {product.image_url ? (
                                  <img 
                                    src={getThumbnailUrl(product.image_url) || ''}
                                    alt={product.name}
                                    className="w-full h-full object-contain"
                                  />
                                ) : (
                                  <div className="text-4xl">🌿</div>
                                )}
                              </div>
                              <div className="p-3 pt-2 pb-2">
                                <span className="text-xs text-muted-foreground">
                                  ₱{product.price.toFixed(2)}{product.unit ? `/${product.unit}` : ''}
                                </span>
                              </div>
                              {isExpanded && (
                                <div className="px-3 pb-3 border-t">
                                  <p className="text-xs text-muted-foreground mt-2 mb-3">
                                    {product.description}
                                  </p>
                                  <InventoryHistoryDialog partId={product.id} partName={product.name} observationsOnly>
                                    <Button size="sm" variant="outline" className="w-full h-7 text-xs" onClick={(e) => e.stopPropagation()}>
                                      <History className="h-3 w-3 mr-1" />
                                      View History
                                    </Button>
                                  </InventoryHistoryDialog>
                                </div>
                              )}
                            </CardContent>
                          </Card>
                          );
                        })}
                      </div>
                    )}

                    {/* Suggestions */}
                    {message.suggestions && message.suggestions.length > 0 && (
                      <div className="flex flex-wrap gap-2">
                        {message.suggestions.map((suggestion, index) => (
                          <Button
                            key={index}
                            variant="outline"
                            size="sm"
                            onClick={() => handleSuggestionClick(suggestion)}
                            className="text-xs"
                          >
                            {suggestion}
                          </Button>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            ))}
            
            {isLoading && (
              <div className="flex justify-start">
                <div className="flex gap-3">
                  <div className="w-8 h-8 rounded-full bg-white border flex items-center justify-center">
                    <img src="/stargazer-farm-logo.svg" alt="Stargazer Farm" className="h-5 w-5" />
                  </div>
                  <Card className="bg-card">
                    <CardContent className="p-3">
                      <div className="flex items-center gap-2">
                        <Loader2 className="h-4 w-4 animate-spin" />
                        <span className="text-sm text-muted-foreground">
                          Agent is thinking...
                        </span>
                      </div>
                    </CardContent>
                  </Card>
                </div>
              </div>
            )}
            
            <div ref={messagesEndRef} />
          </div>
        </ScrollArea>

        {/* Input Area */}
        <div className="border-t bg-card p-4">
          <div className="max-w-4xl mx-auto">
            <div className="flex gap-2">
              <Input
                value={inputMessage}
                onChange={(e) => setInputMessage(e.target.value)}
                onKeyPress={handleKeyPress}
                placeholder="Ask about products, prices, or add items to cart..."
                disabled={isLoading}
                className="flex-1"
              />
              <Button
                onClick={sendMessage}
                disabled={!inputMessage.trim() || isLoading}
                size="sm"
              >
                <Send className="h-4 w-4" />
              </Button>
            </div>
            <p className="text-xs text-muted-foreground mt-2 text-center">
              {loadingProducts 
                ? 'Loading products...' 
                : `Showing ${availableProducts.length} available products from your inventory${productsError ? ' (Error - click refresh)' : ''}`
              }
            </p>
          </div>
        </div>
      </main>
    </div>
  );
}