import React, { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Checkbox } from '@/components/ui/checkbox';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { Info } from 'lucide-react';
import { LocationFieldsGroup } from '@/components/shared/LocationFieldsGroup';
import { FileAttachmentManager } from '@/components/shared/FileAttachmentManager';
import { MetricsSection } from '@/components/tools/metrics/MetricsSection';
import { useParentStructures } from '@/hooks/tools/useParentStructures';
import { useActionProfiles } from '@/hooks/useActionProfiles';

// Supplier interface removed - supplier tracking moved to stock additions

interface Part {
  id: string;
  name: string;
  description: string | null;
  current_quantity: number;
  minimum_quantity: number | null;
  cost_per_unit: number | null;
  unit: string | null;
  supplier: string | null;
  supplier_id: string | null;
  legacy_storage_vicinity: string | null;
  storage_vicinity: string | null;
  parent_structure_id: string | null;
  storage_location: string | null;
  image_url: string | null;
  accountable_person_id: string | null;
  sellable: boolean;
  created_at: string;
  updated_at: string;
}

interface FormData {
  name: string;
  description: string;
  current_quantity: number;
  minimum_quantity: number;
  cost_per_unit: string;
  unit: string;
  parent_structure_id: string | null;
  storage_location: string;
  accountable_person_id: string;
  sellable: boolean;
}

interface InventoryItemFormProps {
  initialData?: Partial<FormData>;
  attachments: string[];
  onAttachmentsChange: (attachments: string[]) => void;
  onUploadStateChange?: (isUploading: boolean) => void;
  isLoading: boolean;
  onSubmit: (data: FormData, useMinimumQuantity: boolean) => void;
  onCancel: () => void;
  submitButtonText: string;
  editingPart?: Part | null;
  isLeadership?: boolean;
  selectedImage?: File | null;
  setSelectedImage?: (image: File | null) => void;
  removeExistingImage?: boolean;
  setRemoveExistingImage?: (remove: boolean) => void;
}

