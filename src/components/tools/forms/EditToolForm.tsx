import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tool } from "@/hooks/tools/useToolsData";
import { useToast } from "@/hooks/use-toast";
import { TOOL_CATEGORY_OPTIONS } from "@/lib/constants";
import { LocationFieldsGroup } from "@/components/shared/LocationFieldsGroup";
import { FileAttachmentManager } from "@/components/shared/FileAttachmentManager";
import { MetricsSection } from "@/components/tools/metrics/MetricsSection";
import { useParentStructures } from "@/hooks/tools/useParentStructures";
import { useAuth } from "@/hooks/useCognitoAuth";
import { useActionProfiles } from "@/hooks/useActionProfiles";
import { MaxwellInlinePanel } from "@/components/MaxwellInlinePanel";
import { PrismIcon } from "@/components/icons/PrismIcon";
import { BarChart3 } from "lucide-react";

interface EditToolFormProps {
  tool: Tool | null;
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (toolId: string, updates: any) => Promise<void>;
  isLeadership?: boolean;
}

export const EditToolForm = ({ tool, isOpen, onClose, onSubmit, isLeadership = false }: EditToolFormProps) => {
  const navigate = useNavigate();
  const [editData, setEditData] = useState({
    name: tool?.name || "",
    description: tool?.description || "",
    category: tool?.category || "",
    status: tool?.status || "available",
    parent_structure_id: tool?.parent_structure_id || "none",
    storage_location: tool?.storage_location || "",
    serial_number: tool?.serial_number || "",
    accountable_person_id: (tool as any)?.accountable_person_id || "none",
    attachments: tool?.image_url ? [tool.image_url] : [],
  });
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isUploadingFiles, setIsUploadingFiles] = useState(false);
  const [isMaxwellOpen, setIsMaxwellOpen] = useState(false);
  const [isNameEditing, setIsNameEditing] = useState(false);
  const { toast } = useToast();
  const { parentStructures, areaItemCounts, loading: isLoadingParentStructures } = useParentStructures();
  const { isAdmin } = useAuth();
  const { profiles } = useActionProfiles();

  // Update form data when tool changes
  useEffect(() => {
    if (tool) {
      setEditData({
        name: tool.name || "",
        description: tool.description || "",
        category: tool.category || "",
        status: tool.status || "available",
        parent_structure_id: tool.parent_structure_id ? String(tool.parent_structure_id) : "none",
        storage_location: tool.storage_location || "",
        serial_number: tool.serial_number || "",
        accountable_person_id: (tool as any)?.accountable_person_id || "none",
        attachments: tool.image_url ? [tool.image_url] : [],
      });
    }
  }, [tool]);


  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!tool) return;
    
    setIsSubmitting(true);
    try {
      // Convert attachments array back to image_url for database compatibility
      const imageUrl = editData.attachments.length > 0 ? editData.attachments[0] : null;
      
      const updateData = {
        name: editData.name,
        description: editData.description || null,
        category: editData.category || null,
        status: editData.status,
        parent_structure_id: editData.parent_structure_id === "none" ? null : editData.parent_structure_id,
        storage_location: editData.storage_location || null,
        serial_number: editData.serial_number || null,
        accountable_person_id: editData.accountable_person_id === "none" ? null : editData.accountable_person_id,
        image_url: imageUrl
      };

      await onSubmit(tool.id, updateData);
      onClose();

      toast({
        title: "Success",
        description: "Tool updated successfully"
      });
    } catch (error) {
      console.error('Error updating tool:', error);
      toast({
        title: "Error",
        description: "Failed to update tool",
        variant: "destructive"
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  if (!tool) return null;

  return (
    <Dialog open={isOpen} onOpenChange={(open) => {
      if (!open && (isUploadingFiles || isSubmitting)) return;
      setIsNameEditing(false);
      setIsMaxwellOpen(false);
      onClose();
    }}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <div className="flex items-center gap-2 pr-8">
            {isNameEditing ? (
              <Input
                value={editData.name}
                onChange={(e) => setEditData(prev => ({ ...prev, name: e.target.value }))}
                onBlur={() => setIsNameEditing(false)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === 'Escape') setIsNameEditing(false); }}
                className="h-7 text-base font-semibold flex-1"
                autoFocus
              />
            ) : (
              <div
                className="cursor-pointer min-w-0"
                onClick={() => setIsNameEditing(true)}
                title="Edit name"
              >
                <DialogTitle className="truncate">{editData.name || tool.name}</DialogTitle>
              </div>
            )}
            <Button
              variant="ghost"
              type="button"
              onClick={() => setIsMaxwellOpen(v => !v)}
              className={`h-8 w-8 p-0 flex-shrink-0 [&_svg]:size-auto ${isMaxwellOpen ? 'bg-primary/10 text-primary' : ''}`}
              title="Ask Maxwell"
            >
              <PrismIcon size={28} />
            </Button>
            <Button
              variant="ghost"
              type="button"
              onClick={() => {
                onClose();
                navigate(`/combined-assets/tool/${tool.id}/state-space`);
              }}
              className="h-8 px-2 flex-shrink-0 gap-1 text-xs"
              title="State Space Model"
            >
              <BarChart3 className="h-4 w-4" />
              Model
            </Button>
          </div>
        </DialogHeader>

        {/* Maxwell inline panel */}
        <div
          className={`grid transition-all duration-300 ease-in-out ${isMaxwellOpen ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'}`}
        >
          <div className="overflow-hidden">
            <div className="rounded-xl border overflow-hidden" style={{ height: '420px' }}>
              <MaxwellInlinePanel
                context={{
                  entityId: tool.id,
                  entityType: 'tool',
                  entityName: tool.name,
                  policy: tool.description || '',
                  implementation: '',
                }}
                onClose={() => setIsMaxwellOpen(false)}
                className="h-full rounded-none border-0"
                hideHeader
              />
            </div>
          </div>
        </div>
        
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <Label htmlFor="edit-description">Description</Label>
            <Textarea
              id="edit-description"
              value={editData.description}
              onChange={(e) => setEditData(prev => ({ ...prev, description: e.target.value }))}
              rows={3}
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label htmlFor="edit-category">Category</Label>
              <Select
                value={editData.category}
                onValueChange={(value) => setEditData(prev => ({ ...prev, category: value }))}
              >
                <SelectTrigger>
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

            <div>
              <Label htmlFor="edit-serial">Serial Number</Label>
              <Input
                id="edit-serial"
                value={editData.serial_number}
                onChange={(e) => setEditData(prev => ({ ...prev, serial_number: e.target.value }))}
              />
            </div>
          </div>

          {/* Location Fields */}
          <LocationFieldsGroup
            areaValue={editData.parent_structure_id}
            specificLocation={editData.storage_location}
            onAreaChange={(value) => setEditData(prev => ({ ...prev, parent_structure_id: value }))}
            onSpecificLocationChange={(value) => setEditData(prev => ({ ...prev, storage_location: value }))}
            areaFieldLabel="Area"
            specificLocationPlaceholder="e.g., Shelf A2, Drawer 3"
            isLoadingAreas={isLoadingParentStructures}
            parentStructures={parentStructures}
            areaItemCounts={areaItemCounts}
          />

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <Label htmlFor="edit-status">Status</Label>
              <Select
                value={editData.status}
                onValueChange={(value) => setEditData(prev => ({ ...prev, status: value }))}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="available">Available</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div>
              <Label htmlFor="edit-accountable">Accountable Person</Label>
              <Select
                value={editData.accountable_person_id}
                onValueChange={(value) => setEditData(prev => ({ ...prev, accountable_person_id: value }))}
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
          </div>

          {editData.serial_number && editData.serial_number.trim() && tool && (
            <MetricsSection toolId={tool.id} />
          )}

          <FileAttachmentManager
            attachments={editData.attachments}
            onAttachmentsChange={(attachments) => setEditData(prev => ({ ...prev, attachments }))}
            bucket="tool-images"
            label="Tool Image"
            disabled={isSubmitting}
            maxFiles={1}
            onUploadStateChange={setIsUploadingFiles}
          />

          <div className="flex justify-end gap-2 pt-4">
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={isSubmitting || !editData.name.trim()}>
              {isSubmitting ? "Updating..." : "Update Asset"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
};