import { useParams, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { ArrowLeft, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { EditToolForm } from '@/components/tools/forms/EditToolForm';
import { InventoryItemForm } from '@/components/InventoryItemForm';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { useAssetMutations } from '@/hooks/useAssetMutations';
import { useAuth } from '@/hooks/useCognitoAuth';
import { useToast } from '@/hooks/use-toast';
import { useImageUpload } from '@/hooks/useImageUpload';
import { CombinedAsset } from '@/hooks/useCombinedAssets';
import { toolsQueryKey, partsQueryKey } from '@/lib/queryKeys';
import { apiService } from '@/lib/apiService';
import { MaxwellInlinePanel } from '@/components/MaxwellInlinePanel';
import { PrismIcon } from '@/components/icons/PrismIcon';
import { EntityContext } from '@/hooks/useEntityContext';

export default function AssetPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { updateTool, updatePart } = useAssetMutations();
  const { isAdmin } = useAuth();
  const { toast } = useToast();
  const { uploadImages, isUploading } = useImageUpload();
  const [asset, setAsset] = useState<CombinedAsset | null>(null);
  const [loading, setLoading] = useState(true);
  const [stockAttachments, setStockAttachments] = useState<string[]>([]);
  const [isUploadingFiles, setIsUploadingFiles] = useState(false);
  const [isMaxwellOpen, setIsMaxwellOpen] = useState(false);

  // Try to find asset in TanStack Query cache first, then use cached data
  useEffect(() => {
    if (!id) return;

    const toolsData = queryClient.getQueryData<any[]>(toolsQueryKey());
    const partsData = queryClient.getQueryData<any[]>(partsQueryKey());

    // Search tools
    if (toolsData) {
      const foundTool = toolsData.find((t: any) => t.id === id);
      if (foundTool) {
        setAsset({ ...foundTool, type: 'asset' } as CombinedAsset);
        setStockAttachments(foundTool.image_url ? [foundTool.image_url] : []);
        setLoading(false);
        return;
      }
    }

    // Search parts
    if (partsData) {
      const foundPart = partsData.find((p: any) => p.id === id);
      if (foundPart) {
        setAsset({ ...foundPart, type: 'stock' } as CombinedAsset);
        const attachments = (foundPart as any).attachments || [];
        setStockAttachments(attachments.length > 0 ? attachments : foundPart.image_url ? [foundPart.image_url] : []);
        setLoading(false);
        return;
      }
    }

    // Not in cache — fetch directly from API
    const fetchAsset = async () => {
      try {
        // Try tools first
        const toolsResult = await apiService.get('/tools?limit=2000');
        const tools = toolsResult.data || [];
        const foundTool = tools.find((t: any) => t.id === id);
        if (foundTool) {
          setAsset({ ...foundTool, type: 'asset' } as CombinedAsset);
          setStockAttachments(foundTool.image_url ? [foundTool.image_url] : []);
          setLoading(false);
          return;
        }

        // Try parts
        const partsResult = await apiService.get('/parts?limit=2000');
        const parts = partsResult.data || [];
        const foundPart = parts.find((p: any) => p.id === id);
        if (foundPart) {
          setAsset({ ...foundPart, type: 'stock' } as CombinedAsset);
          const attachments = (foundPart as any).attachments || [];
          setStockAttachments(attachments.length > 0 ? attachments : foundPart.image_url ? [foundPart.image_url] : []);
          setLoading(false);
          return;
        }

        // Not found anywhere
        setLoading(false);
      } catch (err) {
        console.error('Failed to fetch asset:', err);
        setLoading(false);
      }
    };

    fetchAsset();
  }, [id, queryClient]);

  const handleBack = () => {
    navigate('/combined-assets');
  };

  const handleToolSubmit = async (toolId: string, toolData: any) => {
    try {
      await updateTool.mutateAsync({ id: toolId, data: toolData });
      toast({ title: "Success", description: "Asset updated successfully" });
      handleBack();
    } catch (error) {
      console.error('Error updating tool:', error);
      toast({ title: "Error", description: "Failed to update asset", variant: "destructive" });
    }
  };

  const handleStockSubmit = async (formData: any, useMinimumQuantity: boolean) => {
    if (!asset) return;
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
      image_url: imageUrl,
    };
    try {
      await updatePart.mutateAsync({ id: asset.id, data: updateData });
      toast({ title: "Success", description: "Stock item updated successfully" });
      handleBack();
    } catch (error) {
      console.error('Error updating part:', error);
      toast({ title: "Error", description: "Failed to update stock item", variant: "destructive" });
    }
  };

  if (loading) {
    return (
      <div className="container mx-auto p-6 flex items-center justify-center min-h-[50vh]">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!asset) {
    return (
      <div className="container mx-auto p-6">
        <Button variant="ghost" size="sm" onClick={handleBack} className="gap-2 mb-4">
          <ArrowLeft className="h-4 w-4" />
          Back
        </Button>
        <p className="text-muted-foreground">Asset not found.</p>
      </div>
    );
  }

  return (
    <div className="container mx-auto p-3 sm:p-6 max-w-4xl">
      <div className="mb-4">
        <Button variant="ghost" size="sm" onClick={handleBack} className="gap-2">
          <ArrowLeft className="h-4 w-4" />
          Back to Assets
        </Button>
      </div>

      {asset.type === 'asset' ? (
        <EditToolForm
          tool={asset as any}
          isOpen={true}
          onClose={handleBack}
          onSubmit={handleToolSubmit}
          isLeadership={isAdmin}
        />
      ) : (
        <Dialog open={true} onOpenChange={(open) => { if (!open) handleBack(); }}>
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
              <DialogDescription>Update the details for this stock item.</DialogDescription>
            </DialogHeader>

            {isMaxwellOpen && (
              <div className="rounded-xl border overflow-hidden" style={{ height: '420px' }}>
                <MaxwellInlinePanel
                  context={{
                    entityId: asset.id,
                    entityType: 'part',
                    entityName: asset.name,
                    policy: asset.description || '',
                    implementation: '',
                  } as EntityContext}
                  onClose={() => setIsMaxwellOpen(false)}
                  className="h-full rounded-none border-0"
                  hideHeader
                />
              </div>
            )}

            <InventoryItemForm
              initialData={{
                name: asset.name || '',
                description: asset.description || '',
                current_quantity: asset.current_quantity || 0,
                minimum_quantity: asset.minimum_quantity || 0,
                unit: asset.unit || 'pieces',
                cost_per_unit: (asset.cost_per_unit || 0).toString(),
                parent_structure_id: asset.parent_structure_id || '',
                storage_location: asset.storage_location || '',
                accountable_person_id: (asset as any).accountable_person_id || '',
                sellable: asset.sellable || false,
              }}
              attachments={stockAttachments}
              onAttachmentsChange={setStockAttachments}
              onUploadStateChange={setIsUploadingFiles}
              isLoading={false}
              onSubmit={handleStockSubmit}
              onCancel={handleBack}
              submitButtonText="Save Changes"
              editingPart={asset as any}
              isLeadership={isAdmin}
            />
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
