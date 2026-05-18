import { useState, useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQueryClient, useQuery } from '@tanstack/react-query';
import { offlineMutationConfig, offlineQueryConfig } from '@/lib/queryConfig';
import { format } from "date-fns";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Calendar } from "@/components/ui/calendar";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useToast } from "@/hooks/use-toast";
import { useOrganizationId } from "@/hooks/useOrganizationId";
import { apiService, getApiData } from '@/lib/apiService';
import { missionsQueryKey } from '@/lib/queryKeys';
import {
  Paperclip,
  Calendar as CalendarIcon,
  Plus,
  X,
  Wrench,
  Clock,
  AlertCircle,
  Package,
  Trash2,
  CheckCircle,
  Target,
  Flag,
  Copy,
  Sparkles,
  Search,
  Handshake
} from "lucide-react";
import { useImageUpload } from "@/hooks/useImageUpload";
import { useAuth } from "@/hooks/useCognitoAuth";
import { getThumbnailUrl } from '@/lib/imageUtils';
import TiptapEditor from './TiptapEditor';
import { StatesInline } from './StatesInline';
import { AssetSelector } from './AssetSelector';
import { StockSelector } from './StockSelector';
import { MultiParticipantSelector } from './MultiParticipantSelector';
import { MissionSelector } from './MissionSelector';
import { cn, sanitizeRichText, getActionBorderStyle } from "@/lib/utils";
import { BaseAction, Profile, ActionCreationContext } from "@/types/actions";
import { generateActionUrl, copyToClipboard } from "@/lib/urlUtils";
import { useStates } from "@/hooks/useStates";
import { parseLearningTakeawayStateText, buildCopyContextText } from "@/lib/learningUtils";
import { aiContentService } from "@/services/aiContentService";
import { useActionObservationCount } from "@/hooks/useActionObservationCount";
import { PrismIcon } from "@/components/icons/PrismIcon";
import { MaxwellInlinePanel } from "@/components/MaxwellInlinePanel";
import { EntityContext } from "@/hooks/useEntityContext";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { SkillProfilePanel } from "@/components/SkillProfilePanel";
import { CapabilityAssessment } from "@/components/CapabilityAssessment";

export interface ActionFormProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  actionId?: string;
  context?: ActionCreationContext;
  profiles: Profile[];
  onActionSaved: (saved?: BaseAction) => void;
  isCreating?: boolean;
  isMaxwellOpen?: boolean;
  onMaxwellOpenChange?: (open: boolean) => void;
  maxwellContext?: EntityContext | null;
}

// Alias for backward compatibility
type UnifiedActionDialogProps = ActionFormProps;

