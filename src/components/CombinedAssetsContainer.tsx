import { useState, useMemo, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Button } from "@/components/ui/button";
import { apiService, getApiData } from '@/lib/apiService';
import { partsOrdersQueryKey } from '@/lib/queryKeys';
import { offlineQueryConfig } from '@/lib/queryConfig';
import { useAssetMutations } from '@/hooks/useAssetMutations';
import { ArrowLeft, Plus, BarChart3 } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { CombinedAssetFilters } from "./CombinedAssetFilters";
import { CombinedAssetGrid } from "./CombinedAssetGrid";
import { CombinedAssetDialog } from "./CombinedAssetDialog";
import { ToolCheckoutDialog } from "./ToolCheckoutDialog";
import { ToolCheckInDialog } from "./ToolCheckInDialog";
import { ToolRemovalDialog } from "./tools/ToolRemovalDialog";
import { EditToolForm } from "./tools/forms/EditToolForm";

import { ToolDetails } from "./tools/ToolDetails";
import { StockDetails } from "./StockDetails";
import { OrderDialog } from "./OrderDialog";
import { ReceivingDialog } from "./ReceivingDialog";
import { useCombinedAssets, CombinedAsset } from "@/hooks/useCombinedAssets";
import { useAuth } from "@/hooks/useCognitoAuth";
import { useToast } from "@/hooks/use-toast";
import { useToolHistory } from "@/hooks/tools/useToolHistory";
import { useOrganizationId } from "@/hooks/useOrganizationId";
import { useImageUpload } from "@/hooks/useImageUpload";
import { useOrganizationMembers } from "@/hooks/useOrganizationMembers";
import { InventoryItemForm } from "./InventoryItemForm";
import { getImageUrl, getThumbnailUrl } from '@/lib/imageUtils';
import { MaxwellInlinePanel } from "@/components/MaxwellInlinePanel";
import { PrismIcon } from "@/components/icons/PrismIcon";
import { EntityContext } from "@/hooks/useEntityContext";


