/**
 * PolicyCreationDialog Component
 * 
 * Dialog for creating new policies from exploration data
 * Includes AI-assisted policy draft generation
 * 
 * Requirements: 3.1, 3.2, 3.3, 3.4, 8.3
 */

import { useState, useEffect } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Calendar } from '@/components/ui/calendar';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useToast } from '@/hooks/use-toast';
import { format } from 'date-fns';
import { CalendarIcon, Sparkles, Loader2, Save, X } from 'lucide-react';
import { PolicyService, CreatePolicyRequest } from '@/services/policyService';
import { AIContentService, PolicyDraftRequest } from '@/services/aiContentService';
import { ExplorationListItem } from '@/services/explorationService';
import { cn } from '@/lib/utils';

interface PolicyCreationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  exploration: ExplorationListItem | null;
  onPolicyCreated?: (policyId: number) => void;
}

interface PolicyFormData {
  title: string;
  description_text: string;
  status: 'active' | 'deprecated';
  effective_start_date?: Date;
  effective_end_date?: Date;
  category?: string;
  priority?: 'low' | 'medium' | 'high';
}

export function PolicyCreationDialog({
  open,
  onOpenChange,
  exploration,
  onPolicyCreated
}: PolicyCreationDialogProps) {
  const [formData, setFormData] = useState<PolicyFormData>({
    title: '',
    description_text: '',
    status: 'active'
  });
  const [isGeneratingAI, setIsGeneratingAI] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [showStartDatePicker, setShowStartDatePicker] = useState(false);
  const [showEndDatePicker, setShowEndDatePicker] = useState(false);

  const { toast } = useToast();
  const policyService = new PolicyService();
  const aiContentService = new AIContentService();

  // Reset form when dialog opens/closes
  useEffect(() => {
    if (open && exploration) {
      setFormData({
        title: `Policy for ${exploration.exploration_code}`,
        description_text: '',
        status: 'active'
      });
    } else if (!open) {
      setFormData({
        title: '',
        description_text: '',
        status: 'active'
      });
    }
  }, [open, exploration]);

  const handleGenerateAIDraft = async () => {
    if (!exploration) return;

    try {
      setIsGeneratingAI(true);

      const request: PolicyDraftRequest = {
        exploration_data: {
          exploration_code: exploration.exploration_code,
          exploration_notes_text: exploration.exploration_notes_text || '',
          metrics_text: exploration.metrics_text || '',
          action_title: exploration.state_text,
          state_text: exploration.state_text
        }
      };

      const response = await aiContentService.generatePolicyDraft(request);

      if (response?.content) {
        setFormData(prev => ({
          ...prev,
          title: response.content.title || prev.title,
          description_text: response.content.description_text || prev.description_text
        }));

        toast({
          title: "AI Draft Generated",
          description: "Policy draft has been generated from exploration data",
        });
      } else {
        toast({
          title: "AI Unavailable",
          description: "AI policy generation is currently unavailable. Please create the policy manually.",
          variant: "default",
        });
      }
    } catch (error) {
      console.error('Error generating AI policy draft:', error);
      toast({
        title: "Error",
        description: "Failed to generate AI policy draft",
        variant: "destructive",
      });
    } finally {
      setIsGeneratingAI(false);
    }
  };

  const handleSave = async () => {
    if (!formData.title.trim() || !formData.description_text.trim()) {
      toast({
        title: "Validation Error",
        description: "Please provide both a title and description for the policy",
        variant: "destructive",
      });
      return;
    }

    try {
      setIsSaving(true);

      const policyData: CreatePolicyRequest = {
        title: formData.title.trim(),
        description_text: formData.description_text.trim(),
        status: formData.status,
        effective_start_date: formData.effective_start_date?.toISOString(),
        effective_end_date: formData.effective_end_date?.toISOString(),
        category: formData.category,
        priority: formData.priority
      };

      const createdPolicy = await policyService.createPolicy(policyData);

      toast({
        title: "Success",
        description: "Policy created successfully",
      });

      onPolicyCreated?.(createdPolicy.id);
      onOpenChange(false);
    } catch (error) {
      console.error('Error creating policy:', error);
      toast({
        title: "Error",
        description: "Failed to create policy",
        variant: "destructive",
      });
    } finally {
      setIsSaving(false);
    }
  };

  const handleCancel = () => {
    onOpenChange(false);
  };

  if (!exploration) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Create Policy from Exploration</DialogTitle>
          <DialogDescription>
            Create a new policy based on findings from exploration {exploration.exploration_code}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6">
          {/* AI Generation Button */}
          <div className="flex justify-end">
            <Button
              type="button"
              variant="outline"
              onClick={handleGenerateAIDraft}
              disabled={isGeneratingAI}
              className="flex items-center gap-2"
            >
              {isGeneratingAI ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Sparkles className="h-4 w-4" />
              )}
              {isGeneratingAI ? 'Generating...' : 'Generate AI Draft'}
            </Button>
          </div>

          {/* Exploration Context */}
          <div className="bg-muted/50 p-4 rounded-lg space-y-2">
            <h4 className="font-medium">Exploration Context</h4>
            <div className="text-sm space-y-1">
              <p><strong>Code:</strong> {exploration.exploration_code}</p>
              <p><strong>State:</strong> {exploration.state_text}</p>
              {exploration.exploration_notes_text && (
                <p><strong>Notes:</strong> {exploration.exploration_notes_text.substring(0, 200)}...</p>
              )}
              {exploration.metrics_text && (
                <p><strong>Metrics:</strong> {exploration.metrics_text.substring(0, 200)}...</p>
              )}
            </div>
          </div>

          {/* Policy Form */}
          <div className="space-y-4">
            {/* Title */}
            <div className="space-y-2">
              <Label htmlFor="title">Policy Title *</Label>
              <Input
                id="title"
                placeholder="Enter policy title..."
                value={formData.title}
                onChange={(e) => setFormData(prev => ({ ...prev, title: e.target.value }))}
              />
            </div>

            {/* Description */}
            <div className="space-y-2">
              <Label htmlFor="description">Policy Description *</Label>
              <Textarea
                id="description"
                placeholder="Describe the policy, its purpose, and implementation details..."
                value={formData.description_text}
                onChange={(e) => setFormData(prev => ({ ...prev, description_text: e.target.value }))}
                rows={8}
                className="min-h-[200px]"
              />
            </div>

            {/* Status and Priority */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="status">Status</Label>
                <Select
                  value={formData.status}
                  onValueChange={(value: 'active' | 'deprecated') => 
                    setFormData(prev => ({ ...prev, status: value }))
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="active">Active</SelectItem>
                    <SelectItem value="deprecated">Deprecated</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label htmlFor="priority">Priority</Label>
                <Select
                  value={formData.priority || ''}
                  onValueChange={(value: 'low' | 'medium' | 'high') => 
                    setFormData(prev => ({ ...prev, priority: value || undefined }))
                  }
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select priority" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="low">Low</SelectItem>
                    <SelectItem value="medium">Medium</SelectItem>
                    <SelectItem value="high">High</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            {/* Category */}
            <div className="space-y-2">
              <Label htmlFor="category">Category</Label>
              <Input
                id="category"
                placeholder="Enter policy category (optional)..."
                value={formData.category || ''}
                onChange={(e) => setFormData(prev => ({ ...prev, category: e.target.value || undefined }))}
              />
            </div>

            {/* Effective Dates */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Effective Start Date</Label>
                <Popover open={showStartDatePicker} onOpenChange={setShowStartDatePicker}>
                  <PopoverTrigger asChild>
                    <Button
                      variant="outline"
                      className={cn(
                        "w-full justify-start text-left font-normal",
                        !formData.effective_start_date && "text-muted-foreground"
                      )}
                    >
                      <CalendarIcon className="mr-2 h-4 w-4" />
                      {formData.effective_start_date ? (
                        format(formData.effective_start_date, "PPP")
                      ) : (
                        "Select start date"
                      )}
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-auto p-0" align="start">
                    <Calendar
                      mode="single"
                      selected={formData.effective_start_date}
                      onSelect={(date) => {
                        setFormData(prev => ({ ...prev, effective_start_date: date }));
                        setShowStartDatePicker(false);
                      }}
                      initialFocus
                    />
                  </PopoverContent>
                </Popover>
              </div>

              <div className="space-y-2">
                <Label>Effective End Date</Label>
                <Popover open={showEndDatePicker} onOpenChange={setShowEndDatePicker}>
                  <PopoverTrigger asChild>
                    <Button
                      variant="outline"
                      className={cn(
                        "w-full justify-start text-left font-normal",
                        !formData.effective_end_date && "text-muted-foreground"
                      )}
                    >
                      <CalendarIcon className="mr-2 h-4 w-4" />
                      {formData.effective_end_date ? (
                        format(formData.effective_end_date, "PPP")
                      ) : (
                        "Select end date"
                      )}
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-auto p-0" align="start">
                    <Calendar
                      mode="single"
                      selected={formData.effective_end_date}
                      onSelect={(date) => {
                        setFormData(prev => ({ ...prev, effective_end_date: date }));
                        setShowEndDatePicker(false);
                      }}
                      initialFocus
                    />
                  </PopoverContent>
                </Popover>
              </div>
            </div>
          </div>

          {/* Actions */}
          <div className="flex justify-end gap-3 pt-4 border-t">
            <Button
              type="button"
              variant="outline"
              onClick={handleCancel}
              disabled={isSaving}
            >
              <X className="h-4 w-4 mr-2" />
              Cancel
            </Button>
            <Button
              type="button"
              onClick={handleSave}
              disabled={isSaving || !formData.title.trim() || !formData.description_text.trim()}
            >
              {isSaving ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <Save className="h-4 w-4 mr-2" />
              )}
              {isSaving ? 'Creating...' : 'Create Policy'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}