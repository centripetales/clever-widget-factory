/**
 * ExperienceCreationDialog Component
 * 
 * Dialog for manually creating experiences (state transitions S → A → S')
 * Allows users to select initial state, action (optional), and final state
 * 
 * Requirements: 5.1, 5.2, 5.3, 5.4
 */

import { useState, useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';
import { Loader2, Save, X, ArrowRight } from 'lucide-react';
import { useCreateExperience } from '@/hooks/useExperiences';
import { useStates } from '@/hooks/useStates';
import { useOrganization } from '@/hooks/useOrganization';
import { actionService } from '@/services/actionService';
import { format } from 'date-fns';
import type { CreateExperienceRequest } from '@/types/experiences';
import type { Observation } from '@/types/observations';
import type { ActionResponse } from '@/services/actionService';

// Validation schema
const experienceFormSchema = z.object({
  initial_state_id: z.string().min(1, 'Initial state is required'),
  action_id: z.string().optional(),
  final_state_id: z.string().min(1, 'Final state is required'),
});

type ExperienceFormData = z.infer<typeof experienceFormSchema>;

interface ExperienceCreationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  entityType: 'tool' | 'part';
  entityId: string;
  entityName?: string;
  onSuccess?: () => void;
}

export function ExperienceCreationDialog({
  open,
  onOpenChange,
  entityType,
  entityId,
  entityName,
  onSuccess,
}: ExperienceCreationDialogProps) {
  const [actions, setActions] = useState<ActionResponse[]>([]);
  const [isLoadingActions, setIsLoadingActions] = useState(false);
  
  const { toast } = useToast();
  const createExperience = useCreateExperience();
  const { organization } = useOrganization();
  const orgId = organization?.id ?? '';
  
  // Fetch states for this entity
  const { data: states, isLoading: isLoadingStates } = useStates(orgId, {
    entity_type: entityType,
    entity_id: entityId,
  });

  // Initialize form
  const {
    register,
    handleSubmit,
    formState: { errors },
    setValue,
    watch,
    reset,
  } = useForm<ExperienceFormData>({
    resolver: zodResolver(experienceFormSchema),
    defaultValues: {
      initial_state_id: '',
      action_id: '',
      final_state_id: '',
    },
  });

  const selectedInitialStateId = watch('initial_state_id');
  const selectedFinalStateId = watch('final_state_id');

  // Reset form when dialog opens/closes
  useEffect(() => {
    if (!open) {
      reset();
      setActions([]);
    }
  }, [open, reset]);

  // Fetch actions for this entity when dialog opens
  useEffect(() => {
    if (open && entityType && entityId) {
      const fetchActions = async () => {
        setIsLoadingActions(true);
        try {
          const fetchedActions = await actionService.listActions({
            entity_type: entityType,
            entity_id: entityId,
          });
          setActions(fetchedActions || []);
        } catch (error) {
          console.error('Error fetching actions:', error);
          toast({
            title: 'Error',
            description: 'Failed to load actions',
            variant: 'destructive',
          });
        } finally {
          setIsLoadingActions(false);
        }
      };

      fetchActions();
    }
  }, [open, entityType, entityId, toast]);

  // Get filtered states for initial state (all prior states)
  const getInitialStateOptions = (): Observation[] => {
    if (!states || states.length === 0) return [];
    
    // Sort by captured_at descending (most recent first)
    return [...states].sort((a, b) => 
      new Date(b.captured_at).getTime() - new Date(a.captured_at).getTime()
    );
  };

  // Get filtered states for final state (all states)
  const getFinalStateOptions = (): Observation[] => {
    if (!states || states.length === 0) return [];
    
    // Sort by captured_at descending (most recent first)
    return [...states].sort((a, b) => 
      new Date(b.captured_at).getTime() - new Date(a.captured_at).getTime()
    );
  };

  // Get filtered actions (actions between initial and final states if both selected)
  const getActionOptions = (): ActionResponse[] => {
    if (!actions || actions.length === 0) return [];

    if (selectedInitialState && selectedFinalState) {
      // Filter actions in the time window
      return actions.filter(action => {
        const actionDate = new Date(action.created_at);
        const initialDate = new Date(selectedInitialState.captured_at);
        const finalDate = new Date(selectedFinalState.captured_at);
        return actionDate >= initialDate && actionDate <= finalDate;
      });
    }

    // If no time window, return all actions
    return actions;
  };

  const onSubmit = async (data: ExperienceFormData) => {
    try {
      const requestData: CreateExperienceRequest = {
        entity_type: entityType,
        entity_id: entityId,
        initial_state_id: data.initial_state_id,
        final_state_id: data.final_state_id,
        ...(data.action_id && { action_id: data.action_id }),
      };

      await createExperience.mutateAsync(requestData);

      toast({
        title: 'Success',
        description: 'Experience created successfully',
      });

      onSuccess?.();
      onOpenChange(false);
    } catch (error) {
      console.error('Error creating experience:', error);
      toast({
        title: 'Error',
        description: 'Failed to create experience',
        variant: 'destructive',
      });
    }
  };

  const handleCancel = () => {
    onOpenChange(false);
  };

  const formatStateDisplay = (state: Observation): string => {
    const date = format(new Date(state.captured_at), 'MMM d, yyyy');
    const text = state.observation_text || 'No description';
    const preview = text.length > 50 ? `${text.substring(0, 50)}...` : text;
    return `${date} - ${preview}`;
  };

  const selectedInitialState = states?.find((s: Observation) => s.id === selectedInitialStateId);
  const selectedFinalState = states?.find((s: Observation) => s.id === selectedFinalStateId);

  const formatActionDisplay = (action: ActionResponse): string => {
    const date = format(new Date(action.created_at), 'MMM d, yyyy');
    const title = action.title || 'Untitled action';
    return `${date} - ${title}`;
  };

  const initialStateOptions = getInitialStateOptions();
  const finalStateOptions = getFinalStateOptions();
  const actionOptions = getActionOptions();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Create Experience</DialogTitle>
          <DialogDescription>
            Record a state transition (S → A → S') for {entityName || 'this entity'}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
          {/* Entity Context */}
          <div className="bg-muted/50 p-4 rounded-lg">
            <div className="text-sm space-y-1">
              <p>
                <strong>Entity:</strong> {entityName || entityId}
              </p>
              <p>
                <strong>Type:</strong> {entityType}
              </p>
            </div>
          </div>

          {/* Initial State Selection */}
          <div className="space-y-2">
            <Label htmlFor="initial_state_id">
              Initial State (S) <span className="text-destructive">*</span>
            </Label>
            <Select
              value={watch('initial_state_id')}
              onValueChange={(value) => setValue('initial_state_id', value)}
              disabled={isLoadingStates}
            >
              <SelectTrigger id="initial_state_id">
                <SelectValue placeholder="Select initial state..." />
              </SelectTrigger>
              <SelectContent>
                {isLoadingStates ? (
                  <div className="p-2 text-sm text-muted-foreground">
                    Loading states...
                  </div>
                ) : initialStateOptions.length === 0 ? (
                  <div className="p-2 text-sm text-muted-foreground">
                    No states available
                  </div>
                ) : (
                  initialStateOptions.map((state) => (
                    <SelectItem key={state.id} value={state.id}>
                      {formatStateDisplay(state)}
                    </SelectItem>
                  ))
                )}
              </SelectContent>
            </Select>
            {errors.initial_state_id && (
              <p className="text-sm text-destructive">
                {errors.initial_state_id.message}
              </p>
            )}
          </div>

          {/* Visual Arrow */}
          <div className="flex justify-center">
            <ArrowRight className="h-6 w-6 text-muted-foreground" />
          </div>

          {/* Action Selection (Optional) */}
          <div className="space-y-2">
            <Label htmlFor="action_id">Action (A) - Optional</Label>
            <Select
              value={watch('action_id')}
              onValueChange={(value) => setValue('action_id', value)}
              disabled={isLoadingActions}
            >
              <SelectTrigger id="action_id">
                <SelectValue placeholder="Select action (optional)..." />
              </SelectTrigger>
              <SelectContent>
                {isLoadingActions ? (
                  <div className="p-2 text-sm text-muted-foreground">
                    Loading actions...
                  </div>
                ) : actionOptions.length === 0 ? (
                  <div className="p-2 text-sm text-muted-foreground">
                    No actions available
                  </div>
                ) : (
                  actionOptions.map((action) => (
                    <SelectItem key={action.id} value={action.id}>
                      {formatActionDisplay(action)}
                    </SelectItem>
                  ))
                )}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              Select an action that caused the state transition, if documented
            </p>
          </div>

          {/* Visual Arrow */}
          <div className="flex justify-center">
            <ArrowRight className="h-6 w-6 text-muted-foreground" />
          </div>

          {/* Final State Selection */}
          <div className="space-y-2">
            <Label htmlFor="final_state_id">
              Final State (S') <span className="text-destructive">*</span>
            </Label>
            <Select
              value={watch('final_state_id')}
              onValueChange={(value) => setValue('final_state_id', value)}
              disabled={isLoadingStates}
            >
              <SelectTrigger id="final_state_id">
                <SelectValue placeholder="Select final state..." />
              </SelectTrigger>
              <SelectContent>
                {isLoadingStates ? (
                  <div className="p-2 text-sm text-muted-foreground">
                    Loading states...
                  </div>
                ) : finalStateOptions.length === 0 ? (
                  <div className="p-2 text-sm text-muted-foreground">
                    No states available
                  </div>
                ) : (
                  finalStateOptions.map((state) => (
                    <SelectItem key={state.id} value={state.id}>
                      {formatStateDisplay(state)}
                    </SelectItem>
                  ))
                )}
              </SelectContent>
            </Select>
            {errors.final_state_id && (
              <p className="text-sm text-destructive">
                {errors.final_state_id.message}
              </p>
            )}
          </div>

          {/* Actions */}
          <div className="flex justify-end gap-3 pt-4 border-t">
            <Button
              type="button"
              variant="outline"
              onClick={handleCancel}
              disabled={createExperience.isPending}
            >
              <X className="h-4 w-4 mr-2" />
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={createExperience.isPending}
            >
              {createExperience.isPending ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <Save className="h-4 w-4 mr-2" />
              )}
              {createExperience.isPending ? 'Creating...' : 'Create Experience'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
