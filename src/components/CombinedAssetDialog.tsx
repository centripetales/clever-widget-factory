import { useState, useEffect } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { Wrench, Package, Info } from "lucide-react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useToast } from "@/hooks/use-toast";
import { TOOL_CATEGORY_OPTIONS } from "@/lib/constants";
import { LocationFieldsGroup } from "@/components/shared/LocationFieldsGroup";
import { FileAttachmentManager } from "@/components/shared/FileAttachmentManager";
import { useParentStructures } from "@/hooks/tools/useParentStructures";

interface CombinedAssetForm {
  name: string;
  description: string;
  category: string;
  serial_number: string;
  current_quantity: number;
  minimum_quantity: number;
  cost_per_unit: string;
  unit: string;
  status: string;
  parent_structure_id: string;
  storage_location: string;
  attachments: string[];
}

interface CombinedAssetDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (assetData: any, isAsset: boolean) => Promise<any>;
  initialName?: string;
}

export const CombinedAssetDialog = ({ isOpen, onClose, onSubmit, initialName = "" }: CombinedAssetDialogProps) => {
  const [formData, setFormData] = useState<CombinedAssetForm>({
    name: initialName,
    description: "",
    category: "",
    serial_number: "",
    current_quantity: 0,
    minimum_quantity: 0,
    cost_per_unit: "",
    unit: "pieces",
    status: "available",
    parent_structure_id: "none",
    storage_location: "",
    attachments: [],
  });
  
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isUploadingFiles, setIsUploadingFiles] = useState(false);
  const [useMinimumQuantity, setUseMinimumQuantity] = useState(false);
  const { toast } = useToast();
  const { parentStructures, areaItemCounts, loading: isLoadingParentStructures } = useParentStructures();

  // Determine if this is an asset based on serial number
  const isAsset = formData.serial_number.trim().length > 0;

  useEffect(() => {
    if (initialName) {
      setFormData(prev => ({ ...prev, name: initialName }));
    }
  }, [initialName]);


  const updateFormData = (field: keyof CombinedAssetForm, value: any) => {
    setFormData(prev => ({ ...prev, [field]: value }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);

    try {
      // Convert attachments array to image_url for database compatibility
      const imageUrl = formData.attachments.length > 0 ? formData.attachments[0] : null;

      if (isAsset) {
        // Create asset (tool)
        const toolData = {
          name: formData.name,
          description: formData.description || null,
          category: formData.category || null,
          status: formData.status,
          parent_structure_id: formData.parent_structure_id === "none" ? null : formData.parent_structure_id,
          storage_location: formData.storage_location || null,
          serial_number: formData.serial_number || null,
          image_url: imageUrl
        };
        await onSubmit(toolData, true);
      } else {
        // Create stock (part)
        const partData = {
          name: formData.name,
          description: formData.description || null,
          category: formData.category || null,
          current_quantity: formData.current_quantity,
          minimum_quantity: useMinimumQuantity ? formData.minimum_quantity : null,
          cost_per_unit: formData.cost_per_unit ? parseFloat(formData.cost_per_unit) : null,
          unit: formData.unit,
          parent_structure_id: formData.parent_structure_id === "none" ? null : formData.parent_structure_id,
          storage_location: formData.storage_location || null,
          image_url: imageUrl
        };
        await onSubmit(partData, false);
      }

      // Show success toast first
      toast({
        title: "Success",
        description: `${isAsset ? 'Asset' : 'Stock item'} added successfully`
      });

      // Reset form
      setFormData({
        name: "",
        description: "",
        category: "",
        serial_number: "",
        current_quantity: 0,
        minimum_quantity: 0,
        cost_per_unit: "",
        unit: "pieces",
        status: "available",
        parent_structure_id: "none",
        storage_location: "",
        attachments: [],
      });
      setUseMinimumQuantity(false);
      onClose();
    } catch (error: any) {
      console.error('Error adding item:', error);
      const errorMessage = error?.message || error?.error || 'Unknown error';
      toast({
        title: "Error",
        description: `Failed to add ${isAsset ? 'asset' : 'stock item'}: ${errorMessage}`,
        variant: "destructive"
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={(open) => {
      // Prevent closing while uploading or submitting
      if (!open && (isUploadingFiles || isSubmitting)) return;
      onClose();
    }}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {isAsset ? (
              <>
                <Wrench className="w-5 h-5 text-blue-600" />
                Add New Asset
                <Badge variant="default" className="text-xs">Trackable Item</Badge>
              </>
            ) : (
              <>
                <Package className="w-5 h-5 text-green-600" />
                Add New Stock Item
                <Badge variant="secondary" className="text-xs">Consumable</Badge>
              </>
            )}
          </DialogTitle>
          <p className="text-sm text-muted-foreground">
            {isAsset 
              ? "Items with serial numbers become trackable assets" 
              : "Items without serial numbers become consumable stock"
            }
          </p>
        </DialogHeader>
        
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="col-span-2">
              <Label htmlFor="name">Item Name *</Label>
              <Input
                id="name"
                value={formData.name}
                onChange={(e) => updateFormData('name', e.target.value)}
                required
              />
            </div>

            <div className="col-span-2">
              <Label htmlFor="description">Description</Label>
              <Textarea
                id="description"
                value={formData.description}
                onChange={(e) => updateFormData('description', e.target.value)}
                rows={3}
              />
            </div>

            <div>
              <Label htmlFor="serial">Serial Number</Label>
              <Input
                id="serial"
                value={formData.serial_number}
                onChange={(e) => updateFormData('serial_number', e.target.value)}
                placeholder="Leave empty for stock items"
              />
            </div>

            {/* Category field - disabled when no serial number */}
            <div>
              <Label htmlFor="category" className={!isAsset ? "text-muted-foreground" : ""}>Category</Label>
              <Select
                value={formData.category}
                onValueChange={(value) => updateFormData('category', value)}
                disabled={!isAsset}
              >
                <SelectTrigger className={!isAsset ? "text-muted-foreground" : ""}>
                  <SelectValue placeholder="Select category" />
                </SelectTrigger>
                <SelectContent>
                  {TOOL_CATEGORY_OPTIONS.map((category) => (
                    <SelectItem key={category.value} value={category.value}>
                      {category.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Quantity fields - show for all but disable for assets */}
            <div>
              <Label htmlFor="current_quantity" className={isAsset ? "text-muted-foreground" : ""}>Current Quantity *</Label>
              <Input
                id="current_quantity"
                type="number"
                step="1"
                min="0"
                value={formData.current_quantity || ""}
                onChange={(e) => updateFormData('current_quantity', e.target.value === '' ? 0 : parseFloat(e.target.value) || 0)}
                disabled={isAsset}
                className={isAsset ? "text-muted-foreground" : ""}
              />
            </div>
            
            <div>
              <div className="flex items-center space-x-2 mb-2">
                <Checkbox 
                  id="use-minimum-quantity"
                  checked={useMinimumQuantity}
                  onCheckedChange={(checked) => setUseMinimumQuantity(checked === true)}
                  disabled={isAsset}
                />
                <Label htmlFor="use-minimum-quantity" className={`text-sm font-medium ${isAsset ? "text-muted-foreground" : ""}`}>
                  Set Minimum Quantity
                </Label>
              </div>
              
              {useMinimumQuantity && (
                <Input
                  id="minimum_quantity"
                  type="number"
                  step="0.01"
                  min="0"
                  value={formData.minimum_quantity}
                  onChange={(e) => updateFormData('minimum_quantity', e.target.value === '' ? 0 : parseFloat(e.target.value) || 0)}
                  disabled={isAsset}
                />
              )}
            </div>

            <div>
              <Label htmlFor="unit" className={isAsset ? "text-muted-foreground" : ""}>Unit</Label>
              <Select 
                value={formData.unit} 
                onValueChange={(value) => updateFormData('unit', value)}
                disabled={isAsset}
              >
                <SelectTrigger className={isAsset ? "text-muted-foreground" : ""}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="pieces">Pieces</SelectItem>
                  <SelectItem value="kg">Kilograms</SelectItem>
                  <SelectItem value="meters">Meters</SelectItem>
                  <SelectItem value="liters">Liters</SelectItem>
                  <SelectItem value="grams">Grams</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div>
              <div className="flex items-center gap-2 mb-2">
                <Label htmlFor="cost_per_unit" className={isAsset ? "text-muted-foreground" : ""}>Cost per unit (php)</Label>
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Info className="h-4 w-4 text-muted-foreground cursor-help" />
                    </TooltipTrigger>
                    <TooltipContent>
                      <p>Exclude shipping costs in calculation</p>
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </div>
              <Input
                id="cost_per_unit"
                type="number"
                step="0.01"
                min="0"
                value={formData.cost_per_unit}
                onChange={(e) => updateFormData('cost_per_unit', e.target.value)}
                placeholder="0.00"
                disabled={isAsset}
                className={isAsset ? "text-muted-foreground" : ""}
              />
            </div>


            {/* Status field - only show for assets */}
            {isAsset && (
              <div className="col-span-2">
                <Label htmlFor="status">Status</Label>
                <Select
                  value={formData.status}
                  onValueChange={(value) => updateFormData('status', value)}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="available">Available</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}

            {/* Location Fields */}
            <div className="col-span-2">
              <LocationFieldsGroup
                areaValue={formData.parent_structure_id}
                specificLocation={formData.storage_location}
                onAreaChange={(value) => updateFormData('parent_structure_id', value)}
                onSpecificLocationChange={(value) => updateFormData('storage_location', value)}
                areaFieldLabel="Area"
                specificLocationPlaceholder="e.g., Shelf A2, Drawer 3"
                isLoadingAreas={isLoadingParentStructures}
                parentStructures={parentStructures}
                areaItemCounts={areaItemCounts}
                areaRequired={!isAsset} // Required for stock items
              />
            </div>

            {/* Image Upload */}
            <div className="col-span-2">
              <FileAttachmentManager
                attachments={formData.attachments}
                onAttachmentsChange={(attachments) => updateFormData('attachments', attachments)}
                bucket="tool-images"
                label="Item Images & Documents"
                disabled={isSubmitting}
                maxFiles={5}
                onUploadStateChange={setIsUploadingFiles}
              />
            </div>
          </div>

          <div className="flex justify-end gap-2 pt-4">
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button 
              type="submit" 
              disabled={isSubmitting || !formData.name.trim()}
            >
              {isSubmitting ? "Adding..." : `Add ${isAsset ? 'Asset' : 'Stock Item'}`}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
};