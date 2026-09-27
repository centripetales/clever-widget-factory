import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { ArrowLeft, Camera, AlertTriangle, Edit, Flag } from 'lucide-react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiService } from '@/lib/apiService';
import { useToast } from '@/hooks/use-toast';
import { useAuth } from "@/hooks/useCognitoAuth";
import { useImageUpload } from '@/hooks/useImageUpload';
import { showErrorToast } from '@/components/ErrorToast';
import { useOrganizationId } from '@/hooks/useOrganizationId';
import { useEnhancedToast } from '@/hooks/useEnhancedToast';


interface Tool {
  id: string;
  name: string;
  description: string;
  legacy_storage_vicinity?: string;
  storage_location: string;
  status: string;
  serial_number?: string;
  category?: string;
}

interface AuditFormData {
  foundInVicinity: boolean;
  foundInLocation: boolean;
  conditionFound: 'no_problems_observed' | 'functional_but_not_efficient' | 'not_functional' | 'missing';
  auditComments: string;
  photoUrls: string[];
  flaggedForMaintenance: boolean;
  toolTested: boolean;
}

const AuditTool = () => {
  const { toolId } = useParams();
  const navigate = useNavigate();
  const { toast } = useToast();
  const { user } = useAuth();
  const organizationId = useOrganizationId();
  const queryClient = useQueryClient();
  const { uploadImages, isUploading } = useImageUpload();

  const [formData, setFormData] = useState<AuditFormData>({
    foundInVicinity: true,
    foundInLocation: true,
    conditionFound: 'no_problems_observed',
    auditComments: '',
    photoUrls: [],
    flaggedForMaintenance: false,
    toolTested: false,
  });

  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);

  // Get tool details
  const { data: tool, isLoading } = useQuery({
    queryKey: ['tool', toolId],
    queryFn: async () => {
      const response = await apiService.get(`/tools/${toolId}`);
      return response.data as Tool;
    },
    enabled: !!toolId
  });

  // Submit audit mutation
  const submitAuditMutation = useMutation({
    mutationFn: async () => {
      if (!toolId || !user) throw new Error('Missing required data');

      // Upload photos if any
      let uploadedUrls: string[] = [];
      if (selectedFiles.length > 0) {
        try {
          const results = await uploadImages(selectedFiles, { bucket: 'audit-photos' as const });
          uploadedUrls = Array.isArray(results) ? results.map(r => r.url) : [results.url];
        } catch (uploadError) {
          console.error('Error uploading photos:', uploadError);
          throw new Error('Failed to upload photos');
        }
      }

      // Create audit record
      const auditData = {
        tool_id: toolId,
        audited_by: user.userId,
        found_in_vicinity: formData.foundInVicinity,
        found_in_location: formData.foundInLocation,
        condition_found: formData.conditionFound,
        audit_comments: formData.auditComments,
        photo_urls: uploadedUrls,
        flagged_for_maintenance: formData.flaggedForMaintenance,
        last_user_identified: null,
      };

      await apiService.post('/tool_audits', auditData);

      // Update tool's last_audited_at, audit_status, and condition
      const toolUpdates: any = {
        last_audited_at: new Date().toISOString(),
        audit_status: 'audited',
        condition: formData.conditionFound === 'missing' ? 'no_problems_observed' : formData.conditionFound,
      };

      // If marked as missing, update tool status
      if (formData.conditionFound === 'missing') {
        toolUpdates.status = 'missing';
      }

      await apiService.put(`/tools/${toolId}`, toolUpdates);

      // TODO: If flagged for maintenance, create maintenance request
      // This would require a maintenance_requests table

      return { auditData, toolUpdates };
    },
    onSuccess: () => {
      toast({
        title: "Audit Completed",
        description: "Tool audit has been successfully submitted.",
      });
      queryClient.invalidateQueries({ queryKey: ['tool', toolId] });
      // Navigate back to audit execution with current parameters preserved
      navigate('/audit?step=execute');
    },
    onError: (error: any) => {
      console.error('Error submitting audit:', error);
      
      showErrorToast({
        error,
        context: {
          toolId: toolId,
          userId: user?.id,
          formData: formData,
          selectedFilesCount: selectedFiles.length,
        },
        title: "Audit Submission Failed",
        storageKey: 'lastAuditError'
      });
    },
  });

  const handleFileSelect = (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files || []);
    if (files.length > 3) {
      toast({
        title: "Too many files",
        description: "Please select a maximum of 3 photos.",
        variant: "destructive",
      });
      return;
    }
    setSelectedFiles(files);
  };

  const handleSubmit = () => {
    submitAuditMutation.mutate();
  };

  if (isLoading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div>Loading tool details...</div>
      </div>
    );
  }

  if (!tool) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div>Tool not found</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="border-b bg-card">
        <div className="flex items-center justify-between p-4">
          <div className="flex items-center gap-4">
            <Button 
              variant="ghost" 
              size="sm" 
              onClick={() => {
                if (window.history.length > 1) {
                  navigate(-1);
                } else {
                  navigate('/audit');
                }
              }}
            >
              <ArrowLeft className="h-4 w-4 mr-2" />
              Back
            </Button>
            <div>
              <h1 className="text-2xl font-bold">Audit: {tool.name}</h1>
              <p className="text-muted-foreground">
                Expected Location: {tool.legacy_storage_vicinity} → {tool.storage_location || 'No specific location'}
              </p>
            </div>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="p-6 max-w-4xl mx-auto">
        <div className="grid gap-6">
          {/* Tool Information */}
          <Card>
            <CardHeader>
              <CardTitle>Tool Information</CardTitle>
              <CardDescription>Current tool details and expected location</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label className="font-semibold">Tool Name</Label>
                  <p>{tool.name}</p>
                </div>
                <div>
                  <Label className="font-semibold">Serial Number</Label>
                  <p className="font-mono text-lg">{tool.serial_number || 'No serial number'}</p>
                </div>
                <div>
                  <Label className="font-semibold">Status</Label>
                  <p className="capitalize">{tool.status}</p>
                </div>
                <div>
                  <Label className="font-semibold">Category</Label>
                  <p>{tool.category || 'Uncategorized'}</p>
                </div>
                <div>
                  <Label className="font-semibold">Expected Vicinity</Label>
                  <p>{tool.legacy_storage_vicinity}</p>
                </div>
                <div>
                  <Label className="font-semibold">Expected Location</Label>
                  <p>{tool.storage_location || 'No specific location'}</p>
                </div>
              </div>
              
              {tool.description && (
                <div>
                  <Label className="font-semibold">Description</Label>
                  <p>{tool.description}</p>
                </div>
              )}

            </CardContent>
          </Card>

          {/* Audit Form */}
          <Card>
            <CardHeader>
              <CardTitle>Audit Form</CardTitle>
              <CardDescription>Complete the audit by filling out the form below</CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              {/* Photo Upload */}
              <div className="space-y-2">
                <Label htmlFor="photos" className="text-base font-semibold">
                  Tool Photos (Optional)
                </Label>
                <p className="text-sm text-muted-foreground">
                  Take photos of the tool in its current location if needed
                </p>
                <div className="border-2 border-dashed border-muted-foreground/25 rounded-lg p-6 text-center">
                  <Camera className="h-8 w-8 mx-auto mb-2 text-muted-foreground" />
                  <input
                    id="photos"
                    type="file"
                    accept="image/*"
                    multiple
                    onChange={handleFileSelect}
                    className="hidden"
                  />
                  <Label htmlFor="photos" className="cursor-pointer">
                    <Button type="button" variant="outline" asChild>
                      <span>
                        <Camera className="h-4 w-4 mr-2" />
                        Take Photos
                      </span>
                    </Button>
                  </Label>
                  {selectedFiles.length > 0 && (
                    <p className="mt-2 text-sm text-green-600">
                      {selectedFiles.length} photo(s) selected
                    </p>
                  )}
                </div>
              </div>

              {/* Location Verification */}
              <div className="space-y-4">
                <Label className="text-base font-semibold">Location Verification</Label>
                
                <div className="flex items-center justify-between">
                  <div>
                    <Label htmlFor="found-vicinity">Found in expected Storage Vicinity?</Label>
                    <p className="text-sm text-muted-foreground">
                      Is the tool in {tool.legacy_storage_vicinity}?
                    </p>
                  </div>
                  <Switch
                    id="found-vicinity"
                    checked={formData.foundInVicinity}
                    onCheckedChange={(checked) => 
                      setFormData(prev => ({ ...prev, foundInVicinity: checked }))
                    }
                  />
                </div>

                <div className="flex items-center justify-between">
                  <div>
                    <Label htmlFor="found-location">Found in expected Storage Location?</Label>
                    <p className="text-sm text-muted-foreground">
                      Is the tool in {tool.storage_location || 'the expected location'}?
                    </p>
                  </div>
                  <Switch
                    id="found-location"
                    checked={formData.foundInLocation}
                    onCheckedChange={(checked) => 
                      setFormData(prev => ({ ...prev, foundInLocation: checked }))
                    }
                  />
                </div>
              </div>

              {/* Condition Assessment */}
              <div className="space-y-2">
                <Label htmlFor="condition" className="text-base font-semibold">
                  Condition
                </Label>
                <Select 
                  value={formData.conditionFound} 
                  onValueChange={(value: any) => 
                    setFormData(prev => ({ ...prev, conditionFound: value }))
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="no_problems_observed">No problems detected</SelectItem>
                    <SelectItem value="functional_but_not_efficient">Functional but inefficient</SelectItem>
                    <SelectItem value="not_functional">Not functional</SelectItem>
                    <SelectItem value="missing">Missing</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {/* Tool Tested Toggle */}
              <div className="flex items-center justify-between">
                <div>
                  <Label htmlFor="tested" className="text-base font-semibold">
                    Tool Tested
                  </Label>
                  <p className="text-sm text-muted-foreground">
                    Mark if this tool was actually tested during the audit
                  </p>
                </div>
                <Switch
                  id="tested"
                  checked={formData.toolTested}
                  onCheckedChange={(checked) => 
                    setFormData(prev => ({ ...prev, toolTested: checked }))
                  }
                />
              </div>

              {/* Maintenance Flag */}
              <div className="flex items-center justify-between">
                <div>
                  <Label htmlFor="maintenance" className="text-base font-semibold">
                    Flag for Maintenance
                  </Label>
                  <p className="text-sm text-muted-foreground">
                    Mark if this tool needs maintenance attention
                  </p>
                </div>
                <Switch
                  id="maintenance"
                  checked={formData.flaggedForMaintenance}
                  onCheckedChange={(checked) => 
                    setFormData(prev => ({ ...prev, flaggedForMaintenance: checked }))
                  }
                />
              </div>

              {/* Comments */}
              <div className="space-y-2">
                <Label htmlFor="comments" className="text-base font-semibold">
                  Audit Comments
                </Label>
                <Textarea
                  id="comments"
                  placeholder="Any additional observations, issues, or notes about the tool..."
                  value={formData.auditComments}
                  onChange={(e) => 
                    setFormData(prev => ({ ...prev, auditComments: e.target.value }))
                  }
                  rows={4}
                />
              </div>

              {/* Action Buttons */}
              <div className="flex flex-wrap gap-2 pt-4 border-t">
                <Button
                  onClick={() => navigate(`/combined-assets?edit=${toolId}`)}
                  variant="outline"
                  className="flex items-center gap-2"
                >
                  <Edit className="h-4 w-4" />
                  Edit Tool Details
                </Button>
                
                {formData.conditionFound === 'missing' && (
                  <Button
                    variant="outline"
                    className="flex items-center gap-2 text-orange-600 border-orange-200"
                    onClick={() => {
                      // This would mark the tool as missing in the database
                      setFormData(prev => ({ ...prev, conditionFound: 'missing' }));
                    }}
                  >
                    <AlertTriangle className="h-4 w-4" />
                    Mark as Missing
                  </Button>
                )}

                {formData.flaggedForMaintenance && (
                  <Button
                    variant="outline"
                    className="flex items-center gap-2 text-red-600 border-red-200"
                  >
                    <Flag className="h-4 w-4" />
                    Flagged for Maintenance
                  </Button>
                )}
              </div>

              {/* Submit Button */}
              <Button 
                onClick={handleSubmit}
                disabled={submitAuditMutation.isPending || isUploading}
                className="w-full"
                size="lg"
              >
                {submitAuditMutation.isPending || isUploading ? (
                  'Submitting Audit...'
                ) : (
                  'Complete tool audit'
                )}
              </Button>
            </CardContent>
          </Card>
        </div>
      </main>
    </div>
  );
};

export default AuditTool;