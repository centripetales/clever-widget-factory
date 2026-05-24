/**
 * SkillProfilePanel Component
 *
 * Collapsible panel for generating, previewing, editing, and approving
 * AI-generated skill profiles for actions.
 *
 * Three states:
 * - Empty: "Generate Skill Profile" button (disabled if no context)
 * - Preview: Editable narrative + axes with Approve/Discard
 * - Approved: Stored profile with mini radar preview + Regenerate
 *
 * Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7
 */

import { useState, useEffect } from 'react';
import { useForm, useFieldArray } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { useToast } from '@/hooks/use-toast';
import {
  useGenerateSkillProfile,
  useApproveSkillProfile,
  useDeleteSkillProfile,
} from '@/hooks/useSkillProfile';
import { useMemberSettings } from '@/hooks/useMemberSettings';
import type { SkillProfile } from '@/hooks/useSkillProfile';
import type { BaseAction } from '@/types/actions';
import { apiService, getApiData } from '@/lib/apiService';
import {
  ChevronDown,
  Sparkles,
  Check,
  X,
  RefreshCw,
  Loader2,
  Brain,
  Info,
} from 'lucide-react';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';

// --- AI Config types and defaults (match AiConfigCard / backend) ---

interface AiConfig {
  max_axes: number;
  min_axes: number;
  evidence_limit: number;
  quiz_temperature: number;
}

const AI_CONFIG_DEFAULTS: AiConfig = {
  max_axes: 3,
  min_axes: 2,
  evidence_limit: 3,
  quiz_temperature: 0.7,
};

// --- Zod schema for frontend validation before approve ---

const skillAxisSchema = z.object({
  key: z.string().min(1, 'Key is required'),
  label: z.string().min(1, 'Label is required'),
  description: z.string().min(1, 'Description is required'),
  required_level: z
    .number()
    .int('Must be a whole number')
    .min(0, 'Min 0')
    .max(5, 'Max 5'),
});

/**
 * Creates a dynamic Zod schema for skill profile form validation.
 * Axis count constraints come from the org's ai_config instead of
 * being hardcoded to 4–6.
 *
 * Requirements: 1.5
 */
function createSkillProfileFormSchema(minAxes: number, maxAxes: number) {
  return z.object({
    narrative: z.string().min(1, 'Narrative is required'),
    axes: z
      .array(skillAxisSchema)
      .min(minAxes, `At least ${minAxes} axes required`)
      .max(maxAxes, `At most ${maxAxes} axes allowed`),
  });
}

type SkillProfileFormData = z.infer<ReturnType<typeof createSkillProfileFormSchema>>;

// --- Props ---

interface SkillProfilePanelProps {
  action: BaseAction;
  userId: string;
  organizationId: string | null;
}

// --- Component ---

