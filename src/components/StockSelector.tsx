import { useState } from "react";
import { useQuery } from '@tanstack/react-query';
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Search, Plus, X, Package } from "lucide-react";
import { partsQueryConfig } from '@/lib/assetQueryConfigs';

import { useToast } from "@/hooks/use-toast";

interface StockItem {
  id: string;
  name: string;
  category?: string;
  unit?: string;
  current_quantity: number;
}

interface SelectedStockItem {
  part_id: string;
  quantity: number;
  part_name: string;
}

interface StockSelectorProps {
  selectedStock: SelectedStockItem[];
  onStockChange: (stock: SelectedStockItem[]) => void;
  onStockClick?: (partId: string) => void;
}

export function StockSelector({ selectedStock, onStockChange, onStockClick }: StockSelectorProps) {
  const [searchTerm, setSearchTerm] = useState("");
  const [showSearch, setShowSearch] = useState(false);
  const [inputValues, setInputValues] = useState<Record<string, string>>({});
  const { toast } = useToast();

  // Subscribe to parts cache. If empty, trigger a fetch so the selector works
  // even when opened without visiting Combined Assets first.
  const { data: allParts = [] } = useQuery<any[]>({
    ...partsQueryConfig,
    enabled: true,
    staleTime: 5 * 60 * 1000, // 5 minutes
  });
  const loading = false;

  // Filter parts with current_quantity > 0
  const stockItems: StockItem[] = allParts.filter((part: any) => part.current_quantity > 0);

  // Enhanced search - search name, category, and description
  const filteredStock = stockItems.filter(item => {
    if (!searchTerm) return true; // Show all when no search term
    
    const searchLower = searchTerm.toLowerCase().trim();
    const itemName = (item.name || '').toLowerCase();
    const itemCategory = (item.category || '').toLowerCase();
    
    return (
      itemName.includes(searchLower) ||
      itemCategory.includes(searchLower)
    );
  });

  const addStockItem = (item: StockItem) => {
    const isAlreadySelected = selectedStock.some(selected => selected.part_id === item.id);
    
    if (!isAlreadySelected) {
      const newStockItem: SelectedStockItem = {
        part_id: item.id,
        quantity: 0.1,
        part_name: item.name
      };
      onStockChange([...selectedStock, newStockItem]);
      setShowSearch(false);
      setSearchTerm("");
    }
  };

  const removeStockItem = (partId: string) => {
    onStockChange(selectedStock.filter(item => item.part_id !== partId));
  };

  const updateQuantity = (partId: string, quantity: number) => {
    if (quantity <= 0) {
      removeStockItem(partId);
      return;
    }
    
    onStockChange(selectedStock.map(item => 
      item.part_id === partId 
        ? { ...item, quantity }
        : item
    ));
  };

  const handleQuantityChange = (partId: string, value: string) => {
    // Update local input state immediately for responsive editing
    setInputValues(prev => ({ ...prev, [partId]: value }));
    
    // Parse and update the actual quantity if valid
    const numValue = parseFloat(value);
    if (!isNaN(numValue) && numValue > 0) {
      updateQuantity(partId, numValue);
    }
  };

  const handleQuantityBlur = (partId: string, value: string) => {
    // On blur, ensure we have a valid value
    const numValue = parseFloat(value);
    if (isNaN(numValue) || numValue <= 0) {
      updateQuantity(partId, 0.1);
      setInputValues(prev => ({ ...prev, [partId]: '0.1' }));
    } else {
      setInputValues(prev => ({ ...prev, [partId]: value }));
    }
  };

  return (
    <div className="space-y-3">
      {/* Selected Stock */}
      {selectedStock.length > 0 && (
        <div className="space-y-2">
          {selectedStock.map((stockItem) => (
            <div key={stockItem.part_id} className="flex items-center gap-2 p-2 border rounded-lg">
              <div 
                className="flex items-center gap-2 flex-1 cursor-pointer hover:bg-muted/50 rounded -m-2 p-2"
                onClick={() => onStockClick?.(stockItem.part_id)}
              >
                <Package className="w-4 h-4 text-muted-foreground" />
                <span className="font-medium">{stockItem.part_name}</span>
              </div>
              
              <div className="flex items-center gap-2">
                <Input
                  type="number"
                  min="0.01"
                  step="0.01"
                  value={inputValues[stockItem.part_id] ?? stockItem.quantity.toString()}
                  onChange={(e) => handleQuantityChange(stockItem.part_id, e.target.value)}
                  onBlur={(e) => handleQuantityBlur(stockItem.part_id, e.target.value)}
                  className="w-20"
                  placeholder="0.1"
                  inputMode="decimal"
                  onClick={(e) => e.stopPropagation()}
                />
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={(e) => {
                    e.stopPropagation();
                    removeStockItem(stockItem.part_id);
                  }}
                >
                  <X className="w-4 h-4" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Add Stock Button */}
      <div className="flex gap-2">
        <Button
          type="button"
          variant="outline"
          onClick={() => setShowSearch(true)}
          className="flex-1"
        >
          <Search className="w-4 h-4 mr-2" />
          Search Stock
        </Button>
      </div>

      {/* Search Interface */}
      {showSearch && (
        <Card className="p-4">
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h4 className="font-medium">Search Stock Items</h4>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setShowSearch(false);
                  setSearchTerm("");
                }}
              >
                <X className="w-4 h-4" />
              </Button>
            </div>
            
            <div className="relative">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search stock by name or category..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="pl-10"
              />
            </div>

            {loading ? (
              <div className="text-center py-4">Loading stock items...</div>
            ) : (
              <div className="max-h-64 overflow-y-auto space-y-2">
                {filteredStock.length === 0 ? (
                  <div className="text-center py-4 text-muted-foreground">
                    {searchTerm ? 'No stock items found matching your search' : 'No stock items available'}
                  </div>
                ) : (
                  filteredStock.map((item) => {
                    const isSelected = selectedStock.some(selected => selected.part_id === item.id);
                    
                    return (
                      <div
                        key={item.id}
                        className={`flex items-center justify-between p-3 border rounded-lg hover:bg-muted/50 cursor-pointer ${
                          isSelected ? 'bg-muted/50 opacity-50' : ''
                        }`}
                        onClick={() => !isSelected && addStockItem(item)}
                      >
                        <div className="flex-1">
                          <p className="font-medium">{item.name}</p>
                          <div className="flex items-center gap-2 text-sm text-muted-foreground">
                            {item.category && (
                              <Badge variant="outline" className="text-xs">
                                {item.category}
                              </Badge>
                            )}
                            <span>{item.current_quantity} {item.unit || 'units'} available</span>
                          </div>
                        </div>
                        {!isSelected && (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={(e) => {
                              e.stopPropagation();
                              addStockItem(item);
                            }}
                          >
                            <Plus className="w-4 h-4" />
                          </Button>
                        )}
                      </div>
                    );
                  })
                )}
              </div>
            )}
          </div>
        </Card>
      )}
    </div>
  );
}