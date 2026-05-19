import { useState, useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Search, Plus, X, Wrench } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useToolsData } from "@/hooks/tools/useToolsData";
import { getThumbnailUrl } from '@/lib/imageUtils';

interface Asset {
  id: string;
  name: string;
  status?: string | null;
  legacy_storage_vicinity?: string | null;
  serial_number?: string | null;
  storage_location?: string | null;
  image_url?: string | null;
  description?: string | null;
  category?: string | null;
}

interface AssetSelectorProps {
  formData: any;
  setFormData: (data: any) => void;
  onAssetClick?: (assetId: string) => void;
}

export function AssetSelector({ formData, setFormData, onAssetClick }: AssetSelectorProps) {
  const [selectedAssets, setSelectedAssets] = useState<string[]>([]);
  const [selectedAssetDetails, setSelectedAssetDetails] = useState<Asset[]>([]);
  const [searchTerm, setSearchTerm] = useState("");
  const [showSearch, setShowSearch] = useState(false);
  const { toast } = useToast();
  const { tools: assets, loading, activeCheckouts } = useToolsData();
  // Track if we're updating from user action to prevent useEffect from overwriting
  const isUserUpdateRef = useRef(false);
  // Track the expected formData state after user update to prevent race conditions
  const expectedFormDataRef = useRef<string | null>(null);
  
  useEffect(() => {
    fetchSelectedAssetDetails();
  }, [selectedAssets, assets.length]); // Use assets.length instead of assets array

  // Log all available tools when component loads (for debugging) - only once
  useEffect(() => {
    // Assets loaded
  }, [assets.length, loading]);

  // Initialize from formData.required_tools
  // Use a ref to track the last processed formData to prevent unnecessary re-syncs
  const lastFormDataRef = useRef<string>('');
  
  useEffect(() => {
    if (loading || assets.length === 0 || !formData?.required_tools) return;
    
    // Skip sync if we're in the middle of a user-initiated update
    if (isUserUpdateRef.current) {
      // Check if formData matches what we expect (user update completed)
      const currentFormDataStr = JSON.stringify([...formData.required_tools].sort());
      if (expectedFormDataRef.current && currentFormDataStr === expectedFormDataRef.current) {
        // User update completed, reset flags and allow sync
        isUserUpdateRef.current = false;
        expectedFormDataRef.current = null;
        // Continue to sync below
      } else {
        // Still waiting for user update to complete
        return;
      }
    }
    
    const toolIds = Array.isArray(formData.required_tools) ? formData.required_tools : [];
    const currentFormDataStr = JSON.stringify([...toolIds].sort());
    
    // Skip if formData hasn't actually changed (prevents unnecessary re-syncs when assets change)
    if (lastFormDataRef.current === currentFormDataStr) {
      return;
    }
    
    const identifiers = toolIds
      .map((toolId: string) => {
        const tool = assets.find(a => a.id === toolId);
        return tool?.serial_number || tool?.id;
      })
      .filter(Boolean) as string[];
    
    // Use functional update to get latest selectedAssets without adding it to deps
    setSelectedAssets(prev => {
      const currentStr = JSON.stringify([...prev].sort());
      const newStr = JSON.stringify([...identifiers].sort());
      
      if (currentStr !== newStr) {
        lastFormDataRef.current = currentFormDataStr;
        return identifiers;
      }
      return prev;
    });
  }, [formData?.required_tools, assets.length, loading, assets]);

  const fetchSelectedAssetDetails = () => {
    if (selectedAssets.length === 0) {
      setSelectedAssetDetails([]);
      return;
    }
    
    // Get the actual tool IDs from formData.required_tools (source of truth)
    const toolIds = Array.isArray(formData?.required_tools) ? formData.required_tools : [];
    
    // Find assets by their actual IDs from required_tools, not by identifier
    // This ensures we show the correct assets even if there are serial number conflicts
    const details = toolIds
      .map((toolId: string) => {
        // Find asset by ID (this is what's actually stored in required_tools)
        const asset = assets.find(a => a.id === toolId);
        if (!asset) {
          console.warn('AssetSelector: Tool ID in required_tools not found in assets:', toolId);
        }
        return asset;
      })
      .filter((asset: any): asset is Asset => asset !== undefined);
    
    setSelectedAssetDetails(details);
  };

  // Deduplicate assets by id to prevent duplicates from multiple checkouts
  const uniqueAssets = Array.from(
    new Map(assets.map(asset => [asset.id, asset])).values()
  );
  
  // Filter assets by search term - search name, serial number, category, and description
  // Also handle word boundaries and partial matches better
  const filteredAssets = uniqueAssets.filter(asset => {
    if (!searchTerm) return true; // Show all when no search term
    
    const searchLower = searchTerm.toLowerCase().trim();
    const assetName = (asset.name || '').toLowerCase();
    const assetSerial = (asset.serial_number || '').toLowerCase();
    const assetCategory = (asset.category || '').toLowerCase();
    const assetDescription = (asset.description || '').toLowerCase();
    
    // Check if search term appears anywhere in name, serial, category, or description
    return (
      assetName.includes(searchLower) ||
      assetSerial.includes(searchLower) ||
      assetCategory.includes(searchLower) ||
      assetDescription.includes(searchLower)
    );
  });
  
  // Debug logging to help diagnose search issues
  useEffect(() => {
    if (searchTerm) {
      const searchLower = searchTerm.toLowerCase();
      const matchingTools = uniqueAssets.filter(asset => {
        const nameMatch = asset.name.toLowerCase().includes(searchLower);
        const serialMatch = asset.serial_number && asset.serial_number.toLowerCase().includes(searchLower);
        const categoryMatch = asset.category && asset.category.toLowerCase().includes(searchLower);
        const descMatch = asset.description && asset.description.toLowerCase().includes(searchLower);
        return nameMatch || serialMatch || categoryMatch || descMatch;
      });
    }
  }, [searchTerm, uniqueAssets.length, filteredAssets.length]);

  const addAsset = (asset: Asset) => {
    const identifier = asset.serial_number || asset.id;
    
    // Use functional update to avoid stale closure issues
    setFormData((prev: any) => {
      const currentRequiredTools = Array.isArray(prev.required_tools) 
        ? prev.required_tools 
        : [];
      
      if (currentRequiredTools.includes(asset.id)) {
        toast({ 
          title: "Tool Already Added", 
          description: "This tool is already in the list",
          variant: "default"
        });
        return prev;
      }

      return {
        ...prev,
        required_tools: [...currentRequiredTools, asset.id]
      };
    });
    
    setSelectedAssets(prev => {
      if (prev.includes(identifier)) {
        return prev;
      }
      return [...prev, identifier];
    });
    
    setShowSearch(false);
    setSearchTerm("");
  };

  const removeAsset = (serialNumberOrId: string, assetFromDisplay?: Asset) => {
    // Mark that we're doing a user-initiated update to prevent useEffect from overwriting
    isUserUpdateRef.current = true;
    
    // Find asset by serial_number or id - this is the asset being displayed
    const displayedAsset = assets.find(a => a.serial_number === serialNumberOrId || a.id === serialNumberOrId);
    
    // Find which asset in selectedAssetDetails matches (this is what's actually displayed)
    const assetToRemove = selectedAssetDetails.find(a => {
      const assetId = a.serial_number || a.id;
      return assetId === serialNumberOrId;
    });
    
    if (!displayedAsset && !assetToRemove) {
      // Asset not found - still try to remove from UI and formData by identifier
      const identifier = serialNumberOrId;
      
      // Update UI state immediately for instant feedback
      setSelectedAssets(prev => prev.filter(id => id !== identifier));
      setSelectedAssetDetails(prev => prev.filter(a => {
        const assetId = a.serial_number || a.id;
        return assetId !== identifier;
      }));
      
      // Update formData by removing any tool with matching id or serial_number
      setFormData((prev: any) => {
        const currentRequiredTools = Array.isArray(prev.required_tools) 
          ? prev.required_tools 
          : [];
        // Remove by matching the identifier (could be id or serial_number)
        const updatedRequiredTools = currentRequiredTools.filter((toolId: string) => {
          // Check if this toolId matches the identifier or if we can find the tool
          if (toolId === serialNumberOrId) return false;
          const tool = assets.find(a => a.id === toolId);
          if (tool && (tool.serial_number === serialNumberOrId || tool.id === serialNumberOrId)) {
            return false;
          }
          return true;
        });
        
        // Store expected formData state so useEffect knows when update is complete
        expectedFormDataRef.current = JSON.stringify([...updatedRequiredTools].sort());
        
        return {
          ...prev,
          required_tools: updatedRequiredTools
        };
      });
      return;
    }
    
    // Use the asset from the display (passed as parameter) or selectedAssetDetails to get the correct ID
    // This ensures we remove the right asset even if there's a mismatch
    // Priority: assetFromDisplay (what user clicked) > assetToRemove (from selectedAssetDetails) > displayedAsset (found by lookup)
    const assetIdToRemove = assetFromDisplay?.id || assetToRemove?.id || displayedAsset?.id;
    const identifier = assetFromDisplay?.serial_number || assetFromDisplay?.id || displayedAsset?.serial_number || displayedAsset?.id || serialNumberOrId;
    
    if (!assetIdToRemove) {
      console.error('AssetSelector: Could not determine asset ID to remove', {
        serialNumberOrId,
        assetFromDisplay,
        displayedAsset,
        assetToRemove,
        selectedAssetDetails
      });
      return;
    }
    
    // Update UI state immediately for instant feedback
    setSelectedAssets(prev => prev.filter(id => id !== identifier));
    setSelectedAssetDetails(prev => prev.filter(a => {
      const assetId = a.serial_number || a.id;
      return assetId !== identifier;
    }));
    
    // Update formData (this is the source of truth) - remove by the actual ID in required_tools
    setFormData((prev: any) => {
      const currentRequiredTools = Array.isArray(prev.required_tools) 
        ? prev.required_tools 
        : [];
      
      // Remove by the asset ID - this should match what's in required_tools
      const updatedRequiredTools = currentRequiredTools.filter((toolId: string) => toolId !== assetIdToRemove);
      
      // Store expected formData state so useEffect knows when update is complete
      expectedFormDataRef.current = JSON.stringify([...updatedRequiredTools].sort());
      
      return {
        ...prev,
        required_tools: updatedRequiredTools
      };
    });
  };

  return (
    <div className="space-y-3">
      {/* Selected Assets - Show first */}
      {selectedAssetDetails.length > 0 && (
        <div className="space-y-2">
          {selectedAssetDetails.map((asset) => (
            <div key={asset.id} className="flex items-center justify-between p-2 border rounded-lg bg-muted/30">
              <div 
                className="flex items-center gap-3 flex-1 cursor-pointer hover:bg-muted/50 rounded -m-2 p-2"
                onClick={() => onAssetClick?.(asset.id)}
              >
                {asset.image_url && (
                  <img 
                    src={getThumbnailUrl(asset.image_url) || ''}
                    alt={asset.name}
                    className="w-12 h-12 object-cover rounded"
                  />
                )}
                {!asset.image_url && <Wrench className="w-4 h-4 text-muted-foreground" />}
                <div>
                  <p className="font-medium">{asset.name}</p>
                  {asset.serial_number && (
                    <p className="text-sm text-muted-foreground">Serial: {asset.serial_number}</p>
                  )}
                </div>
              </div>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-auto p-1 flex-shrink-0"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  // Pass both the identifier and the asset itself for more reliable removal
                  removeAsset(asset.serial_number || asset.id, asset);
                }}
              >
                <X className="w-4 h-4" />
              </Button>
            </div>
          ))}
        </div>
      )}

      {/* Add Asset Button or Search Input - Show below selected assets */}
      {!showSearch ? (
        <Button
          type="button"
          variant="outline"
          onClick={() => setShowSearch(true)}
          className="flex-1"
        >
          <Search className="w-4 h-4 mr-2" />
          Add Asset
        </Button>
      ) : (
        <div className="relative">
          <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search assets by name, serial number, or category..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="pl-10 pr-10"
            autoFocus
          />
          <Button
            variant="ghost"
            size="sm"
            className="absolute right-1 top-1/2 transform -translate-y-1/2 h-7 w-7 p-0"
            onClick={() => {
              setShowSearch(false);
              setSearchTerm("");
            }}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      )}

      {/* Search Results - Show inline when searching */}
      {showSearch && (
        <div className="space-y-2">
          {loading ? (
            <div className="text-center py-4">Loading assets...</div>
          ) : (
            <div className="max-h-64 overflow-y-auto space-y-2">
              {filteredAssets.length === 0 ? (
                <div className="text-center py-4 text-muted-foreground">
                  {searchTerm ? 'No assets found matching your search' : 'Start typing to search...'}
                </div>
              ) : (
                filteredAssets.map((asset) => (
                  <div
                    key={asset.id}
                    className="flex items-center justify-between p-3 border rounded-lg hover:bg-muted/50 cursor-pointer"
                    onClick={() => addAsset(asset)}
                  >
                    <div className="flex-1">
                      <p className="font-medium">
                        {asset.name}
                        {asset.serial_number && (
                          <span className="text-xs text-muted-foreground ml-2">
                            {asset.serial_number}
                          </span>
                        )}
                      </p>
                      <div className="flex items-center gap-2 text-sm text-muted-foreground">
                        {asset.legacy_storage_vicinity && (
                          <span>{asset.legacy_storage_vicinity}</span>
                        )}
                        {asset.storage_location && (
                          <span>• {asset.storage_location}</span>
                        )}
                        {activeCheckouts[asset.id] && (
                          <span>• Checked out to {activeCheckouts[asset.id].user_name}</span>
                        )}
                      </div>
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={(e) => {
                        e.stopPropagation();
                        addAsset(asset);
                      }}
                    >
                      <Plus className="w-4 h-4" />
                    </Button>
                  </div>
                ))
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}