export function ActionForm({
  open,
  onOpenChange,
  actionId,
  context,
  profiles,
  onActionSaved,
  isCreating = false,
  isMaxwellOpen = false,
  onMaxwellOpenChange,
  maxwellContext = null,
}: ActionFormProps) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  // Look up action reactively from cache — checks unresolved, completed, and single-action caches.
  // Using useQuery with select ensures the component re-renders when the cache is populated
  // (getQueryData is a non-reactive snapshot that misses async cache updates on page refresh).
  const { data: unresolvedMatch } = useQuery<BaseAction[], Error, BaseAction | undefined>({
    queryKey: ['actions'],
    queryFn: () => { throw new Error('cache-only'); },
    enabled: false,
    select: (actions) => actionId ? actions.find(a => a.id === actionId) : undefined,
    placeholderData: (prev) => prev, // Keep previous data during refetch to prevent unmount flicker
  });
  const { data: completedMatch } = useQuery<BaseAction[], Error, BaseAction | undefined>({
    queryKey: ['actions_completed'],
    queryFn: () => { throw new Error('cache-only'); },
    enabled: false,
    select: (actions) => actionId ? actions.find(a => a.id === actionId) : undefined,
    placeholderData: (prev) => prev,
  });
  const { data: singleMatch } = useQuery<BaseAction, Error, BaseAction | undefined>({
    queryKey: ['action', actionId || ''],
    queryFn: async () => {
      if (!actionId) return null as any;
      const result = await apiService.get(`/actions?id=${actionId}`);
      const actions = result.data || [];
      return actions[0] || null;
    },
    enabled: !!actionId && !unresolvedMatch && !completedMatch,
    select: (a) => (a && a.id) ? a : undefined,
    placeholderData: (prev) => prev,
  });
  const action = unresolvedMatch || completedMatch || singleMatch;
  const { toast } = useToast();
  const { isLeadership, user } = useAuth();
  const organizationId = useOrganizationId();

  const saveActionMutation = useMutation({
    mutationFn: async (actionData: any) => {
      // Use PUT for updates (when id exists), POST for creates
      if (actionData.id) {
        // For PUT requests, exclude id from body since it's in the URL path
        const { id, ...updateData } = actionData;
        const result = await apiService.put(`/actions/${id}`, updateData);
        return result;
      } else {
        const result = await apiService.post('/actions', actionData);
        return result;
      }
    },
    onMutate: async (variables) => {
      // Cancel any outgoing refetches to prevent race conditions
      await queryClient.cancelQueries({ queryKey: ['actions'] });

      // Snapshot previous state for rollback
      const previousActions = queryClient.getQueryData<BaseAction[]>(['actions']);

      // Optimistic update for immediate UI feedback (offline-first)
      if (variables.id) {
        // Update existing action
        queryClient.setQueryData<BaseAction[]>(['actions'], (old) => {
          if (!old) return old;
          return old.map(action =>
            action.id === variables.id
              ? { ...action, ...variables, updated_at: new Date().toISOString() }
              : action
          );
        });
      }
      // Don't add optimistic action for creates - wait for server response to avoid duplicates

      return { previousActions };
    },
    onSuccess: (data, variables) => {
      // Update cache with server response (no invalidation needed)
      const updatedAction = getApiData<BaseAction>(data);
      let previousAction: BaseAction | undefined;

      if (updatedAction) {
        queryClient.setQueryData<BaseAction[]>(['actions'], (old) => {
          if (!old) return old;
          const actionId = updatedAction.id || (variables as BaseAction).id;
          const existingIndex = old.findIndex(a => a.id === actionId);

          if (existingIndex >= 0) {
            // Store previous action for invalidation check
            previousAction = old[existingIndex];

            // Update existing action - prioritize server response values, fallback to what we sent
            const finalRequiredTools = updatedAction.required_tools !== undefined
              ? updatedAction.required_tools
              : (variables.required_tools !== undefined ? variables.required_tools : old[existingIndex].required_tools);

            const updated = [...old];
            updated[existingIndex] = {
              ...old[existingIndex],
              ...updatedAction,
              // Ensure required_tools and required_stock are explicitly set from server response or variables
              required_tools: finalRequiredTools,
              required_stock: updatedAction.required_stock !== undefined
                ? updatedAction.required_stock
                : (variables.required_stock !== undefined ? variables.required_stock : old[existingIndex].required_stock),
              attachments: updatedAction.attachments !== undefined
                ? updatedAction.attachments
                : (variables.attachments !== undefined ? variables.attachments : old[existingIndex].attachments)
            };
            return updated;
          } else {
            // Add new action
            return [...old, updatedAction];
          }
        });
      }

      // Invalidate related resources that might need background refresh (server-computed data)
      // Only invalidate if the action actually uses tools (required_tools changed)
      // This prevents unnecessary refetches when saving actions without tools
      const hasTools = variables.required_tools && Array.isArray(variables.required_tools) && variables.required_tools.length > 0;
      const hadTools = previousAction?.required_tools && Array.isArray(previousAction.required_tools) && previousAction.required_tools.length > 0;
      const toolsChanged = hasTools || hadTools; // Invalidate if action has or had tools

      if (toolsChanged) {
        // Invalidate checkouts and tools in background (non-blocking)
        // These will refetch when components need them, not immediately
        queryClient.invalidateQueries({ queryKey: ['checkouts'] });
        queryClient.invalidateQueries({ queryKey: ['tools'] });
      }

      // Show appropriate toast message based on action status
      const isCompleting = variables.status === 'completed' || updatedAction?.status === 'completed';
      toast({
        title: isCompleting ? "Action Completed!" : "Success",
        description: isCompleting
          ? "The action has been marked as complete and stock consumption recorded."
          : (isCreating || !action?.id ? "Action created successfully" : "Action updated successfully")
      });
      // Don't close dialog if uploads are in progress OR if this is an auto-save from upload
      if (!isUploading && !isLocalUploading && !isAutoSavingFromUploadRef.current) {
        onActionSaved(updatedAction as BaseAction);
        onOpenChange(false);
      }
    },
    onError: (error, variables, context) => {
      // Rollback on error
      if (context?.previousActions) {
        queryClient.setQueryData(['actions'], context.previousActions);
      }

      console.error('Error saving action:', error);
      toast({
        title: "Error",
        description: "Failed to save action",
        variant: "destructive"
      });
    },
    ...offlineMutationConfig,
  });


  const [formData, setFormData] = useState<Partial<BaseAction>>({});
  const [missionData, setMissionData] = useState<any>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isCompleting, setIsCompleting] = useState(false);
  // NOTE: estimatedDate removed - estimated_completion_date field removed in migration 005
  const [isFormInitialized, setIsFormInitialized] = useState(false);
  const [storedActionId, setStoredActionId] = useState<string | null>(null);
  const [currentContextType, setCurrentContextType] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<string>('');
  const [isInImplementationMode, setIsInImplementationMode] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);
  const [showMissionDialog, setShowMissionDialog] = useState(false);
  const [sharedWithPartners, setSharedWithPartners] = useState((action as any)?.shared_with_partners || false);
  const [isTogglingShared, setIsTogglingShared] = useState(false);
  // Internal Maxwell state — used when props are not provided (page mode)
  const [isMaxwellOpenInternal, setIsMaxwellOpenInternal] = useState(false);
  const [maxwellContextInternal, setMaxwellContextInternal] = useState<EntityContext | null>(null);
  // Resolve: use prop if provided (dialog mode), otherwise use internal state (page mode)
  const maxwellOpen = onMaxwellOpenChange ? isMaxwellOpen : isMaxwellOpenInternal;
  const maxwellCtx = onMaxwellOpenChange ? maxwellContext : maxwellContextInternal;
  const handleMaxwellOpenChange = (open: boolean) => {
    if (onMaxwellOpenChange) {
      onMaxwellOpenChange(open);
    } else {
      setIsMaxwellOpenInternal(open);
      if (open && action) {
        setMaxwellContextInternal({
          entityId: action.id,
          entityType: 'action',
          entityName: action.title || 'Untitled Action',
          policy: action.policy || '',
          implementation: '',
        });
      }
    }
  };
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isLocalUploading, setIsLocalUploading] = useState(false);
  const uploadCompletedTimeRef = useRef<number>(0);
  const isAutoSavingFromUploadRef = useRef<boolean>(false);
  const [attachmentFiles, setAttachmentFiles] = useState<Map<string, File>>(new Map());
  const [isGeneratingAI, setIsGeneratingAI] = useState(false);
  const [isGeneratingExpectedState, setIsGeneratingExpectedState] = useState(false);
  const [isTitleEditing, setIsTitleEditing] = useState(false);
  const titleInputRef = useRef<HTMLInputElement>(null);

  // Derive observation count from TanStack cache (preferred over database count)
  const derivedObservationCount = useActionObservationCount(action?.id || '');

  // Fetch states for the action to extract learning takeaways for Copy Context
  const { data: actionStates } = useStates({ entity_type: 'action', entity_id: action?.id });

  const preferName = (value?: string | null) => {
    if (!value) return null;
    const trimmed = value.trim();
    if (!trimmed || trimmed.includes('@')) return null;
    return trimmed;
  };

  const resolveUserFullName = () => {
    if (!user) return 'Unknown User';
    const metadataName = preferName((user as any)?.user_metadata?.full_name);
    if (metadataName) return metadataName;
    const cognitoName = preferName((user as any)?.name);
    if (cognitoName) return cognitoName;
    // Use profiles prop instead of fetching organizationMembers again
    const member = profiles.find(
      (m: any) => m.cognito_user_id === user.id || m.user_id === user.id
    );
    const memberName = preferName(member?.full_name);
    if (memberName) return memberName;
    return user.email || (user as any)?.username || 'Unknown User';
  };

  // Compute the default tab based on action state
  const getDefaultTab = () => {
    if (action && !isCreating) {
      const policyToCheck = action.policy || '';
      const hasPolicy = policyToCheck &&
        policyToCheck.trim() &&
        policyToCheck !== '<p></p>' &&
        policyToCheck !== '<p><br></p>' &&
        policyToCheck !== '<p>&nbsp;</p>';
      const hasPlanCommitment = action.plan_commitment === true;

      // Use same logic as border colors:
      // Blue border: hasPolicy && hasPlanCommitment (ready to work)
      // Yellow border: hasImplementationUpdates && hasPolicy && hasPlanCommitment (implementation in progress)
      const shouldDefaultToImplementation = hasPolicy && hasPlanCommitment;


      return shouldDefaultToImplementation ? 'observations' : 'plan';
    }
    return 'plan';
  };

  const { uploadImages, isUploading } = useImageUpload();

  // Initialize form data when dialog opens - preserve state for same session
  useEffect(() => {
    if (open) {
      const currentActionId = actionId || null;
      const contextType = context?.type || null;

      // Check if we're opening the same action/context or a different one
      const isSameSession = currentActionId === storedActionId && contextType === currentContextType;

      // Don't invalidate cache - use cached data instead (prevents 639KB refetch)
      // The cache is already up-to-date from mutations and initial load
      // Only fetch if action is truly not in cache (handled by Actions.tsx)

      const actionJustLoaded = !formData.id && action?.id;

      // Only reset form if it's a different action/context, first time opening, or the action just loaded asynchronously
      if (!isSameSession || !isFormInitialized || actionJustLoaded) {
        // Clear attachment files when opening a different action
        setAttachmentFiles(new Map());

        if (action && !isCreating) {
          setSharedWithPartners((action as any).shared_with_partners || false);
          // Editing existing action - update formData when action changes from cache
          setFormData(prev => {
            // Only update if this is a new session or attachments/required_tools/required_stock changed
            const attachmentsChanged = action.attachments?.length !== prev.attachments?.length;
            const requiredToolsChanged = JSON.stringify([...(action.required_tools || [])].sort()) !== JSON.stringify([...(prev.required_tools || [])].sort());
            const requiredStockChanged = JSON.stringify([...(action.required_stock || [])].sort()) !== JSON.stringify([...(prev.required_stock || [])].sort());

            if (!isSameSession || actionJustLoaded || attachmentsChanged || requiredToolsChanged || requiredStockChanged) {
              return {
                ...action,
                plan_commitment: action.plan_commitment || false,
                policy_agreed_at: action.policy_agreed_at || null,
                policy_agreed_by: action.policy_agreed_by || null,
                required_stock: action.required_stock || [],
                required_tools: action.required_tools || [],
                attachments: action.attachments || []
              };
            }
            return prev;
          });

          // NOTE: estimatedDate removed - field no longer exists
        } else if (context?.prefilledData) {
          // Creating new action with context
          setFormData({
            ...context.prefilledData,
            required_tools: context.prefilledData.required_tools || [],
            required_stock: context.prefilledData.required_stock || [],
            attachments: context.prefilledData.attachments || []
          });
          // NOTE: estimatedDate removed - field no longer exists
        } else {
          // Default new action
          setFormData({
            title: '',
            description: '',
            policy: '',
            assigned_to: null,
            status: 'not_started',
            plan_commitment: false,
            policy_agreed_at: null,
            policy_agreed_by: null,
            required_stock: [],
            attachments: []
          });

          // NOTE: estimatedDate removed - field no longer exists
        }

        setIsFormInitialized(true);
        setStoredActionId(currentActionId);
        setCurrentContextType(contextType);

        // Check if action is in implementation mode
        if (action && !isCreating) {
          checkImplementationMode(action);
        } else {
          setIsInImplementationMode(false);
        }
      }
    } else {
      // Reset tracking when dialog closes
      setIsFormInitialized(false);
      setStoredActionId(null);
      setCurrentContextType(null);
      setIsTitleEditing(false);
    }
  }, [open, actionId, context?.type, isCreating, action]);

  // Sync sharing state reactively when the action changes from real-time or cache updates
  useEffect(() => {
    if (action && !isCreating) {
      setSharedWithPartners((action as any).shared_with_partners || false);
    }
  }, [(action as any)?.shared_with_partners, isCreating]);

  // Update formData when action changes from cache (after refetch)
  useEffect(() => {
    // Don't sync from cache within 2 seconds of upload completing
    const timeSinceUpload = Date.now() - uploadCompletedTimeRef.current;
    if (action && !isCreating && isFormInitialized && !isUploading && !isLocalUploading && timeSinceUpload > 2000) {
      setFormData(prev => {
        // Update if attachment count, required_tools, or required_stock changed (additions or removals from cache)
        const attachmentsChanged = action.attachments?.length !== prev.attachments?.length;
        const requiredToolsChanged = JSON.stringify([...(action.required_tools || [])].sort()) !== JSON.stringify([...(prev.required_tools || [])].sort());
        const requiredStockChanged = JSON.stringify([...(action.required_stock || [])].sort()) !== JSON.stringify([...(prev.required_stock || [])].sort());

        if (attachmentsChanged || requiredToolsChanged || requiredStockChanged) {
          return {
            ...action,
            plan_commitment: action.plan_commitment || false,
            policy_agreed_at: action.policy_agreed_at || null,
            policy_agreed_by: action.policy_agreed_by || null,
            required_stock: action.required_stock || [],
            required_tools: action.required_tools || [],
            attachments: action.attachments || []
          };
        }
        return prev;
      });
    }
  }, [action?.attachments?.length, action?.required_tools, action?.required_stock, isCreating, isFormInitialized, isUploading, isLocalUploading]);

  // Fetch mission data when action has mission_id - use TanStack Query cache
  const { data: missions = [] } = useQuery({
    queryKey: missionsQueryKey(),
    queryFn: async () => {
      const result = await apiService.get('/missions');
      return result.data || [];
    },
    enabled: !!formData.mission_id && open, // Only fetch when dialog is open and we have a mission_id
    ...offlineQueryConfig,
  });

  // Find mission from cached data
  useEffect(() => {
    if (formData.mission_id && missions.length > 0) {
      const mission = missions.find((m: any) => m.id === formData.mission_id);
      setMissionData(mission || null);
    } else {
      setMissionData(null);
    }
  }, [formData.mission_id, missions]);

  const getDialogTitle = () => {
    // If we have an actionId, we're editing (even if action not in cache yet)
    if (!isCreating && (action || actionId)) {
      return action?.title || 'Edit Action';
    }

    if (context?.type === 'mission') {
      return 'Create Project Action';
    }
    if (context?.type === 'asset') {
      return 'Create Asset Action';
    }
    return 'Create New Action';
  };

  const showIssueReference = () => {
    return false; // Issue system removed
  };

  // Helper to check if there are implementation updates
  // Uses derivedObservationCount from TanStack Query cache (no API call needed)
  const hasImplementationNotes = () => {
    if (!action?.id) return false;

    // Derive count from cache using the existing hook value
    // derivedObservationCount is already computed at line 362
    return (derivedObservationCount ?? 0) > 0;
  };

  const checkImplementationMode = (action: BaseAction) => {
    if (!action?.id) {
      setIsInImplementationMode(false);
      return;
    }

    // Derive from cache using the existing hook value
    // derivedObservationCount is already computed at line 362
    setIsInImplementationMode((derivedObservationCount ?? 0) > 0);
  };

  const handleReadyForReview = async () => {
    if (!action?.id) return;

    if (!hasImplementationNotes()) {
      toast({
        title: "Error",
        description: "Please add at least one implementation update before marking as ready for review",
        variant: "destructive"
      });
      return;
    }

    setIsCompleting(true);

    try {
      // Ensure we have user ID before processing stock
      if (!user?.id) {
        toast({
          title: "Error",
          description: "User authentication is missing. Please refresh the page.",
          variant: "destructive"
        });
        setIsCompleting(false);
        return;
      }

      // Process required stock consumption if any
      const requiredStock = formData.required_stock || [];
      if (requiredStock.length > 0) {
        await processStockConsumption(requiredStock, action.id);
      }

      // Update action to completed status using saveActionMutation to ensure cache is updated
      const actionData = {
        id: action.id,
        title: formData.title,
        description: formData.description,
        expected_state: formData.expected_state,
        policy: formData.policy,
        assigned_to: formData.assigned_to,
        required_stock: formData.required_stock,
        required_tools: formData.required_tools,
        attachments: formData.attachments,
        status: 'completed',
        completed_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      };

      // Use the mutation to ensure cache is properly updated
      await saveActionMutation.mutateAsync(actionData);

      // The mutation's onSuccess handler will update the cache with the completed status,
      // show toast, call onActionSaved, and close the dialog
      // No need to do anything else here - the mutation handles everything
    } catch (error: any) {
      console.error('Error completing action:', error);

      // Provide more specific error messages
      let errorMessage = "Failed to complete action and record stock usage";
      if (error?.message) {
        if (error.message.includes('no longer exists in inventory')) {
          // This is the specific error for missing parts - show the full message
          errorMessage = error.message;
        } else if (error.message.includes('Part with ID') && error.message.includes('not found')) {
          errorMessage = `Stock item not found. Please check that all required stock items still exist.`;
        } else if (error.message.includes('stock consumption')) {
          errorMessage = `Failed to process stock consumption: ${error.message}`;
        } else if (error.message.includes('network') || error.message.includes('fetch')) {
          errorMessage = "Network error. Please check your connection and try again.";
        } else {
          errorMessage = error.message;
        }
      }

      toast({
        title: "Error",
        description: errorMessage,
        variant: "destructive"
      });
    } finally {
      setIsCompleting(false);
    }
  };

  const handleCopyLink = async () => {
    if (!action?.id) {
      toast({
        title: "Cannot copy link",
        description: "Please save the action first before copying its link",
        variant: "destructive",
      });
      return;
    }

    const actionUrl = generateActionUrl(action.id);
    const success = await copyToClipboard(actionUrl);

    if (success) {
      setLinkCopied(true);
      toast({
        title: "Link copied!",
        description: "Action link has been copied to your clipboard",
      });
      setTimeout(() => setLinkCopied(false), 2000);
    } else {
      toast({
        title: "Could not copy automatically",
        description: actionUrl,
        duration: 10000,
      });
    }
  };

  const handleToggleShared = async () => {
    if (!action?.id || isTogglingShared) return;

    setIsTogglingShared(true);
    const nextShared = !sharedWithPartners;

    try {
      await apiService.put(`/actions/${action.id}`, { shared_with_partners: nextShared });
      setSharedWithPartners(nextShared);

      toast({
        title: nextShared ? "Sharing activated" : "Sharing restricted",
        description: nextShared
          ? "Action details are now safely shared with trusted partners."
          : "Sharing revoked. Action details are now private.",
      });

      // Invalidate queries so lists update
      queryClient.invalidateQueries({ queryKey: ['actions'] });
      if (onActionSaved) {
        onActionSaved();
      }
    } catch (error) {
      console.error('Error toggling action sharing state:', error);
      toast({
        title: "Error",
        description: "Failed to update action sharing policy.",
        variant: "destructive"
      });
    } finally {
      setIsTogglingShared(false);
    }
  };

  // Copy action context and learning takeaways to clipboard for external AI tools
  const handleCopyContext = async () => {
    const actionFields = {
      title: formData.title as string | undefined,
      description: formData.description as string | undefined,
      expected_state: formData.expected_state as string | undefined,
      policy: formData.policy as string | undefined,
    };

    // Filter fetched states for [learning_takeaway] prefix and extract takeaway texts
    const takeawayTexts: string[] = [];
    if (actionStates && Array.isArray(actionStates)) {
      for (const state of actionStates) {
        const parsed = parseLearningTakeawayStateText(state.state_text || '');
        if (parsed) {
          takeawayTexts.push(parsed.takeawayText);
        }
      }
    }

    const text = buildCopyContextText(actionFields, takeawayTexts);
    const success = await copyToClipboard(text);

    if (success) {
      toast({
        title: "Context copied!",
        description: "Action context and takeaways copied to clipboard",
      });
    } else {
      toast({
        title: "Could not copy automatically",
        description: text,
        duration: 10000,
      });
    }
  };

  // Generate AI summary policy text
  const generateAISummaryPolicy = async () => {
    if (!formData.description && !formData.policy) {
      toast({
        title: "Missing Information",
        description: "Please add a description or policy text first",
        variant: "destructive"
      });
      return;
    }

    setIsGeneratingAI(true);
    try {
      const response = await aiContentService.generateSummaryPolicy({
        state_text: formData.description || '',
        policy_text: formData.policy || '',
        action_context: {
          title: formData.title,
          assigned_to: formData.assigned_to || undefined,
          priority: 'normal' // Could be enhanced with actual priority field
        }
      });

      if (response?.content?.summary_policy_text) {
        // Update the Action Policy field with the generated text
        setFormData(prev => ({
          ...prev,
          policy: response.content.summary_policy_text
        }));
        toast({
          title: "AI Suggestion Generated",
          description: "Action policy has been updated with AI-generated content. You can edit it as needed.",
        });
      } else {
        toast({
          title: "AI Unavailable",
          description: "AI service is currently unavailable. Please enter the policy manually.",
          variant: "destructive"
        });
      }
    } catch (error) {
      console.error('Error generating AI summary:', error);
      toast({
        title: "Error",
        description: "Failed to generate AI summary",
        variant: "destructive"
      });
    } finally {
      setIsGeneratingAI(false);
    }
  };

  // Generate AI expected state (S') text
  const generateAIExpectedState = async () => {
    if (!formData.title && !formData.description) {
      toast({
        title: "Missing Information",
        description: "Please add a title or description first",
        variant: "destructive"
      });
      return;
    }

    setIsGeneratingExpectedState(true);
    try {
      const response = await aiContentService.generateExpectedState({
        title: formData.title || '',
        description: formData.description || '',
        asset_name: formData.asset?.name,
        mission_title: missionData?.title
      });

      if (response?.content?.expected_state) {
        setFormData(prev => ({
          ...prev,
          expected_state: response.content.expected_state
        }));
        toast({
          title: "AI Suggestion Generated",
          description: "Expected state has been updated with AI-generated content. You can edit it as needed.",
        });
      } else {
        toast({
          title: "AI Unavailable",
          description: "AI service is currently unavailable. Please enter the expected state manually.",
          variant: "destructive"
        });
      }
    } catch (error) {
      console.error('Error generating AI expected state:', error);
      toast({
        title: "Error",
        description: "Failed to generate AI expected state",
        variant: "destructive"
      });
    } finally {
      setIsGeneratingExpectedState(false);
    }
  };

  const processStockConsumption = async (requiredStock: any[], actionId: string) => {
    if (!requiredStock || requiredStock.length === 0) {
      return; // No stock to process
    }

    if (!user?.id) {
      console.error('User ID required for stock consumption', {
        userId: user?.id
      });
      toast({
        title: "Error",
        description: "Unable to process stock consumption: user information missing",
        variant: "destructive"
      });
      return;
    }

    try {
      // Use the utility function from utils.ts
      // Organization ID is handled by the backend authorizer, not needed here
      const { processStockConsumption: processStock } = await import('@/lib/utils');
      await processStock(
        requiredStock,
        actionId,
        user.id,
        formData.title || action?.title || 'Unknown Action',
        action?.mission_id ?? undefined,
        queryClient // Pass queryClient to use cached parts data
      );
    } catch (error: any) {
      console.error('Error processing stock consumption:', error);

      // Provide more specific error message
      let errorMessage = "Failed to process stock consumption";
      if (error?.message) {
        if (error.message.includes('no longer exists in inventory')) {
          // This is the specific error for missing parts - show the full message
          errorMessage = error.message;
        } else if (error.message.includes('Part with ID') && error.message.includes('not found')) {
          errorMessage = `Stock item not found: ${error.message}`;
        } else if (error.message.includes('network') || error.message.includes('fetch')) {
          errorMessage = "Network error while processing stock. Please check your connection.";
        } else {
          errorMessage = `Stock processing error: ${error.message}`;
        }
      }

      toast({
        title: "Error",
        description: errorMessage,
        variant: "destructive"
      });
      throw error; // Re-throw so calling function can handle it
    }
  };


  const handleFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files;
    if (!files || files.length === 0) return;

    const fileArray = Array.from(files);
    event.target.value = '';
    setIsLocalUploading(true);

    try {
      const uploadResults = await uploadImages(fileArray, { bucket: 'mission-attachments' as const });
      const resultsArray = Array.isArray(uploadResults) ? uploadResults : [uploadResults];
      const uploadedUrls = resultsArray.map(result => result.url);

      if (uploadedUrls.length === 0) {
        throw new Error('No files were uploaded successfully');
      }

      const newAttachments = [...(formData.attachments || []), ...uploadedUrls];

      // Store File objects for local preview (avoid fetching from S3)
      setAttachmentFiles(prev => {
        const next = new Map(prev);
        uploadedUrls.forEach((url, index) => {
          next.set(url, fileArray[index]);
        });
        return next;
      });

      // Update formData immediately
      setFormData(prev => ({
        ...prev,
        attachments: newAttachments
      }));

      toast({
        title: "Success",
        description: `${uploadedUrls.length} file(s) uploaded successfully`
      });

      // Mark upload completion time to prevent immediate cache sync
      uploadCompletedTimeRef.current = Date.now();

      // Auto-save if editing existing action
      // CRITICAL: Set flag BEFORE mutation and clear it AFTER mutation completes
      // to prevent dialog from closing during the save operation
      if (action?.id) {
        try {
          isAutoSavingFromUploadRef.current = true;
          await saveActionMutation.mutateAsync({
            id: action.id,
            attachments: newAttachments
          });
          // Clear flag AFTER mutation completes successfully
          // This ensures onSuccess sees the flag as true and keeps dialog open
          isAutoSavingFromUploadRef.current = false;
        } catch (saveError) {
          console.error('[DIALOG] Auto-save failed:', saveError);
          // Clear flag on error too
          isAutoSavingFromUploadRef.current = false;
          // Don't show error - attachments are still in formData and will save on manual save
        }
      }
    } catch (error) {
      console.error('Upload failed:', error);
      toast({
        title: "Upload Failed",
        description: error instanceof Error ? error.message : "Failed to upload files",
        variant: "destructive"
      });
    } finally {
      setIsLocalUploading(false);
    }
  };



  const removeAttachment = (index: number) => {
    const urlToRemove = formData.attachments?.[index];
    if (urlToRemove) {
      // Clean up File object if it exists
      setAttachmentFiles(prev => {
        const next = new Map(prev);
        next.delete(urlToRemove);
        return next;
      });
    }
    setFormData(prev => ({
      ...prev,
      attachments: (prev.attachments || []).filter((_, i) => i !== index)
    }));
  };

  const handleDelete = async () => {
    if (!action?.id) return;

    if (!confirm('Are you sure you want to delete this action? This cannot be undone.')) {
      return;
    }

    setIsSubmitting(true);

    try {
      await apiService.delete(`/actions/${action.id}`);

      toast({
        title: "Success",
        description: "Action deleted successfully"
      });

      onActionSaved();
      onOpenChange(false);
    } catch (error) {
      console.error('Error deleting action:', error);
      toast({
        title: "Error",
        description: "Failed to delete action",
        variant: "destructive"
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!formData.title?.trim()) {
      toast({
        title: "Error",
        description: "Please enter an action title",
        variant: "destructive"
      });
      return;
    }

    // Validate exploration fields if exploration is enabled
    // (exploration feature removed)

    setIsSubmitting(true);

    try {
      // Normalize rich text content
      const normalizedPolicy = sanitizeRichText(formData.policy);

      const actionStatus = formData.status || 'not_started';

      // Get current user ID
      const userId = user?.id || '00000000-0000-0000-0000-000000000000';

      const actionData: any = {
        title: formData.title.trim(),
        description: formData.description || null,
        expected_state: formData.expected_state || null,
        policy: normalizedPolicy,
        assigned_to: formData.assigned_to === 'unassigned' ? null : formData.assigned_to || null,
        participants: formData.participants || [],
        required_stock: formData.required_stock || [],
        required_tools: Array.isArray(formData.required_tools) ? formData.required_tools : [],
        // Always include attachments array, even if empty, so removals are properly saved
        attachments: Array.isArray(formData.attachments) ? formData.attachments : [],
        mission_id: formData.mission_id || null,
        asset_id: formData.asset_id || null,
        status: actionStatus,
        plan_commitment: formData.plan_commitment || false,
        policy_agreed_at: formData.policy_agreed_at || null,
        policy_agreed_by: formData.policy_agreed_by || null,
        created_by: isCreating || !action?.id ? userId : (action as any).created_by || userId,
        updated_by: userId,
      };

      const savedAction = await saveActionMutation.mutateAsync(isCreating || !action?.id ? actionData : { ...actionData, id: action.id });
    } catch (error) {
      // Error handled by mutation onError
    } finally {
      setIsSubmitting(false);
    }
  };

  // Get border styling based on current form data
  // Fallback to action data when formData hasn't loaded yet (handles async loading)
  const borderStyleInput = {
    status: action?.status || formData.status || 'not_started',
    policy: formData.policy || action?.policy,
    assigned_to: formData.assigned_to || action?.assigned_to,
    plan_commitment: formData.plan_commitment ?? action?.plan_commitment ?? false,
  };

  const borderStyle = getActionBorderStyle(borderStyleInput, derivedObservationCount);


  /**
   * CRITICAL: Prevent closing during file upload.
   *
   * This prevents a regression where closing during upload caused unwanted
   * navigation to /actions on mobile devices.
   *
   * DO NOT REMOVE THIS CHECK without:
   * 1. Understanding the mobile upload flow
   * 2. Testing on real mobile devices
   * 3. Ensuring navigation doesn't occur during upload
   * 4. Updating the test in UnifiedActionDialog.upload.test.tsx
   *
   * See: src/components/__tests__/UnifiedActionDialog.upload.test.tsx
   */
  const handleCloseRequest = (newOpen: boolean) => {
    if (!newOpen && (isUploading || isLocalUploading)) {
      toast({
        title: "Upload in progress",
        description: "Please wait for the upload to complete before closing.",
        variant: "default",
        duration: 3000
      });
      return;
    }
    // Clear attachment files when closing
    if (!newOpen) {
      setAttachmentFiles(new Map());
    }
    onOpenChange(newOpen);
  };

  return (
    <>
      <div
        className={cn(
          "space-y-4 sm:space-y-6",
        )}
      >
        {/* Header row: title + action buttons */}
        <div className="flex items-center gap-2 min-w-0 flex-1">
          {!isCreating && action?.id ? (
            isTitleEditing ? (
              <Input
                ref={titleInputRef}
                value={formData.title || ''}
                onChange={(e) => setFormData(prev => ({ ...prev, title: e.target.value }))}
                onBlur={() => setIsTitleEditing(false)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === 'Escape') setIsTitleEditing(false); }}
                className="h-7 text-base font-semibold flex-1"
                autoFocus
              />
            ) : (
              <div
                className="min-w-0 cursor-pointer flex-1"
                onClick={() => setIsTitleEditing(true)}
                title="Edit title"
              >
                <h2 className="text-lg font-semibold truncate">{formData.title || action?.title || 'Untitled'}</h2>
              </div>
            )
          ) : (
            <h2 className="text-lg font-semibold flex-1">{getDialogTitle()}</h2>
          )}
          <div className="flex items-center gap-2">
            {!isCreating && action?.id && (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleCopyLink}
                  className={`h-7 w-7 p-0 ${linkCopied ? 'border-green-500 border-2' : ''}`}
                  title="Copy action link"
                >
                  {linkCopied ? (
                    <CheckCircle className="h-4 w-4 text-green-600" />
                  ) : (
                    <Copy className="h-4 w-4" />
                  )}
                </Button>
              </>
            )}
            <Button
              variant="outline"
              size="sm"
              onClick={() => setShowMissionDialog(true)}
              className={`h-7 w-7 p-0 ${formData.mission_id ? 'bg-primary/10 border-primary/50' : ''}`}
              title={formData.mission_id ? "Change linked project" : "Link to project"}
            >
              <Flag className="h-4 w-4" />
            </Button>

            {!isCreating && action?.id && (
              <Button
                variant="outline"
                size="sm"
                onClick={handleToggleShared}
                disabled={isTogglingShared}
                className={`h-7 w-7 p-0 transition-colors duration-200 ${sharedWithPartners
                    ? 'bg-emerald-50 text-emerald-700 border-emerald-200 hover:bg-emerald-100 dark:bg-emerald-950/30 dark:text-emerald-400 dark:border-emerald-900/50'
                    : 'hover:text-emerald-600 hover:bg-emerald-50'
                  }`}
                title={sharedWithPartners ? "Stop sharing with trusted partners" : "Share with trusted partners"}
              >
                {isTogglingShared ? (
                  <div className="h-3 w-3 animate-spin rounded-full border-2 border-primary border-t-transparent" />
                ) : (
                  <Handshake className="h-4 w-4" />
                )}
              </Button>
            )}

            {!isCreating && action?.id && (
              <Button
                variant="ghost"
                size="sm"
                type="button"
                onClick={() => handleMaxwellOpenChange(!maxwellOpen)}
                className={`h-8 w-8 p-0 [&_svg]:size-auto ${maxwellOpen ? 'bg-primary/10 text-primary' : ''}`}
                title="Ask Maxwell"
              >
                <PrismIcon size={28} />
              </Button>
            )}
          </div>
        </div>

        {/* Issue Reference Display */}
        {showIssueReference() && (
          <div className="bg-muted p-3 rounded-lg">
            <div className="flex items-center gap-2 mb-1">
              <AlertCircle className="h-4 w-4" />
              <h4 className="font-semibold text-sm">Linked Issue Reference</h4>
            </div>
            <p className="text-sm text-muted-foreground">
              {formData.issue_reference || `Issue ID: ${formData.linked_issue_id}`}
            </p>
          </div>
        )}

        {/* Mission Context Display */}
        {missionData && (
          <div className="bg-primary/5 border border-primary/20 p-3 rounded-lg">
            <div className="flex items-center gap-2 mb-1">
              <Flag className="h-4 w-4 text-primary" />
              <h4 className="font-semibold text-sm">Project Context</h4>
            </div>
            <div className="space-y-1">
              <p className="text-sm font-medium">
                Project #{missionData.mission_number}: {missionData.title}
              </p>
              <p className="text-sm text-muted-foreground">
                {missionData.problem_statement}
              </p>
              <div className="flex items-center gap-2 mt-1">
                <Badge variant="secondary" className="text-xs">
                  {missionData.status}
                </Badge>
              </div>
            </div>
          </div>
        )}

        {/* Maxwell panel — animated expand above title */}
        <div
          className={`grid transition-all duration-300 ease-in-out ${maxwellOpen && !isCreating && action?.id ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'}`}
        >
          <div className="overflow-hidden">
            <div className="rounded-xl border overflow-hidden" style={{ height: '600px' }}>
              <MaxwellInlinePanel
                context={maxwellCtx}
                onClose={() => handleMaxwellOpenChange(false)}
                className="h-full rounded-none border-0"
                hideHeader
              />
            </div>
          </div>
        </div>

        {/* Title — only shown when creating; edit mode uses inline title in header */}
        {isCreating && (
          <div>
            <Label htmlFor="actionTitle" className="text-sm font-medium break-words">
              Title *
            </Label>
            <Input
              id="actionTitle"
              value={formData.title || ''}
              onChange={(e) => setFormData(prev => ({ ...prev, title: e.target.value }))}
              placeholder="Short description of what must be done"
              className="mt-1"
            />
          </div>
        )}

        {/* Description */}
        <div>
          <Label htmlFor="description">Existing State</Label>
          <Textarea
            id="description"
            value={formData.description || ''}
            onChange={(e) => setFormData(prev => ({ ...prev, description: e.target.value }))}
            placeholder="Provide some background."
            className="mt-1"
            rows={3}
          />
        </div>

        {/* Expected State (S') */}
        <div>
          <div className="flex items-center justify-between">
            <Label htmlFor="expectedState">Where we want to get to</Label>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={generateAIExpectedState}
              disabled={isGeneratingExpectedState || (!formData.title && !formData.description)}
              className="h-7 px-2 text-xs"
            >
              {isGeneratingExpectedState ? (
                <div className="h-3 w-3 animate-spin rounded-full border-2 border-primary border-t-transparent mr-1" />
              ) : (
                <Sparkles className="h-3 w-3 mr-1" />
              )}
              AI Assist
            </Button>
          </div>
          <Textarea
            id="expectedState"
            value={formData.expected_state || ''}
            onChange={(e) => setFormData(prev => ({ ...prev, expected_state: e.target.value }))}
            placeholder="Describe the desired outcome — what does 'done' look like?"
            className="mt-1"
            rows={2}
          />
        </div>

        {/* Assigned To, Participants, and Estimated Completion Date */}
        {/* Assigned To and Participants Row */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-4">
          <div className="space-y-2">
            <Label htmlFor="assignedTo" className="text-sm font-medium break-words">
              Assigned To
            </Label>
            <Select
              value={formData.assigned_to || 'unassigned'}
              onValueChange={(value) => setFormData(prev => ({
                ...prev,
                assigned_to: value === 'unassigned' ? null : value
              }))}
            >
              <SelectTrigger className="mt-1">
                <SelectValue placeholder="Select assignee..." />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="unassigned">Unassigned</SelectItem>
                {profiles.map((profile) => (
                  <SelectItem key={profile.user_id} value={profile.user_id}>
                    {profile.full_name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="participants" className="text-sm font-medium break-words">
              Participants
            </Label>
            <div className="mt-1">
              <MultiParticipantSelector
                participants={formData.participants || []}
                onParticipantsChange={(participants) => setFormData(prev => ({ ...prev, participants }))}
                profiles={profiles}
                assigneeId={formData.assigned_to}
              />
            </div>
          </div>
        </div>

        {/* NOTE: Estimated Completion Date field removed in migration 005 */}
        {/* Duration tracking now uses objective data like image metadata */}

        {/* Skill Profile Panel — only for existing actions */}
        {!isCreating && action?.id && typeof action.id === 'string' && action.id.length > 0 && (
          <SkillProfilePanel action={action} userId={user?.id || ''} organizationId={organizationId} />
        )}

        {/* Growth Checklist Radar Chart — only for existing actions with a valid ID */}
        {!isCreating && action?.id && typeof action.id === 'string' && action.id.length > 0 && (
          <CapabilityAssessment action={{
            ...action,
            assigned_to: formData.assigned_to || action.assigned_to,
            participants: formData.participants || action.participants,
          }} />
        )}

        {/* Plan Commitment Toggle - Only show when assigned and user is leadership */}
        {formData.assigned_to && formData.assigned_to !== 'unassigned' && isLeadership && (
          <div className="pt-1 border-t border-border">
            <div className="flex items-start space-x-3">
              <Switch
                id="plan-commitment"
                checked={formData.plan_commitment || false}
                onCheckedChange={async (checked) => {
                  setFormData({
                    ...formData,
                    plan_commitment: checked,
                    policy_agreed_at: checked ? new Date().toISOString() : null,
                    policy_agreed_by: checked ? user?.id : null,
                    status: checked ? 'in_progress' : 'not_started'
                  });
                }}
              />
              <Label
                htmlFor="plan-commitment"
                className="text-sm leading-5 cursor-pointer"
              >
                {(() => {
                  const assignee = profiles.find(p => p.user_id === formData.assigned_to);
                  const assigneeName = assignee?.full_name || 'The assignee';
                  return `${assigneeName} and leadership agreed to this action plan.`;
                })()}
              </Label>
            </div>
          </div>
        )}

        {/* Assets and Stock Row */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 md:gap-4">
          {/* Assets */}
          <div className="space-y-2">
            <Label className="flex items-center gap-1 break-words">
              <Wrench className="w-4 h-4 flex-shrink-0" />
              Assets
            </Label>
            <AssetSelector
              formData={formData}
              setFormData={setFormData}
            />
          </div>

          {/* Stock */}
          <div className="space-y-2">
            <Label className="flex items-center gap-1 break-words">
              <Package className="w-4 h-4 flex-shrink-0" />
              Stock
            </Label>
            <StockSelector
              selectedStock={formData.required_stock || []}
              onStockChange={(stock) => setFormData(prev => ({
                ...prev,
                required_stock: stock
              }))}
            />
          </div>
        </div>

        <Tabs value={activeTab || getDefaultTab()} onValueChange={setActiveTab} className="w-full">
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="plan">Policy</TabsTrigger>
            <TabsTrigger value="observations">Implementation</TabsTrigger>
          </TabsList>

          <TabsContent value="plan" className="mt-4">
            <div>
              <div className="flex items-center justify-between">
                <Label className="text-foreground">Action Policy</Label>
                <div className="flex items-center gap-1">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={handleCopyContext}
                    className="h-7 px-2 text-xs"
                  >
                    <Copy className="h-3 w-3 mr-1" />
                    Copy Context
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={generateAISummaryPolicy}
                    disabled={isGeneratingAI || (!formData.description && !formData.policy)}
                    className="h-7 px-2 text-xs"
                  >
                    {isGeneratingAI ? (
                      <div className="h-3 w-3 animate-spin rounded-full border-2 border-primary border-t-transparent mr-1" />
                    ) : (
                      <Sparkles className="h-3 w-3 mr-1" />
                    )}
                    AI Assist
                  </Button>
                </div>
              </div>
              <div className="mt-2 border rounded-lg">
                <TiptapEditor
                  key={`plan-${action?.id || 'new'}`}
                  value={formData.policy || ''}
                  onChange={(value) => setFormData(prev => ({ ...prev, policy: value }))}
                  placeholder="Describe the policy for this action..."
                />
              </div>
            </div>
          </TabsContent>

          <TabsContent value="observations" className="mt-4">
            {action?.id ? (
              <StatesInline
                entity_type="action"
                entity_id={action.id}
              />
            ) : (
              <div className="text-center text-muted-foreground py-8">
                <p>Save the action first to add observations</p>
              </div>
            )}
          </TabsContent>

        </Tabs>

        {/* Attachments + State Space */}
        <div className="flex gap-4">
          <div className={!isCreating && action?.id ? "flex-1" : "w-full"}>
            <Label className="text-sm font-medium break-words">Attachments (Images & PDFs)</Label>
            <div className="mt-1">
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept="image/*,.pdf"
                onChange={handleFileUpload}
                className="hidden"
                id="attachmentUpload"
                disabled={isUploading || isLocalUploading}
                key={`file-input-${action?.id || 'new'}`}
              />
              <Button
                type="button"
                variant="outline"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  fileInputRef.current?.click();
                }}
                disabled={isUploading || isLocalUploading}
                className="w-full"
              >
                <Paperclip className="h-4 w-4 mr-2" />
                {(isUploading || isLocalUploading) ? 'Uploading...' : 'Upload Images & PDFs'}
              </Button>
            </div>

            {/* Display uploaded attachments */}
            {(formData.attachments || []).length > 0 && (
              <div className="mt-3 space-y-2">
                <p className="text-sm text-muted-foreground">Uploaded attachments:</p>
                <div className="flex flex-wrap gap-2">
                  {(formData.attachments || []).map((url, index) => {
                    const isPdf = url.toLowerCase().endsWith('.pdf');
                    const fullUrl = url.startsWith('http') ? url : `https://cwf-dev-assets.s3.us-west-2.amazonaws.com/${url}`;

                    // Use local File object if available (just uploaded), otherwise fetch from S3
                    const file = attachmentFiles.get(url);
                    const thumbnailUrl = getThumbnailUrl(url);
                    const displayUrl = file ? URL.createObjectURL(file) : (thumbnailUrl || fullUrl);

                    return (
                      <div key={index} className="relative">
                        {isPdf ? (
                          <div
                            className="h-16 w-16 flex items-center justify-center bg-muted rounded border cursor-pointer hover:bg-muted/80"
                            onClick={() => window.open(fullUrl, '_blank')}
                          >
                            <svg className="h-8 w-8 text-destructive" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
                            </svg>
                          </div>
                        ) : (
                          <img
                            src={displayUrl}
                            alt={`Attachment ${index + 1}`}
                            className="h-16 w-16 object-cover rounded border cursor-pointer"
                            onClick={() => window.open(fullUrl, '_blank')}
                          />
                        )}
                        <Button
                          size="sm"
                          variant="destructive"
                          onClick={() => removeAttachment(index)}
                          className="absolute -top-1 -right-1 h-5 w-5 rounded-full p-0"
                        >
                          ×
                        </Button>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>

          {/* State Space gundam button — only for existing actions */}
          {/* TODO: Re-enable Join Mission feature
            {!isCreating && action?.id && (
              <div className="flex-1 flex flex-col items-center justify-center">
                <Label className="text-sm font-medium mb-1">Join Mission</Label>
                <button
                  onClick={() => navigate(`/actions/${action.id}/state-space`)}
                  className="hover:opacity-80 transition-opacity"
                >
                  <img
                    src="/dormant_gundam_state.png"
                    alt="State Space"
                    className="w-3/4 rounded-lg border object-contain transition-transform duration-200 hover:scale-110"
                  />
                </button>
              </div>
            )}
            */}
          {!isCreating && action?.id && (
            <div className="flex-1 flex flex-col items-center justify-center">
              <Button
                variant="outline"
                onClick={() => navigate(`/actions/${action.id}/state-space`)}
              >
                Model
              </Button>
            </div>
          )}
        </div>

        {/* Action Buttons */}
        <div className="flex flex-wrap gap-3 pt-4 min-w-0">
          {!isCreating && action?.id && (
            <Button
              variant="outline"
              size="sm"
              onClick={handleDelete}
              disabled={isSubmitting}
              className="text-muted-foreground hover:text-foreground"
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          )}
          <Button
            variant="outline"
            onClick={() => handleCloseRequest(false)}
            className="flex-1 min-w-0"
          >
            Cancel
          </Button>
          {!isCreating && action?.id && action.status !== 'completed' && (
            <Button
              onClick={handleReadyForReview}
              disabled={isCompleting || isSubmitting}
              className="flex-1 min-w-0 bg-emerald-600 hover:bg-emerald-700 text-white"
            >
              <CheckCircle className="h-4 w-4 mr-2" />
              {isCompleting ? 'Marking Complete...' : 'Done'}
            </Button>
          )}
          <Button
            onClick={handleSubmit}
            disabled={isSubmitting || isUploading || isLocalUploading}
            className="flex-1 min-w-0"
          >
            {isSubmitting ? (isCreating ? 'Creating...' : 'Saving...') : (isCreating ? 'Create Action' : 'Save Changes')}
          </Button>
        </div>
      </div>

      {/* Mission Selection Dialog */}
      <Dialog open={showMissionDialog} onOpenChange={setShowMissionDialog}>
        <DialogContent className="max-w-md w-full">
          <DialogHeader>
            <DialogTitle>Link to Project</DialogTitle>
            <DialogDescription>
              Search and select a project to link this action to.
            </DialogDescription>
          </DialogHeader>
          <div className="mt-4 min-w-0">
            <MissionSelector
              selectedMissionId={formData.mission_id}
              onMissionChange={(missionId) => {
                setFormData(prev => ({
                  ...prev,
                  mission_id: missionId || null,
                  // Clear other parent relationships when linking to mission
                  asset_id: missionId ? null : prev.asset_id,
                }));
                // Close dialog after selection
                if (missionId) {
                  setShowMissionDialog(false);
                }
              }}
              disabled={isSubmitting}
            />
          </div>
          <div className="flex justify-end gap-2 mt-6">
            <Button
              variant="outline"
              onClick={() => setShowMissionDialog(false)}
            >
              Close
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

/**
 * UnifiedActionDialog — wraps ActionForm in a Dialog for use as a modal.
 * Kept for backward compatibility with SimpleMissionForm and other callers.
 */
export function UnifiedActionDialog(props: UnifiedActionDialogProps) {
  const { open, onOpenChange } = props;
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
    >
      <DialogContent
        className={cn(
          "max-w-lg sm:max-w-2xl lg:max-w-4xl max-h-[90vh] overflow-y-auto p-3 sm:p-6",
        )}
      >
        <ActionForm {...props} />
      </DialogContent>
    </Dialog>
  );
}