export const CombinedAssetsContainer = () => {
  const navigate = useNavigate();
  const { user, canEditTools, isAdmin } = useAuth();
  
  // Handle URL parameters for backward compatibility
  const urlParams = new URLSearchParams(window.location.search);
  const viewParam = urlParams.get('view');
  const showLowStockParam = urlParams.get('showLowStock') === 'true';
  const editParam = urlParams.get('edit');
  const searchParam = urlParams.get('search') || '';
  const { toast } = useToast();
  const { updatePart, updateTool, createPartsHistory, deletePart } = useAssetMutations();
  const organizationId = useOrganizationId();
  const { uploadImages, isUploading } = useImageUpload();
  const [searchTerm, setSearchTerm] = useState(searchParam);
  const [semanticResults, setSemanticResults] = useState<CombinedAsset[]>([]);
  const [isSemanticSearching, setIsSemanticSearching] = useState(false);
  const [showMyCheckedOut, setShowMyCheckedOut] = useState(false);
  const [showLowStock, setShowLowStock] = useState(showLowStockParam);
  const [showOnlyAssets, setShowOnlyAssets] = useState(false);
  const [showOnlyStock, setShowOnlyStock] = useState(viewParam === 'stock');
  const [showOnlyAreas, setShowOnlyAreas] = useState(false);
  
  // Clear semantic results when area filter is toggled
  useEffect(() => {
    if (showOnlyAreas && semanticResults.length > 0) {
      setSemanticResults([]);
    }
  }, [showOnlyAreas]);
  const [showRemovedItems, setShowRemovedItems] = useState(false);
  const [searchDescriptions, setSearchDescriptions] = useState(false);
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [showCheckoutDialog, setShowCheckoutDialog] = useState(false);
  const [showCheckinDialog, setShowCheckinDialog] = useState(false);
  const [showRemovalDialog, setShowRemovalDialog] = useState(false);
  const [showEditDialog, setShowEditDialog] = useState(false);
  const [showViewDialog, setShowViewDialog] = useState(false);
  const [selectedAssetId, setSelectedAssetId] = useState<string | null>(null);
  const [selectedAssetForDetails, setSelectedAssetForDetails] = useState<CombinedAsset | null>(null);
  const [isMaxwellOpen, setIsMaxwellOpen] = useState(false);
  const [maxwellDialogAsset, setMaxwellDialogAsset] = useState<CombinedAsset | null>(null);
  
  // Image state for stock editing
  const [selectedImage, setSelectedImage] = useState<File | null>(null);
  const [stockAttachments, setStockAttachments] = useState<string[]>([]);
  const [isUploadingFiles, setIsUploadingFiles] = useState(false);
  
  // Stock dialog states
  const [showQuantityDialog, setShowQuantityDialog] = useState(false);
  const [quantityOperation, setQuantityOperation] = useState<'add' | 'remove'>('add');
  const [showOrderDialog, setShowOrderDialog] = useState(false);
  const [showReceivingDialog, setShowReceivingDialog] = useState(false);
  const [quantityChange, setQuantityChange] = useState({
    amount: '',
    reason: '',
  });



  const [page, setPage] = useState(0);
  const [limit] = useState(50);
  const searchRef = useRef(searchTerm);
  const debounceTimerRef = useRef<number | undefined>(undefined);
  const semanticDebounceTimerRef = useRef<number | undefined>(undefined);
  
  // Memoize options to prevent unnecessary re-renders
  // When showOnlyAreas is enabled, skip search in useCombinedAssets and do it in component instead
  const assetsQueryOptions = useMemo(() => ({
    search: showOnlyAreas ? '' : searchTerm, // Skip search in useCombinedAssets when showing areas
    limit,
    page: showOnlyAreas ? 0 : page, // Reset to page 0 when showing areas
    searchDescriptions,
    showLowStock,
    skipPagination: showOnlyAreas // Get all assets when showing areas (needed for proper filtering)
  }), [searchTerm, limit, page, searchDescriptions, showLowStock, showOnlyAreas]);
  
  const { assets, loading, createAsset, updateAsset, refetch, fetchAssets } = useCombinedAssets(showRemovedItems, assetsQueryOptions);
  const { members: organizationMembers } = useOrganizationMembers();
  const checkoutDisplayNameMap = useMemo(() => {
    const map = new Map<string, string>();
    organizationMembers.forEach(member => {
      if (member.user_id) {
        map.set(member.user_id, member.full_name);
      }
      if (member.id && !map.has(member.id)) {
        map.set(member.id, member.full_name);
      }
    });
    return map;
  }, [organizationMembers]);


  useEffect(() => {
    // Mark container mount once; avoid console.time duplicate label warnings on re-render
    performance.mark('container_mount');
  }, []);
  
  // Tool history for view dialog
  const { toolHistory, currentCheckout, fetchToolHistory } = useToolHistory();

  // Fetch pending orders for stock items using TanStack Query for caching
  const fetchPartsOrders = async () => {
    const result = await apiService.get('/parts_orders');
    return getApiData(result) || [];
  };

  const { data: partsOrders = [] } = useQuery({
    queryKey: partsOrdersQueryKey(),
    queryFn: fetchPartsOrders,
    ...offlineQueryConfig,
  });

  // Group orders by part_id - memoized to avoid recalculation
  const pendingOrders = useMemo(() => {
    const ordersByPart: Record<string, any[]> = {};
    partsOrders.forEach((order: any) => {
      if (!ordersByPart[order.part_id]) {
        ordersByPart[order.part_id] = [];
      }
      ordersByPart[order.part_id].push(order);
    });
    return ordersByPart;
  }, [partsOrders]);

  // Semantic search handler
  const performSemanticSearch = useCallback(async (query: string) => {
    if (!query.trim()) {
      setSemanticResults([]);
      return;
    }

    setIsSemanticSearching(true);
    try {
      // Search both parts and tools
      const [partsResponse, toolsResponse] = await Promise.all([
        apiService.post('/semantic-search', {
          query: query.trim(),
          table: 'parts',
          limit: 10
        }),
        apiService.post('/semantic-search', {
          query: query.trim(),
          table: 'tools',
          limit: 10
        })
      ]);
      
      // CRITICAL: Extract results from API response structure
      // API returns { data: { results: [...] } } NOT just { results: [...] }
      // DO NOT change this without testing semantic search display
      const partsData = partsResponse?.results || partsResponse?.data?.results || [];
      const toolsData = toolsResponse?.results || toolsResponse?.data?.results || [];
      
      // Map API results to CombinedAsset format with type and distance
      const partsResults = partsData.map((r: any) => ({
        ...r,
        type: 'stock' as const,
        similarity_score: r.distance
      }));
      const toolsResults = toolsData.map((r: any) => ({
        ...r,
        type: 'asset' as const,
        similarity_score: r.distance
      }));
      const allResults = [...partsResults, ...toolsResults].sort((a, b) => a.similarity_score - b.similarity_score);
      
      setSemanticResults(allResults);
    } catch (error) {
      console.error('Semantic search failed:', error);
      toast({
        title: "Search Error",
        description: "Semantic search failed. Please try again.",
        variant: "destructive"
      });
      setSemanticResults([]);
    } finally {
      setIsSemanticSearching(false);
    }
  }, [toast, fetchAssets, searchDescriptions, showLowStock]);

  // Consolidated effect to handle all filter changes and prevent race conditions
  useEffect(() => {
    if (debounceTimerRef.current) window.clearTimeout(debounceTimerRef.current);
    debounceTimerRef.current = window.setTimeout(() => {
      // Don't trigger normal search if semantic results are active
      if (semanticResults.length > 0) return;
      
      const term = searchTerm.trim();
      if (term !== searchRef.current) {
        searchRef.current = term;
      }
      
      // Update URL with search term to persist across app switches
      const newUrl = new URL(window.location.href);
      if (term) {
        newUrl.searchParams.set('search', term);
      } else {
        newUrl.searchParams.delete('search');
      }
      window.history.replaceState({}, '', newUrl.toString());
      
      // Reset to page 0 when filters change
      if (page !== 0) {
        setPage(0);
      }
      fetchAssets({
        search: searchRef.current,
        page: 0,
        limit,
        append: false,
        searchDescriptions,
        showLowStock
      });
    }, 250);
    return () => {
      if (debounceTimerRef.current) window.clearTimeout(debounceTimerRef.current);
    };
  }, [searchTerm, showRemovedItems, searchDescriptions, showLowStock, semanticResults.length]);

  // Look up selected asset from cache (check semantic results first, then regular assets)
  const selectedAsset = selectedAssetId 
    ? (semanticResults.find(a => a.id === selectedAssetId) || assets.find(a => a.id === selectedAssetId))
    : null;

  // Compute item counts per area once (efficient - only recalculates when assets change)
  const areaItemCounts = useMemo(() => {
    const counts = new Map<string, number>();
    assets.forEach(asset => {
      if (asset.parent_structure_id) {
        counts.set(asset.parent_structure_id, (counts.get(asset.parent_structure_id) || 0) + 1);
      }
    });
    return counts;
  }, [assets]);

  // Filter assets based on current filters
  const filteredAssets = useMemo(() => {
    // Skip filtering during loading to prevent flicker
    if (loading && assets.length === 0) return [];
    
    // Use semantic results if active, but clear them if type/area filters are enabled
    // (semantic search and type filters are mutually exclusive)
    const assetsToFilter = (semanticResults.length > 0 && !showOnlyAreas && !showOnlyAssets && !showOnlyStock) 
      ? semanticResults 
      : assets;
    
    let filtered = assetsToFilter.filter(asset => {
      // Areas filter - show only Infrastructure/Container tools
      if (showOnlyAreas) {
        if (asset.type !== 'asset') return false;
        const isArea = asset.category === 'Infrastructure' || asset.category === 'Container' || asset.category === 'Field';
        if (!isArea) return false;
      }

      // Type filters
      if (showOnlyAssets && asset.type !== 'asset') return false;
      if (showOnlyStock && asset.type !== 'stock') return false;

      // My checked out filter - only applies to assets
      if (showMyCheckedOut) {
        if (asset.type !== 'asset') return false;
        if (!asset.is_checked_out || asset.checked_out_user_id !== user?.id) return false;
      }

      // Issues filter - removed (issue system deprecated)

      // Apply search filter when Areas Only is enabled (since we skip search in useCombinedAssets)
      if (showOnlyAreas && searchTerm && searchTerm.trim()) {
        const searchLower = searchTerm.trim().toLowerCase();
        const matchesSearch = 
          asset.name?.toLowerCase().includes(searchLower) ||
          asset.serial_number?.toLowerCase().includes(searchLower) ||
          asset.category?.toLowerCase().includes(searchLower) ||
          asset.storage_location?.toLowerCase().includes(searchLower) ||
          (searchDescriptions && asset.description?.toLowerCase().includes(searchLower));
        if (!matchesSearch) return false;
      }

      // Note: Search and low stock filters are handled in useCombinedAssets hook (unless Areas Only is enabled)

      return true;
    });

    // Sort by item count if showing areas
    if (showOnlyAreas) {
      filtered = filtered.sort((a, b) => {
        const countA = areaItemCounts.get(a.id) || 0;
        const countB = areaItemCounts.get(b.id) || 0;
        
        // Sort by count descending, then alphabetically by name
        if (countB !== countA) {
          return countB - countA; // Descending by count
        }
        return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }); // Alphabetical tiebreaker
      });
    }

    return filtered;
  }, [assets, showOnlyAssets, showOnlyStock, showOnlyAreas, showMyCheckedOut, user?.id, loading, semanticResults, areaItemCounts, searchTerm, searchDescriptions]);

  const handleCreateAsset = async (assetData: any, isAsset: boolean) => {
    const result = await createAsset(assetData, isAsset);
    // TanStack Query will automatically update the cache via invalidateQueries
    return result;
  };

  const handleView = useCallback((asset: CombinedAsset) => {
    setSelectedAssetId(asset.id);
    setShowViewDialog(true);
    // Fetch additional data for view dialog if it's an asset
    if (asset.type === 'asset') {
      fetchToolHistory(asset.id);
    }
  }, [fetchToolHistory]);

  const handleEdit = useCallback((asset: CombinedAsset) => {
    setSelectedAssetId(asset.id);
    // Initialize attachments with existing attachments array or image_url
    if (asset.type === 'stock') {
      const existingAttachments = (asset as any).attachments || [];
      const imageUrl = asset.image_url;
      
      // Use attachments array if available, otherwise fall back to image_url
      if (existingAttachments.length > 0) {
        setStockAttachments(existingAttachments);
      } else if (imageUrl) {
        setStockAttachments([imageUrl]);
      } else {
        setStockAttachments([]);
      }
    } else {
      setStockAttachments([]);
    }
    setShowEditDialog(true);
  }, []);

  // Handle edit parameter from URL (backward compatibility)
  useEffect(() => {
    if (editParam && assets.length > 0) {
      const assetToEdit = assets.find(asset => asset.id === editParam);
      if (assetToEdit) {
        handleEdit(assetToEdit);
        // Clear URL parameter
        const newUrl = new URL(window.location.href);
        newUrl.searchParams.delete('edit');
        window.history.replaceState({}, '', newUrl.toString());
      }
    }
  }, [editParam, assets, handleEdit]);

  const handleRemove = useCallback((asset: CombinedAsset) => {
    setSelectedAssetId(asset.id);
    setShowRemovalDialog(true);
  }, []);

  const handleCheckout = useCallback((asset: CombinedAsset) => {
    setSelectedAssetId(asset.id);
    setShowCheckoutDialog(true);
  }, []);

  const handleCheckin = useCallback((asset: CombinedAsset) => {
    setSelectedAssetId(asset.id);
    setShowCheckinDialog(true);
  }, []);

  const handleAskMaxwell = useCallback((asset: CombinedAsset) => {
    setMaxwellDialogAsset(asset);
  }, []);

  const handleAddObservation = useCallback((asset: CombinedAsset) => {
    const assetType = asset.type === 'asset' ? 'tools' : 'parts';
    navigate(`/combined-assets/${assetType}/${asset.id}/observation`);
  }, [navigate]);

  const handleShowAssetDetails = (asset: CombinedAsset) => {
    // This should behave like clicking on the asset card - go to detail view
    setSelectedAssetForDetails(asset);
    if (asset.type === 'asset') {
      fetchToolHistory(asset.id);
    }
  };

  const handleBackToAssets = () => {
    setSelectedAssetForDetails(null);
  };

  // Stock quantity handlers
  const handleAddQuantity = useCallback((asset: CombinedAsset) => {
    setSelectedAssetId(asset.id);
    setQuantityOperation('add');
    setShowQuantityDialog(true);
  }, []);

  const handleUseQuantity = useCallback((asset: CombinedAsset) => {
    setSelectedAssetId(asset.id);
    setQuantityOperation('remove');
    setShowQuantityDialog(true);
  }, []);

  const handleOrderStock = useCallback((asset: CombinedAsset) => {
    setSelectedAssetId(asset.id);
    setShowOrderDialog(true);
  }, []);

  const handleReceiveOrder = useCallback((asset: CombinedAsset) => {
    const orders = pendingOrders[asset.id];
    if (orders && orders.length > 0) {
      setSelectedAssetId(asset.id);
      setShowReceivingDialog(true);
    }
  }, [pendingOrders]);

  // Quantity update handler for stock items
  const updateQuantity = async () => {
    if (!selectedAsset || !quantityChange.amount || !user) return;

    try {
      const change = parseFloat(quantityChange.amount);
      const currentQty = selectedAsset.current_quantity || 0;
      const newQuantity = quantityOperation === 'add' ? currentQty + change : currentQty - change;

      if (newQuantity < 0) {
        toast({
          title: "Error",
          description: "Quantity cannot be negative",
          variant: "destructive",
        });
        return;
      }

      // Update the parts table
      await updatePart.mutateAsync({ id: selectedAsset.id, data: { current_quantity: newQuantity } });

      // Log the change to history
      try {
        // Log the change to history via API
        await createPartsHistory.mutateAsync({
          part_id: selectedAsset.id,
          change_type: quantityOperation === 'add' ? 'quantity_add' : 'quantity_remove',
          old_quantity: currentQty,
          new_quantity: newQuantity,
          quantity_change: quantityOperation === 'add' ? change : -change,
          change_reason: quantityChange.reason || `Quantity ${quantityOperation}ed`,
        });
      } catch (historyError) {
        console.error('History logging failed:', historyError);
      }

      // Note: inventory_usage table doesn't exist - usage is tracked in parts_history above

      toast({
        title: "Success",
        description: `Quantity ${quantityOperation === 'add' ? 'increased' : 'decreased'} successfully`,
      });

      setShowQuantityDialog(false);
      setSelectedAssetId(null);
      setQuantityChange({ amount: '', reason: '' });
    } catch (error) {
      console.error('Error updating quantity:', error);
      toast({
        title: "Error",
        description: "Failed to update quantity",
        variant: "destructive",
      });
    }
  };

  const handleConfirmRemoval = async (reason: string, notes: string) => {
    if (!selectedAsset) return;

    try {
      if (selectedAsset.type === 'asset') {
        // For assets, set status to 'removed'
        await updateTool.mutateAsync({ id: selectedAsset.id, data: { status: 'removed' } });
      } else {
        // For stock items, delete the record like the inventory page
        await deletePart.mutateAsync(selectedAsset.id);
      }

      setShowRemovalDialog(false);
      setSelectedAssetId(null);
      
      toast({
        title: "Success",
        description: `${selectedAsset.type === 'asset' ? 'Asset' : 'Stock item'} removed successfully`,
      });
    } catch (error) {
      console.error('Error removing item:', error);
      toast({
        title: "Error",
        description: `Failed to remove ${selectedAsset.type === 'asset' ? 'asset' : 'stock item'}`,
        variant: "destructive"
      });
    }
  };

  const handleEditSubmit = async (toolId: string, toolData: any) => {
    if (!selectedAsset) return;

    // Close dialog immediately for better UX
    setShowEditDialog(false);
    setSelectedAssetId(null);

    // Show optimistic success toast
    toast({
      title: "Updating...",
      description: `${selectedAsset.type === 'asset' ? 'Asset' : 'Stock item'} is being updated`,
    });

    try {
      if (selectedAsset.type === 'asset') {
        await updateTool.mutateAsync({ id: toolId, data: toolData });
      } else {
        await updatePart.mutateAsync({ id: toolId, data: toolData });
      }
      
      toast({
        title: "Success",
        description: `${selectedAsset.type === 'asset' ? 'Asset' : 'Stock item'} updated successfully`,
      });
    } catch (error) {
      console.error('Error updating item:', error);
      toast({
        title: "Error",
        description: `Failed to update ${selectedAsset.type === 'asset' ? 'asset' : 'stock item'}. Please try again.`,
        variant: "destructive"
      });
    }
  };

  // Optimistic stock edit handler - close immediately, update in background
  const handleStockEditSubmit = async (formData: any, useMinimumQuantity: boolean) => {
    if (!selectedAsset || selectedAsset.type !== 'stock') return;

    // Only use first image from attachments array (parts table only supports single image_url)
    const imageUrl = stockAttachments.length > 0 ? stockAttachments[0] : null;

    const updateData = {
      name: formData.name,
      description: formData.description,
      current_quantity: formData.current_quantity,
      minimum_quantity: useMinimumQuantity ? formData.minimum_quantity : null,
      cost_per_unit: formData.cost_per_unit ? parseFloat(formData.cost_per_unit) : null,
      unit: formData.unit,
      parent_structure_id: formData.parent_structure_id,
      storage_location: formData.storage_location,
      accountable_person_id: formData.accountable_person_id === "none" ? null : formData.accountable_person_id,
      sellable: formData.sellable,
      image_url: imageUrl
    };

    // Close dialog immediately for better UX
    setShowEditDialog(false);
    setSelectedAssetId(null);
    setStockAttachments([]);

    // Show optimistic success toast
    toast({
      title: "Updating...",
      description: "Stock item is being updated",
    });

    try {
      // Use mutation with optimistic updates - TanStack Query handles cache updates
      await updatePart.mutateAsync({ id: selectedAsset.id, data: updateData });
      
      // Show success toast
      toast({
        title: "Success",
        description: "Stock item updated successfully",
      });
    } catch (error) {
      console.error('Error updating stock item:', error);
      toast({
        title: "Error", 
        description: "Failed to update stock item. Please try again.",
        variant: "destructive"
      });
    }
  };

  // Do not early-return on loading; keep previous results visible and show a small indicator
  if (loading) {
    performance.mark('loading_ui_shown');
  }

  // Show asset detail view if selectedAssetForDetails is set
  if (selectedAssetForDetails) {
    if (selectedAssetForDetails.type === 'asset') {
      return (
        <ToolDetails
          tool={selectedAssetForDetails as any}
          toolHistory={toolHistory}
          currentCheckout={null} // TODO: Add current checkout logic if needed
          onBack={handleBackToAssets}
        />
      );
    } else if (selectedAssetForDetails.type === 'stock') {
      return (
        <StockDetails
          stock={selectedAssetForDetails as any}
          onBack={handleBackToAssets}
          onRefresh={() => {
            // Refresh stock data
          }}
        />
      );
    }
  }

  return (
    <div className="container mx-auto p-6 space-y-6">
      {(() => { performance.mark('container_first_paint'); return null; })()}
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="flex items-center gap-4">
          <Button variant="outline" onClick={() => navigate('/dashboard')}>
            <ArrowLeft className="w-4 h-4 mr-2" />
            Back to Dashboard
          </Button>
          <div>
            <h1 className="text-3xl font-bold">
              {viewParam === 'stock' ? 'Inventory Management' : 'Combined Assets'}
            </h1>
            <p className="text-muted-foreground">
              {filteredAssets.length} items ({assets.filter(a => a.type === 'asset').length} assets, {assets.filter(a => a.type === 'stock').length} stock items)
            </p>
            {loading && (
              <p className="text-xs text-muted-foreground">Loading…</p>
            )}
          </div>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => navigate('/inventory/summary')}
          className="flex items-center gap-2 self-start sm:self-auto"
        >
          <BarChart3 className="h-4 w-4" />
          Summary
        </Button>
      </div>

      {/* Filters */}
      <CombinedAssetFilters
        searchTerm={searchTerm}
        setSearchTerm={setSearchTerm}
        isSemanticSearching={isSemanticSearching}
        onSemanticSearch={() => performSemanticSearch(searchTerm)}
        onClearSearch={() => setSemanticResults([])}
        searchDescriptions={searchDescriptions}
        setSearchDescriptions={setSearchDescriptions}
        showMyCheckedOut={showMyCheckedOut}
        setShowMyCheckedOut={setShowMyCheckedOut}
        showLowStock={showLowStock}
        setShowLowStock={setShowLowStock}
        showOnlyAssets={showOnlyAssets}
        setShowOnlyAssets={setShowOnlyAssets}
        showOnlyStock={showOnlyStock}
        setShowOnlyStock={setShowOnlyStock}
        showOnlyAreas={showOnlyAreas}
        setShowOnlyAreas={setShowOnlyAreas}
        showRemovedItems={showRemovedItems}
        setShowRemovedItems={setShowRemovedItems}
        actionButton={
          <Button onClick={() => setShowAddDialog(true)}>
            <Plus className="w-4 h-4 mr-2" />
            Add
          </Button>
        }
      />



      {/* Assets Grid */}
      <CombinedAssetGrid
        assets={filteredAssets}
        canEdit={canEditTools}
        isAdmin={isAdmin}
        currentUserId={user?.id}
        currentUserEmail={user?.email}
        userNameMap={checkoutDisplayNameMap}
            onView={handleShowAssetDetails}
            onEdit={handleEdit}
            onRemove={handleRemove}
            onCheckout={handleCheckout}
            onCheckin={handleCheckin}
            onAddObservation={handleAddObservation}
            onAddQuantity={handleAddQuantity}
            onUseQuantity={handleUseQuantity}
            onAskMaxwell={handleAskMaxwell}
        areaItemCounts={showOnlyAreas ? areaItemCounts : undefined}
        // Infinite scroll props
        onLoadMore={() => {
          if (!loading) {
            const nextPage = page + 1;
            setPage(nextPage);
            fetchAssets({ page: nextPage, limit, search: searchRef.current, append: true, searchDescriptions, showLowStock });
          }
        }}
        hasMore={!loading && assets.length >= (page + 1) * limit}
        loading={loading}
      />

      {/* Add Asset Dialog */}
      <CombinedAssetDialog
        isOpen={showAddDialog}
        onClose={() => setShowAddDialog(false)}
        onSubmit={handleCreateAsset}
        initialName={searchTerm}
      />

      {/* Checkout Dialog */}
      {selectedAsset && selectedAsset.type === 'asset' && (
        <ToolCheckoutDialog
          open={showCheckoutDialog}
          onOpenChange={() => {
            setShowCheckoutDialog(false);
            setSelectedAssetId(null);
          }}
          tool={selectedAsset as any}
          onSuccess={() => {
            setShowCheckoutDialog(false);
            setSelectedAssetId(null);
          }}
        />
      )}

      {/* Check-in Dialog */}
      {selectedAsset && selectedAsset.type === 'asset' && (
        <ToolCheckInDialog
          open={showCheckinDialog}
          onOpenChange={() => {
            setShowCheckinDialog(false);
            setSelectedAssetId(null);
          }}
          tool={selectedAsset as any}
          onSuccess={() => {
            setShowCheckinDialog(false);
            setSelectedAssetId(null);
          }}
        />
      )}

      {/* Removal Dialogs */}
      {selectedAsset && selectedAsset.type === 'asset' && (
        <ToolRemovalDialog
          open={showRemovalDialog}
          onOpenChange={() => {
            setShowRemovalDialog(false);
            setSelectedAssetId(null);
          }}
          tool={selectedAsset as any}
          onConfirm={handleConfirmRemoval}
        />
      )}

      {selectedAsset && selectedAsset.type === 'stock' && (
        <AlertDialog
          open={showRemovalDialog}
          onOpenChange={(open) => {
            if (!open) {
              setShowRemovalDialog(false);
              setSelectedAssetId(null);
            }
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete Stock Item</AlertDialogTitle>
              <AlertDialogDescription>
                Are you sure you want to delete "{selectedAsset.name}"? This action cannot be undone.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={() => handleConfirmRemoval('', '')}
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              >
                Delete
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}

      {/* Edit Tool Dialog */}
      {selectedAsset && selectedAsset.type === 'asset' && (
        <EditToolForm
          tool={selectedAsset as any}
          isOpen={showEditDialog}
          onClose={() => {
            setShowEditDialog(false);
            setSelectedAssetId(null);
            setSelectedImage(null); // Reset image state when closing
          }}
          onSubmit={handleEditSubmit}
          isLeadership={isAdmin}
        />
      )}

      {/* Edit Stock Item Dialog */}
      {selectedAsset && selectedAsset.type === 'stock' && (
        <Dialog open={showEditDialog} onOpenChange={(open) => {
          // Prevent closing while uploading or submitting
          if (!open && (isUploadingFiles || isUploading)) return;
          if (!open) {
            setShowEditDialog(false);
            setSelectedAssetId(null);
            setIsMaxwellOpen(false);
          }
        }}>
          <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <div className="flex items-center gap-2 pr-8">
                <DialogTitle className="flex-1">Edit Stock Item</DialogTitle>
                <Button
                  variant="ghost"
                  type="button"
                  onClick={() => setIsMaxwellOpen(v => !v)}
                  className={`h-8 w-8 p-0 flex-shrink-0 [&_svg]:size-auto ${isMaxwellOpen ? 'bg-primary/10 text-primary' : ''}`}
                  title="Ask Maxwell"
                >
                  <PrismIcon size={28} />
                </Button>
              </div>
              <DialogDescription>
                Update the details for this stock item.
              </DialogDescription>
            </DialogHeader>

            {/* Maxwell inline panel */}
            <div
              className={`grid transition-all duration-300 ease-in-out ${isMaxwellOpen ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'}`}
            >
              <div className="overflow-hidden">
                <div className="rounded-xl border overflow-hidden" style={{ height: '420px' }}>
                  <MaxwellInlinePanel
                    context={{
                      entityId: selectedAsset.id,
                      entityType: 'part',
                      entityName: selectedAsset.name,
                      policy: selectedAsset.description || '',
                      implementation: '',
                    } as EntityContext}
                    onClose={() => setIsMaxwellOpen(false)}
                    className="h-full rounded-none border-0"
                    hideHeader
                  />
                </div>
              </div>
            </div>

            <InventoryItemForm
              initialData={{
                name: selectedAsset.name || '',
                description: selectedAsset.description || '',
                current_quantity: selectedAsset.current_quantity || 0,
                minimum_quantity: selectedAsset.minimum_quantity || 0,
                unit: selectedAsset.unit || 'pieces',
                cost_per_unit: (selectedAsset.cost_per_unit || 0).toString(),
                parent_structure_id: selectedAsset.parent_structure_id || '',
                storage_location: selectedAsset.storage_location || '',
                accountable_person_id: selectedAsset.accountable_person_id || '',
                sellable: (selectedAsset as any).sellable ?? false
              }}
              editingPart={selectedAsset as any}
              attachments={stockAttachments}
              onAttachmentsChange={setStockAttachments}
              onUploadStateChange={setIsUploadingFiles}
              onSubmit={handleStockEditSubmit}
              onCancel={() => {
                setShowEditDialog(false);
                setSelectedAssetId(null);
                setStockAttachments([]);
                setIsMaxwellOpen(false);
              }}
              isLoading={isUploading}
              submitButtonText="Update Stock Item"
              isLeadership={isAdmin}
            />
          </DialogContent>
        </Dialog>
      )}

      {/* Maxwell Dialog from Card */}
      {maxwellDialogAsset && (
        <Dialog open={!!maxwellDialogAsset} onOpenChange={(open) => { if (!open) setMaxwellDialogAsset(null); }}>
          <DialogContent className="max-w-5xl w-[95vw] h-[85vh] flex flex-col overflow-hidden">
            <DialogHeader className="flex-shrink-0">
              <DialogTitle>{maxwellDialogAsset.name}</DialogTitle>
              <DialogDescription>Ask Maxwell about this {maxwellDialogAsset.type === 'asset' ? 'asset' : 'stock item'}</DialogDescription>
            </DialogHeader>
            <div className="flex-1 rounded-xl border overflow-hidden min-h-0">
              <MaxwellInlinePanel
                context={{
                  entityId: maxwellDialogAsset.id,
                  entityType: maxwellDialogAsset.type === 'asset' ? 'tool' : 'part',
                  entityName: maxwellDialogAsset.name,
                  policy: maxwellDialogAsset.description || '',
                  implementation: '',
                } as EntityContext}
                onClose={() => setMaxwellDialogAsset(null)}
                className="h-full rounded-none border-0"
                hideHeader
              />
            </div>
          </DialogContent>
        </Dialog>
      )}

      {/* View Asset Dialog */}
      {selectedAsset && selectedAsset.type === 'asset' && showViewDialog && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-background rounded-lg w-full max-w-6xl max-h-[90vh] overflow-y-auto m-4">
            <div className="p-6">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-lg font-semibold">{selectedAsset.name}</h2>
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    type="button"
                    onClick={() => setIsMaxwellOpen(v => !v)}
                    className={`h-8 w-8 p-0 [&_svg]:size-auto ${isMaxwellOpen ? 'bg-primary/10 border-primary/50 text-primary' : ''}`}
                    title="Ask Maxwell"
                  >
                    <PrismIcon size={28} />
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => {
                      setShowViewDialog(false);
                      setSelectedAssetId(null);
                      setIsMaxwellOpen(false);
                    }}
                  >
                    Close
                  </Button>
                </div>
              </div>

              {/* Maxwell inline panel */}
              <div
                className={`grid transition-all duration-300 ease-in-out mb-4 ${isMaxwellOpen ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'}`}
              >
                <div className="overflow-hidden">
                  <div className="rounded-xl border overflow-hidden" style={{ height: '420px' }}>
                    <MaxwellInlinePanel
                      context={{
                        entityId: selectedAsset.id,
                        entityType: selectedAsset.type === 'asset' ? 'tool' : 'part',
                        entityName: selectedAsset.name,
                        policy: selectedAsset.description || '',
                        implementation: '',
                      } as EntityContext}
                      onClose={() => setIsMaxwellOpen(false)}
                      className="h-full rounded-none border-0"
                      hideHeader
                    />
                  </div>
                </div>
              </div>

              <ToolDetails
                tool={selectedAsset as any}
                toolHistory={toolHistory}
                currentCheckout={currentCheckout}
                onBack={() => {
                  setShowViewDialog(false);
                  setSelectedAssetId(null);
                  setIsMaxwellOpen(false);
                }}
              />
            </div>
          </div>
        </div>
      )}

      {/* View Stock Item Dialog */}
      {selectedAsset && selectedAsset.type === 'stock' && showViewDialog && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-background rounded-lg w-full max-w-4xl max-h-[90vh] overflow-y-auto m-4">
            <div className="p-6">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-lg font-semibold">Stock Item Details</h2>
                <Button
                  variant="outline"
                  onClick={() => {
                    setShowViewDialog(false);
                    setSelectedAssetId(null);
                  }}
                >
                  Close
                </Button>
              </div>
              <div className="space-y-4">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <h3 className="font-medium">Basic Information</h3>
                    <div className="mt-2 space-y-2 text-sm">
                      <div><span className="font-medium">Name:</span> {selectedAsset.name}</div>
                      <div><span className="font-medium">Description:</span> {selectedAsset.description || 'N/A'}</div>
                      <div><span className="font-medium">Category:</span> {selectedAsset.category || 'N/A'}</div>
                      <div><span className="font-medium">Unit:</span> {selectedAsset.unit || 'pieces'}</div>
                    </div>
                  </div>
                  <div>
                    <h3 className="font-medium">Inventory Information</h3>
                    <div className="mt-2 space-y-2 text-sm">
                      <div><span className="font-medium">Current Quantity:</span> {selectedAsset.current_quantity || 0}</div>
                      <div><span className="font-medium">Minimum Quantity:</span> {selectedAsset.minimum_quantity || 0}</div>
                      <div><span className="font-medium">Cost per Unit:</span> {selectedAsset.cost_per_unit ? `$${selectedAsset.cost_per_unit}` : 'N/A'}</div>
                      <div><span className="font-medium">Supplier:</span> {selectedAsset.supplier || 'N/A'}</div>
                    </div>
                  </div>
                </div>
                <div>
                  <h3 className="font-medium">Storage Information</h3>
                  <div className="mt-2 space-y-2 text-sm">
                    <div><span className="font-medium">Storage Vicinity:</span> {selectedAsset.storage_vicinity || 'N/A'}</div>
                    <div><span className="font-medium">Storage Location:</span> {selectedAsset.storage_location || 'N/A'}</div>
                  </div>
                </div>
                {selectedAsset.image_url && (
                  <div>
                    <h3 className="font-medium">Image</h3>
                    <img 
                      src={getThumbnailUrl(selectedAsset.image_url) || ''}
                      alt={selectedAsset.name}
                      className="mt-2 max-w-xs rounded-lg cursor-pointer hover:opacity-80"
                      onClick={() => window.open(getImageUrl(selectedAsset.image_url) || '', '_blank')}
                      onError={(e) => {
                        // Fallback to full image if thumbnail doesn't exist
                        const target = e.target as HTMLImageElement;
                        const fullUrl = getImageUrl(selectedAsset.image_url);
                        if (fullUrl && target.src !== fullUrl) {
                          target.src = fullUrl;
                        }
                      }}
                      title="Click to view full size"
                    />
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Quantity Dialog */}
      <Dialog open={showQuantityDialog} onOpenChange={setShowQuantityDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {quantityOperation === 'add' ? 'Add Quantity' : 'Use/Remove Quantity'}
            </DialogTitle>
            <DialogDescription>
              {selectedAsset && (
                <>
                  {quantityOperation === 'add' ? 'Add to' : 'Remove from'} {selectedAsset.name}
                  <br />
                  Current quantity: {selectedAsset.current_quantity} {selectedAsset.unit || 'units'}
                </>
              )}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div>
              <Label htmlFor="amount">Amount</Label>
              <Input
                id="amount"
                type="number"
                value={quantityChange.amount}
                onChange={(e) => setQuantityChange(prev => ({ ...prev, amount: e.target.value }))}
                placeholder="Enter amount"
                min="0"
                step="0.01"
              />
            </div>

            <div>
              <Label htmlFor="reason">Reason</Label>
              <Textarea
                id="reason"
                value={quantityChange.reason}
                onChange={(e) => setQuantityChange(prev => ({ ...prev, reason: e.target.value }))}
                placeholder="Reason for change"
              />
            </div>

          </div>

          <div className="flex justify-end gap-2 pt-4">
            <Button variant="outline" onClick={() => setShowQuantityDialog(false)}>
              Cancel
            </Button>
            <Button onClick={updateQuantity} disabled={!quantityChange.amount}>
              {quantityOperation === 'add' ? 'Add to' : 'Remove from'} Stock
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Order Dialog */}
      {selectedAsset && selectedAsset.type === 'stock' && (
        <OrderDialog
          isOpen={showOrderDialog}
          onClose={() => {
            setShowOrderDialog(false);
            setSelectedAssetId(null);
          }}
          partId={selectedAsset.id}
          partName={selectedAsset.name}
          onOrderCreated={() => {
            // TanStack Query will automatically update the cache
          }}
        />
      )}

      {/* Receiving Dialog */}
      {selectedAsset && selectedAsset.type === 'stock' && (
        <ReceivingDialog
          isOpen={showReceivingDialog}
          onClose={() => {
            setShowReceivingDialog(false);
            setSelectedAssetId(null);
          }}
          order={pendingOrders[selectedAsset.id]?.[0] || null}
          part={selectedAsset as any}
          onSuccess={() => {
            setShowReceivingDialog(false);
            setSelectedAssetId(null);
          }}
        />
      )}
    </div>
  );
};