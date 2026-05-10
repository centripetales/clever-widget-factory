import React, { useState, useEffect } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { apiService } from '@/lib/apiService';
import { useAssetMutations } from '@/hooks/useAssetMutations';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';
import { useOrganizationId } from '@/hooks/useOrganizationId';
import { useAuth } from "@/hooks/useCognitoAuth";
import { APP_VERSION, getBrowserInfo } from '@/lib/version';
import { ExternalLink, Info, Camera, X } from 'lucide-react';
import { TOOL_CONDITION_OPTIONS } from '@/lib/constants';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { useImageUpload } from '@/hooks/useImageUpload';import type { Tool } from '@/hooks/tools/useToolsData';

const DEFAULT_ORGANIZATION_ID = '00000000-0000-0000-0000-000000000001';


type CheckoutRecord = {
  id: string;
  tool_id: string;
  user_id: string;
  user_name: string;
  checkout_date: string;
  is_returned: boolean;
  expected_return_date?: string | null;
  intended_usage?: string | null;
  notes?: string | null;
  action_id?: string | null;
};

type CheckInForm = {
  notes: string;
  reflection: string;
  hours_used: string;
  checkin_reason: string;
};

interface ToolCheckInDialogProps {
  tool: Tool | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
}

export function ToolCheckInDialog({ tool, open, onOpenChange, onSuccess }: ToolCheckInDialogProps) {
  const organizationId = useOrganizationId();
  const { toast } = useToast();
  const { updateTool } = useAssetMutations();
  const { user } = useAuth();
  const { uploadImages, isUploading: isUploadingImages } = useImageUpload();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [checkout, setCheckout] = useState<CheckoutRecord | null>(null);
  const [form, setForm] = useState<CheckInForm>({
    tool_issues: '',
    notes: '',
    reflection: '',
    hours_used: '',
    checkin_reason: ''
  });
  const [showValidation, setShowValidation] = useState(false);
  const [selectedPhotos, setSelectedPhotos] = useState<File[]>([]);
  const [uploadedPhotoUrls, setUploadedPhotoUrls] = useState<string[]>([]);
  const [photoUploadError, setPhotoUploadError] = useState<string | null>(null);
  

  useEffect(() => {
    if (tool && open) {
      fetchCheckout();
      // Reset form and initialize known issues
      setForm({
        notes: '',
        reflection: '',
        hours_used: '',
        checkin_reason: ''
      });
      // Reset photo state
      setSelectedPhotos([]);
      setUploadedPhotoUrls([]);
      setPhotoUploadError(null);
    }
  }, [tool, open]);

  const fetchCheckout = async () => {
    if (!tool) return;

    try {
      const result = await apiService.get(`/checkouts?tool_id=${tool.id}&is_returned=false&limit=1`);
      const checkoutData = Array.isArray(result?.data) ? result.data[0] : null;
      setCheckout(checkoutData || null);
    } catch (error) {
      console.error('Error fetching checkout:', error);
      toast({
        title: "Error",
        description: "Failed to load checkout information",
        variant: "destructive",
      });
    }
  };

  const handlePhotoUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files || []);
    if (files.length === 0) return;

    setPhotoUploadError(null);
    
    try {
      const uploadResults = await uploadImages(files, {
        bucket: 'checkin-photos' as const,
        maxSizeMB: 0.8,
        maxWidthOrHeight: 1920,
        generateFileName: (file, index) => {
          const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
          const toolName = tool?.name.replace(/[^a-zA-Z0-9]/g, '-') || 'tool';
          const suffix = index ? `-${index}` : '';
          return `checkin-${toolName}-${timestamp}${suffix}-${file.name}`;
        }
      });

      const results = Array.isArray(uploadResults) ? uploadResults : [uploadResults];
      const newUrls = results.map(result => result.url);
      
      setUploadedPhotoUrls(prev => [...prev, ...newUrls]);
      setSelectedPhotos(prev => [...prev, ...files]);

      toast({
        title: "Photos uploaded successfully",
        description: `${files.length} photo${files.length > 1 ? 's' : ''} uploaded`,
      });
    } catch (error) {
      console.error('Photo upload failed:', error);
      setPhotoUploadError(error instanceof Error ? error.message : 'Failed to upload photos');
      toast({
        title: "Photo upload failed",
        description: error instanceof Error ? error.message : 'Failed to upload photos',
        variant: "destructive",
      });
    }
  };

  const removePhoto = (index: number) => {
    setUploadedPhotoUrls(prev => prev.filter((_, i) => i !== index));
    setSelectedPhotos(prev => prev.filter((_, i) => i !== index));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!checkout || !tool) {
      console.error('Cannot check in: missing checkout or tool', { checkout: !!checkout, tool: !!tool });
      toast({
        title: "Error",
        description: checkout ? "Tool information is missing" : "No active checkout found for this tool",
        variant: "destructive",
      });
      return;
    }

    // Get debugging information
    const browserInfo = getBrowserInfo();
    const debugInfo = {
      appVersion: APP_VERSION,
      userId: user?.id,
      userName: user?.user_metadata?.full_name || user?.username || user?.email || 'Unknown User',
      toolId: tool.id,
      toolName: tool.name,
      checkoutId: checkout.id,
      formData: form,
      browserInfo,
      timestamp: new Date().toISOString()
    };


    // Show validation errors
    setShowValidation(true);
    
    const missingReflection = !form.reflection;
    if (missingReflection) {
      const validationError = {
        ...debugInfo,
        error: 'Missing required fields',
        missingFields: {
          reflection: true
        }
      };
      console.error('=== CHECK-IN VALIDATION ERROR ===', validationError);
      
      toast({
        title: "Missing Required Fields",
        description: "Please fill in all required fields marked with an asterisk (*)",
        variant: "destructive",
      });
      return;
    }

    setIsSubmitting(true);
    try {
      // Create checkin record
      const checkinData: any = {
        checkout_id: checkout.id,
        tool_id: checkout.tool_id,
        user_id: user?.id,
        notes: form.notes || null,
        sop_best_practices: form.reflection,
        what_did_you_do: form.reflection,
        checkin_reason: form.checkin_reason || null,
      };


      // Add hours used if tool has motor and hours were provided
      if (tool.has_motor && form.hours_used) {
        checkinData.hours_used = parseFloat(form.hours_used);
      }

      // Add photo URLs to checkin data if any were uploaded
      if (uploadedPhotoUrls.length > 0) {
        checkinData.after_image_urls = uploadedPhotoUrls;
      }

      await apiService.post('/checkins', checkinData);

      await apiService.put(`/checkouts/${checkout.id}`, { is_returned: true });

      const locationLabel = tool.legacy_storage_vicinity
        ? tool.storage_location
          ? `${tool.legacy_storage_vicinity} - ${tool.storage_location}`
          : tool.legacy_storage_vicinity
        : tool.storage_location || null;

      await updateTool.mutateAsync({ id: tool.id, data: {
        status: 'available',
        ...(locationLabel ? { actual_location: locationLabel } : {})
      }});

      toast({
        title: "Tool checked in successfully",
        description: `${tool.name} has been checked in`,
      });

      onSuccess();
      onOpenChange(false);
    } catch (error) {
      console.error('Error checking in tool:', error);
      
      const checkInErrorLog = {
        ...debugInfo,
        error: error,
        errorMessage: error && typeof error === 'object' && 'message' in error ? error.message : 'Unknown error',
        step: 'check_in_failed'
      };
      console.error('=== CHECK-IN ERROR LOG ===', checkInErrorLog);
      
      let errorMessage = "Failed to check in tool";
      let errorDetails = "";
      
      if (error && typeof error === 'object' && 'message' in error) {
        errorDetails = String(error.message);
        
        // Provide specific guidance based on common error types
        if (errorDetails.includes('violates row-level security')) {
          errorMessage = "Permission denied";
          errorDetails = "You don't have permission to check in this tool. Please ensure you're logged in and have the necessary access rights.";
        } else if (errorDetails.includes('null value') || errorDetails.includes('not-null constraint')) {
          errorMessage = "Missing required information";
          errorDetails = "Please fill in the reflection field as it's mandatory for check-in.";
        } else if (errorDetails.includes('foreign key')) {
          errorMessage = "Data reference error";
          errorDetails = "There's an issue with the checkout record. Please try refreshing the page and checking in again.";
        } else if (errorDetails.includes('duplicate key')) {
          errorMessage = "Check-in already exists";
          errorDetails = "This tool may have already been checked in. Please refresh the page to see the current status.";
        } else if (errorDetails.includes('Tool already has an active checkout')) {
          errorMessage = "Data inconsistency detected";
          errorDetails = "There seems to be a data inconsistency. Please refresh the page and try again.";
        }
      }
      
      toast({
        title: errorMessage,
        description: errorDetails || "An unexpected error occurred. Please try again or contact support if the problem persists.",
        variant: "destructive"
      });

      // For critical errors, suggest page refresh
      if (errorDetails.includes('data inconsistency') || errorDetails.includes('foreign key')) {
        setTimeout(() => {
          toast({
            title: "Suggestion",
            description: "Consider refreshing the page to sync with the latest data.",
          });
        }, 2000);
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  if (!tool) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Check In Tool: {tool.name}</DialogTitle>
        </DialogHeader>

        {checkout ? (
          <div className="mb-4 p-3 bg-muted rounded-lg space-y-1">
            <p className="text-sm"><strong>Checked out to:</strong> {checkout.user_name}</p>
            <p className="text-sm">
              <strong>Checkout date:</strong>{" "}
              {checkout.checkout_date ? new Date(checkout.checkout_date).toLocaleString() : "N/A"}
            </p>
            <p className="text-sm">
              <strong>Storage location:</strong>{" "}
              {tool.storage_location
                ? `${tool.storage_location}${tool.legacy_storage_vicinity ? ` (${tool.legacy_storage_vicinity})` : ''}`
                : tool.legacy_storage_vicinity || 'Not specified'}
            </p>
          </div>
        ) : (
          <div className="mb-4 p-3 bg-yellow-50 border border-yellow-200 rounded-lg">
            <p className="text-sm text-yellow-800">
              <strong>Warning:</strong> No active checkout found for this tool. It may already be checked in.
            </p>
          </div>
        )}

        <TooltipProvider>
          <form onSubmit={handleSubmit} className="space-y-4">
            {tool.has_motor && (
              <div>
                <Label htmlFor="hours_used">Hours Used</Label>
                <Input
                  id="hours_used"
                  type="number"
                  step="0.1"
                  min="0"
                  value={form.hours_used}
                  onChange={(e) => setForm(prev => ({ ...prev, hours_used: e.target.value }))}
                  placeholder="Enter hours used (e.g., 2.5)"
                />
              </div>
            )}

            <div>
              <div className="flex items-center gap-2 mb-2">
                <Label htmlFor="reflection">Reflect *</Label>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button type="button" className="touch-manipulation">
                      <Info className="h-4 w-4 text-muted-foreground" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="right" align="center" className="max-w-xs">
                    <p>Reflect on your tool usage and how it aligns with our farm values.</p>
                    <p className="mt-1 text-xs">Stargazer Farm values Growth Mindset, Quality, Efficiency, Safety, Transparency, Teamwork.</p>
                  </TooltipContent>
                </Tooltip>
              </div>
              <Textarea
                id="reflection"
                value={form.reflection}
                onChange={(e) => setForm(prev => ({ ...prev, reflection: e.target.value }))}
                placeholder="Reflect on your tool usage and how it aligns with our farm values"
                rows={3}
                className={showValidation && !form.reflection ? "border-red-500" : ""}
              />
            </div>

            <div>
              <Label htmlFor="notes">Notes</Label>
              <Textarea
                id="notes"
                value={form.notes}
                onChange={(e) => setForm(prev => ({ ...prev, notes: e.target.value }))}
                placeholder="Any additional comments, observations, or notes about sub-optimal operation"
                rows={3}
              />
            </div>

            {/* Photo Upload Section */}
            <div>
              <div className="flex items-center gap-2 mb-2">
                <Camera className="h-4 w-4 text-blue-600" />
                <Label>Add Photos (Optional)</Label>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button type="button" className="touch-manipulation">
                      <Info className="h-4 w-4 text-muted-foreground" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="right" align="center" className="max-w-xs">
                    <p>Upload photos showing the tool's condition after use. Photos are automatically compressed for optimal storage.</p>
                  </TooltipContent>
                </Tooltip>
              </div>
              
              <div className="space-y-3">
                <div>
                  <input
                    type="file"
                    id="checkin-photos"
                    multiple
                    accept="image/*"
                    onChange={handlePhotoUpload}
                    className="hidden"
                    disabled={isUploadingImages}
                  />
                  <label
                    htmlFor="checkin-photos"
                    className={`
                      inline-flex items-center justify-center gap-2 px-4 py-2 border border-dashed border-muted-foreground/50 rounded-lg 
                      cursor-pointer hover:border-primary hover:bg-muted/50 transition-colors
                      ${isUploadingImages ? 'opacity-50 cursor-not-allowed' : ''}
                    `}
                  >
                    <Camera className="h-4 w-4" />
                    {isUploadingImages ? 'Uploading...' : 'Add Photos'}
                  </label>
                </div>

                {photoUploadError && (
                  <div className="text-sm text-destructive bg-destructive/10 p-2 rounded">
                    {photoUploadError}
                  </div>
                )}

                {/* Photo Previews */}
                {uploadedPhotoUrls.length > 0 && (
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                    {uploadedPhotoUrls.map((url, index) => (
                      <div key={index} className="relative group">
                        <img
                          src={url}
                          alt={`Check-in photo ${index + 1}`}
                          className="w-full h-20 object-cover rounded border"
                        />
                        <button
                          type="button"
                          onClick={() => removePhoto(index)}
                          className="absolute -top-1 -right-1 bg-destructive text-destructive-foreground rounded-full p-1 opacity-0 group-hover:opacity-100 transition-opacity"
                          title="Remove photo"
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}

                {uploadedPhotoUrls.length > 0 && (
                  <p className="text-xs text-muted-foreground">
                    {uploadedPhotoUrls.length} photo{uploadedPhotoUrls.length > 1 ? 's' : ''} will be attached to this check-in
                  </p>
                )}
              </div>
            </div>

            <div className="flex gap-2 pt-4">
              <Button
                type="submit"
                disabled={isSubmitting || isUploadingImages || !checkout}
                className="flex-1"
              >
                {isSubmitting ? "Checking In..." : "Complete Check In"}
              </Button>
            </div>
          </form>
        </TooltipProvider>
      </DialogContent>
    </Dialog>
  );
}