export function InventoryItemForm({
  initialData,
  attachments,
  onAttachmentsChange,
  onUploadStateChange,
  isLoading,
  onSubmit,
  onCancel,
  submitButtonText,
  editingPart,
  isLeadership = false
}: InventoryItemFormProps) {
  const { parentStructures, areaItemCounts, loading: isLoadingParentStructures } = useParentStructures();
  const { profiles } = useActionProfiles();
  const [formData, setFormData] = useState<FormData>({
    name: '',
    description: '',
    current_quantity: 0,
    minimum_quantity: 0,
    cost_per_unit: '',
    unit: 'pieces',
    parent_structure_id: '',
    storage_location: '',
    accountable_person_id: 'none',
    sellable: false,
    ...initialData
  });

  // Debug logging removed for performance

  const [useMinimumQuantity, setUseMinimumQuantity] = useState(false);
  const [isFormInitialized, setIsFormInitialized] = useState(false);

  // Initialize form data when editing
  useEffect(() => {
    if (editingPart && !isFormInitialized) {
      const newFormData = {
        name: editingPart.name,
        description: editingPart.description || '',
        current_quantity: editingPart.current_quantity,
        minimum_quantity: editingPart.minimum_quantity || 0,
        cost_per_unit: editingPart.cost_per_unit?.toString() || '',
        unit: editingPart.unit || 'pieces',
        parent_structure_id: editingPart.parent_structure_id,
        storage_location: editingPart.storage_location || '',
        accountable_person_id: editingPart.accountable_person_id || 'none',
        sellable: editingPart.sellable ?? false
      };
      
      setFormData(newFormData);
      setUseMinimumQuantity(editingPart.minimum_quantity !== null && editingPart.minimum_quantity > 0);
      setIsFormInitialized(true);
    }
  }, [editingPart, isFormInitialized]);

  // Reset initialization flag when editingPart changes (new item being edited)
  useEffect(() => {
    setIsFormInitialized(false);
  }, [editingPart?.id]);

  const handleSubmit = () => {
    onSubmit(formData, useMinimumQuantity);
  };

  const updateFormData = (field: keyof FormData, value: string | number | boolean | null) => {
    setFormData(prev => ({ ...prev, [field]: value }));
  };

  return (
    <ScrollArea className="max-h-[70vh]">
      <div className="grid grid-cols-2 gap-4 pr-4">
        <div className="col-span-2">
          <Label htmlFor="name">Item Name *</Label>
          <Input
            id="name"
            value={formData.name}
            onChange={(e) => updateFormData('name', e.target.value)}
            placeholder="Enter item name"
          />
        </div>

        <div className="col-span-2">
          <Label htmlFor="description">Description</Label>
          <Textarea
            id="description"
            value={formData.description}
            onChange={(e) => updateFormData('description', e.target.value)}
            placeholder="Enter item description"
          />
        </div>

        {/* Supplier selection removed - supplier info will be captured during stock additions */}

        <div className="col-span-2">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <div className="flex items-center justify-between mb-2 h-6">
                <Label htmlFor="current_quantity">Current Quantity *</Label>
              </div>
              <Input
                id="current_quantity"
                type="number"
                step="1"
                min="0"
                value={formData.current_quantity}
                onChange={(e) => updateFormData('current_quantity', e.target.value === '' ? 0 : parseFloat(e.target.value) || 0)}
              />
            </div>
            
            <div>
              <div className="flex items-center justify-between mb-2 h-6">
                <div className="flex items-center space-x-2">
                  <Checkbox 
                    id="use-minimum-quantity"
                    checked={useMinimumQuantity}
                    onCheckedChange={(checked) => setUseMinimumQuantity(checked === true)}
                  />
                  <Label htmlFor="use-minimum-quantity" className="text-sm font-medium">
                    Set Minimum Quantity
                  </Label>
                </div>
              </div>
              
              {useMinimumQuantity && (
                <Input
                  id="minimum_quantity"
                  type="number"
                  step="0.01"
                  min="0"
                  value={formData.minimum_quantity}
                  onChange={(e) => updateFormData('minimum_quantity', e.target.value === '' ? 0 : parseFloat(e.target.value) || 0)}
                />
              )}
            </div>
          </div>
        </div>

        <div>
          <Label htmlFor="unit">Unit</Label>
          <Select value={formData.unit} onValueChange={(value) => updateFormData('unit', value)}>
            <SelectTrigger>
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

        <div className="col-span-2">
          <div className="flex items-center space-x-2 mb-4">
            <Checkbox 
              id="sellable"
              checked={formData.sellable}
              onCheckedChange={(checked) => updateFormData('sellable', checked === true)}
            />
            <Label htmlFor="sellable" className="text-sm font-medium">
              Available for sale in Sari Sari Store
            </Label>
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Info className="h-4 w-4 text-muted-foreground cursor-help" />
                </TooltipTrigger>
                <TooltipContent>
                  <p>When enabled, this item will be visible to customers in the Sari Sari store chat interface</p>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </div>
        </div>

        <div>
          <div className="flex items-center gap-2 mb-2">
            <Label htmlFor="cost_per_unit">Cost per unit (₱)</Label>
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
          />
        </div>


        <div className="col-span-2">
          {/* Location Fields */}
          <LocationFieldsGroup
            areaValue={formData.parent_structure_id}
            specificLocation={formData.storage_location}
            onAreaChange={(value) => updateFormData('parent_structure_id', value === 'none' ? null : value)}
            onSpecificLocationChange={(value) => updateFormData('storage_location', value)}
            areaFieldLabel="Area"
            specificLocationPlaceholder="e.g., Shelf 3, Bin B2"
            areaRequired={true}
            isLoadingAreas={isLoadingParentStructures}
            parentStructures={parentStructures}
            areaItemCounts={areaItemCounts}
          />
        </div>

        <div>
          <Label htmlFor="accountable_person">Accountable Person</Label>
          <Select
            value={formData.accountable_person_id}
            onValueChange={(value) => updateFormData('accountable_person_id', value)}
            disabled={!isLeadership}
          >
            <SelectTrigger>
              <SelectValue placeholder="Select accountable person" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">No one assigned</SelectItem>
              {profiles.map((profile) => (
                <SelectItem key={profile.user_id} value={profile.user_id}>
                  {profile.full_name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {!isLeadership && (
            <p className="text-xs text-muted-foreground mt-1">
              Only leadership can change accountable person
            </p>
          )}
        </div>

        {/* Metrics: things to measure on this item, such as its Stock readings */}
        {editingPart && (
          <div className="col-span-2">
            <MetricsSection toolId={editingPart.id} />
          </div>
        )}

        {/* Item Images & Documents - moved to bottom */}
        <div className="col-span-2">
          <FileAttachmentManager
            attachments={attachments}
            onAttachmentsChange={onAttachmentsChange}
            onUploadStateChange={onUploadStateChange}
            bucket="tool-images"
            label="Item Images & Documents"
            disabled={isLoading}
            maxFiles={5}
          />
        </div>
      </div>

      <div className="flex justify-end gap-2 pt-4">
        <Button variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button 
          onClick={handleSubmit} 
          disabled={!formData.name || isLoading}
        >
          {isLoading ? 'Processing...' : submitButtonText}
        </Button>
      </div>
    </ScrollArea>
  );
}