export function SkillProfilePanel({ action, userId, organizationId }: SkillProfilePanelProps) {
  const [isOpen, setIsOpen] = useState(!!action.skill_profile);
  const [previewProfile, setPreviewProfile] = useState<SkillProfile | null>(null);

  const { toast } = useToast();
  const generateMutation = useGenerateSkillProfile();
  const approveMutation = useApproveSkillProfile();
  const deleteMutation = useDeleteSkillProfile();

  // Fetch org ai_config — reuses the same query key as AiConfigCard
  const { data: aiConfig } = useQuery<AiConfig>({
    queryKey: ['ai-config', organizationId],
    queryFn: async () => {
      const response = await apiService.get(
        `/organizations/${organizationId}/ai-config`
      );
      return getApiData(response) ?? AI_CONFIG_DEFAULTS;
    },
    enabled: !!organizationId,
  });

  // Derive min/max axes from config (fall back to defaults)
  const minAxes = aiConfig?.min_axes ?? AI_CONFIG_DEFAULTS.min_axes;
  const maxAxes = aiConfig?.max_axes ?? AI_CONFIG_DEFAULTS.max_axes;

  // Fetch member settings for profile intents — Requirements: 4.3, 4.4
  const { data: memberSettings } = useMemberSettings(userId, organizationId ?? undefined);
  const profileIntents = memberSettings?.growth_intents ?? [];

  const approvedProfile = action.skill_profile as SkillProfile | null | undefined;
  const hasContext = !!(action.title || action.description || action.expected_state);

  // Extract existing per-action intent from stored skill profile — Requirements: 1.7, 4.5
  const existingIntent = approvedProfile?.growth_intent ?? null;

  // Determine panel state
  const panelState: 'empty' | 'preview' | 'approved' = previewProfile
    ? 'preview'
    : approvedProfile
      ? 'approved'
      : 'empty';

  // --- Handlers ---

  const handleGenerate = async (growthIntent?: string) => {
    try {
      const result = await generateMutation.mutateAsync({
        action_id: action.id,
        action_context: {
          title: action.title,
          description: action.description || undefined,
          expected_state: action.expected_state || undefined,
          policy: action.policy || undefined,
          asset_name: action.asset?.name || undefined,
          required_tools: action.required_tools || undefined,
        },
        growth_intent: growthIntent || undefined,
      });
      setPreviewProfile(result);
    } catch {
      toast({
        title: 'Generation failed',
        description: 'Could not generate skill profile. Please try again.',
        variant: 'destructive',
      });
    }
  };

  const handleDiscard = () => {
    setPreviewProfile(null);
  };

  const handleRegenerate = async () => {
    // Clear approved profile first, then generate fresh
    try {
      await deleteMutation.mutateAsync(action.id);
    } catch {
      // If delete fails, still try to generate
    }
    handleGenerate();
  };

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen}>
      <CollapsibleTrigger asChild>
        <Button variant="ghost" className="w-full p-0">
          <div className="flex items-center gap-2 w-full">
            <Brain className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm font-semibold">Skill Profile</span>
            {approvedProfile && !previewProfile && (
              <span className="text-xs text-green-600 ml-1">Approved</span>
            )}
            {previewProfile && (
              <span className="text-xs text-amber-600 ml-1">Preview</span>
            )}
            <ChevronDown
              className={`h-4 w-4 ml-auto transition-transform ${isOpen ? 'rotate-180' : ''}`}
            />
          </div>
        </Button>
      </CollapsibleTrigger>

      <CollapsibleContent className="mt-3 space-y-3">
        {panelState === 'empty' && (
          <EmptyState
            hasContext={hasContext}
            isLoading={generateMutation.isPending}
            onGenerate={handleGenerate}
            profileIntents={profileIntents}
            existingIntent={existingIntent}
          />
        )}

        {panelState === 'preview' && previewProfile && (
          <PreviewState
            profile={previewProfile}
            actionId={action.id}
            userId={userId}
            minAxes={minAxes}
            maxAxes={maxAxes}
            isApproving={approveMutation.isPending}
            onApprove={async (data) => {
              try {
                await approveMutation.mutateAsync({
                  action_id: action.id,
                  skill_profile: {
                    ...data,
                    generated_at: previewProfile.generated_at,
                  },
                  approved_by: userId,
                  growth_intent: previewProfile.growth_intent || undefined,
                });
                setPreviewProfile(null);
                toast({ title: 'Skill profile approved' });
              } catch {
                toast({
                  title: 'Approval failed',
                  description: 'Could not approve skill profile. Please try again.',
                  variant: 'destructive',
                });
              }
            }}
            onDiscard={handleDiscard}
          />
        )}

        {panelState === 'approved' && approvedProfile && (
          <ApprovedState
            profile={approvedProfile}
            isRegenerating={generateMutation.isPending || deleteMutation.isPending}
            onRegenerate={handleRegenerate}
          />
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}

// --- Empty State ---

function EmptyState({
  hasContext,
  isLoading,
  onGenerate,
  profileIntents,
  existingIntent,
}: {
  hasContext: boolean;
  isLoading: boolean;
  onGenerate: (growthIntent: string) => void;
  profileIntents: string[];
  existingIntent: string | null;
}) {
  const [growthIntent, setGrowthIntent] = useState('');
  const [isAutoFilled, setIsAutoFilled] = useState(false);

  // Auto-fill logic — Requirements: 1.7, 4.3, 4.4, 4.5, 4.6, 4.7
  // Priority: existingIntent > single profile intent > leave blank (multiple shows dropdown)
  useEffect(() => {
    if (existingIntent) {
      // Highest priority: stored per-action intent
      setGrowthIntent(existingIntent);
      setIsAutoFilled(true);
    } else if (profileIntents.length === 1) {
      // Single profile intent: auto-fill
      setGrowthIntent(profileIntents[0]);
      setIsAutoFilled(true);
    }
    // Multiple intents: leave blank, user picks from dropdown
    // No intents: leave blank
  }, [existingIntent, profileIntents]);

  const handleSelectIntent = (value: string) => {
    setGrowthIntent(value);
    setIsAutoFilled(true);
  };

  const handleClear = () => {
    setGrowthIntent('');
    setIsAutoFilled(false);
  };

  return (
    <div className="flex flex-col items-center gap-3 py-2">
      {/* Growth intent textarea — Requirements: 1.1, 1.2, 1.3 */}
      <div className="w-full space-y-1.5">
        <div className="flex items-center gap-1.5">
          <Label
            htmlFor="growth-intent"
            className="text-sm font-medium text-foreground"
          >
            What do you want to get better at?
          </Label>
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <Info className="h-3.5 w-3.5 text-muted-foreground cursor-help" />
              </TooltipTrigger>
              <TooltipContent side="top" className="max-w-[260px]">
                <p>Optional — describe a skill or area you'd like to develop. The action becomes your practice context.</p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>

        {/* Profile intents dropdown — shown when multiple intents exist — Requirements: 4.3 */}
        {profileIntents.length > 1 && (
          <Select onValueChange={handleSelectIntent}>
            <SelectTrigger className="text-sm">
              <SelectValue placeholder="Choose from your saved intents…" />
            </SelectTrigger>
            <SelectContent>
              {profileIntents.map((intent, index) => (
                <SelectItem key={index} value={intent}>
                  {intent}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}

        <div className="flex items-center gap-1.5">
          <Textarea
            id="growth-intent"
            value={growthIntent}
            onChange={(e) => {
              setGrowthIntent(e.target.value);
              setIsAutoFilled(false);
            }}
            rows={2}
            className="text-sm border-amber-200 bg-amber-50/50 focus-visible:ring-amber-300 placeholder:text-amber-400/70 dark:border-amber-800 dark:bg-amber-950/20 dark:placeholder:text-amber-600/50"
            placeholder="e.g. I want to improve my leadership and trust-building skills"
          />
          {isAutoFilled && growthIntent && (
            <button
              type="button"
              onClick={handleClear}
              className="text-xs text-muted-foreground hover:text-foreground underline shrink-0"
            >
              Clear
            </button>
          )}
        </div>
      </div>

      <Button
        variant="outline"
        size="sm"
        disabled={!hasContext || isLoading}
        onClick={() => onGenerate(growthIntent)}
      >
        {isLoading ? (
          <Loader2 className="h-4 w-4 mr-2 animate-spin" />
        ) : (
          <Sparkles className="h-4 w-4 mr-2" />
        )}
        Generate Skill Profile
      </Button>
      {!hasContext && (
        <p className="text-xs text-muted-foreground">
          Add a title, description, or expected state first.
        </p>
      )}
    </div>
  );
}

// --- Preview State (React Hook Form + Zod) ---

function PreviewState({
  profile,
  actionId,
  userId,
  minAxes,
  maxAxes,
  isApproving,
  onApprove,
  onDiscard,
}: {
  profile: SkillProfile;
  actionId: string;
  userId: string;
  minAxes: number;
  maxAxes: number;
  isApproving: boolean;
  onApprove: (data: SkillProfileFormData) => void;
  onDiscard: () => void;
}) {
  const schema = createSkillProfileFormSchema(minAxes, maxAxes);

  const {
    register,
    control,
    handleSubmit,
    formState: { errors },
  } = useForm<SkillProfileFormData>({
    resolver: zodResolver(schema),
    defaultValues: {
      narrative: profile.narrative,
      axes: profile.axes.map((a) => ({
        key: a.key,
        label: a.label,
        description: a.description,
        required_level: a.required_level,
      })),
    },
  });

  const { fields } = useFieldArray({
    control,
    name: 'axes',
  });

  return (
    <form onSubmit={handleSubmit(onApprove)} className="space-y-4">
      {/* Narrative */}
      <div className="space-y-1.5">
        <Label htmlFor={`narrative-${actionId}`} className="text-xs font-medium">
          Skill Narrative
        </Label>
        <Textarea
          id={`narrative-${actionId}`}
          {...register('narrative')}
          rows={3}
          className="text-sm"
          placeholder="Describe the skills this action requires..."
        />
        {errors.narrative && (
          <p className="text-xs text-destructive">{errors.narrative.message}</p>
        )}
      </div>

      {/* Axes */}
      <div className="space-y-2">
        <Label className="text-xs font-medium">Skill Axes</Label>
        {errors.axes?.root && (
          <p className="text-xs text-destructive">{errors.axes.root.message}</p>
        )}
        {fields.map((field, index) => (
          <div key={field.id} className="space-y-2 p-3 border rounded-md">
            <Input
              {...register(`axes.${index}.label`)}
              className="text-sm"
              placeholder="Axis label"
            />
            {errors.axes?.[index]?.label && (
              <span className="text-xs text-destructive">
                {errors.axes[index].label?.message}
              </span>
            )}
            <Textarea
              {...register(`axes.${index}.description`)}
              rows={3}
              className="text-sm"
              placeholder="2-4 sentence description of the concept..."
            />
            {errors.axes?.[index]?.description && (
              <span className="text-xs text-destructive">
                {errors.axes[index].description?.message}
              </span>
            )}
            <Input
              {...register(`axes.${index}.required_level`, { valueAsNumber: true })}
              type="number"
              step="1"
              min="0"
              max="5"
              className="text-sm w-20"
              placeholder="0–5"
            />
            {errors.axes?.[index]?.required_level && (
              <span className="text-xs text-destructive">
                {errors.axes[index].required_level?.message}
              </span>
            )}
          </div>
        ))}
      </div>

      {/* Actions */}
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={isApproving}>
          {isApproving ? (
            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
          ) : (
            <Check className="h-4 w-4 mr-2" />
          )}
          Approve
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onDiscard}
          disabled={isApproving}
        >
          <X className="h-4 w-4 mr-2" />
          Discard
        </Button>
      </div>
    </form>
  );
}

// --- Approved State (mini radar preview with progress bars) ---

function AxisDescription({ description }: { description: string }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="space-y-0.5">
      <p className={`text-xs text-muted-foreground ${expanded ? '' : 'line-clamp-3'}`}>
        {description}
      </p>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="text-xs text-primary hover:underline"
      >
        {expanded ? 'Show less' : 'Show more'}
      </button>
    </div>
  );
}

function ApprovedState({
  profile,
  isRegenerating,
  onRegenerate,
}: {
  profile: SkillProfile;
  isRegenerating: boolean;
  onRegenerate: () => void;
}) {
  return (
    <div className="space-y-3">
      {/* Narrative */}
      <p className="text-sm text-muted-foreground leading-relaxed">
        {profile.narrative}
      </p>

      {/* Approved metadata */}
      {profile.approved_at && (
        <p className="text-xs text-muted-foreground">
          Approved {new Date(profile.approved_at).toLocaleDateString()}
        </p>
      )}

      {/* Axes list — Requirements: 4.2, 4.3, 5.4 */}
      <div className="space-y-3">
        {profile.axes.map((axis) => (
          <div key={axis.key} className="space-y-0.5">
            <p className="text-sm font-medium">{axis.label}</p>
            {axis.description && (
              <AxisDescription description={axis.description} />
            )}
          </div>
        ))}
      </div>

      {/* Regenerate */}
      <Button
        variant="outline"
        size="sm"
        onClick={onRegenerate}
        disabled={isRegenerating}
      >
        {isRegenerating ? (
          <Loader2 className="h-4 w-4 mr-2 animate-spin" />
        ) : (
          <RefreshCw className="h-4 w-4 mr-2" />
        )}
        Regenerate
      </Button>
    </div>
  );
}
