/**
 * ProfileSkillsSection Component
 *
 * Manages profile-level skills on the user's profile settings page.
 * Replaces ProfileIntentsSection with rich, structured skill objects
 * that preserve the learner's original narrative, display AI-generated
 * concept axes with Bloom's progression levels, and support
 * active/inactive toggling and deletion.
 *
 * Requirements: 1.1, 1.2, 1.7, 4.4, 5.1
 */

import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  Plus,
  Trash2,
  Loader2,
  RefreshCw,
  Info,
  BookOpen,
  Sparkles,
  AlertCircle,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useToast } from '@/hooks/use-toast';
import {
  useProfileSkills,
  useGenerateProfileSkill,
  useApproveProfileSkill,
  useToggleProfileSkill,
  useDeleteProfileSkill,
  type ProfileSkill,
  type ProfileAxis,
  type AIInterpretation,
} from '@/hooks/useProfileSkills';

// ─── Bloom Level Helpers ────────────────────────────────────────────────────

const BLOOM_LABELS: Record<number, string> = {
  0: 'Not yet demonstrated',
  1: 'Remember',
  2: 'Understand',
  3: 'Apply',
  4: 'Analyze',
  5: 'Synthesize',
};

function getBloomVariant(level: number): 'secondary' | 'default' | 'outline' {
  if (level === 0) return 'outline';
  if (level <= 2) return 'secondary';
  return 'default';
}

/**
 * Extract the most recent demonstration date from a profile axis's progression history.
 * Returns null if the history is empty.
 * Validates: Requirements 4.3
 */
export function getMostRecentDemoDate(axis: ProfileAxis): string | null {
  if (!axis.progression_history || axis.progression_history.length === 0) {
    return null;
  }
  let maxTimestamp = axis.progression_history[0].timestamp;
  for (const event of axis.progression_history) {
    if (event.timestamp > maxTimestamp) {
      maxTimestamp = event.timestamp;
    }
  }
  return maxTimestamp;
}

function formatDate(isoString: string): string {
  try {
    return new Date(isoString).toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  } catch {
    return isoString;
  }
}

// ─── ProfileAxisDisplay ─────────────────────────────────────────────────────

interface ProfileAxisDisplayProps {
  axis: ProfileAxis;
}

/**
 * Renders a single profile axis with bloom level indicator and last demo date.
 * Requirements: 4.1, 4.2, 4.3
 */
function ProfileAxisDisplay({ axis }: ProfileAxisDisplayProps) {
  const recentDate = getMostRecentDemoDate(axis);

  return (
    <div className="flex items-start justify-between gap-2 py-2 px-3 rounded-md bg-muted/30">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-medium">{axis.label}</span>
          <Badge variant={getBloomVariant(axis.bloom_level)} className="text-xs">
            {BLOOM_LABELS[axis.bloom_level] ?? `Level ${axis.bloom_level}`}
          </Badge>
        </div>
        <p className="text-xs text-muted-foreground mt-0.5">{axis.description}</p>
        {recentDate && (
          <p className="text-xs text-muted-foreground mt-0.5">
            Last demonstrated: {formatDate(recentDate)}
          </p>
        )}
      </div>
      {/* Visual bloom level bar */}
      <div className="flex gap-0.5 items-center shrink-0 pt-1" aria-label={`Bloom level ${axis.bloom_level} of 5`}>
        {[1, 2, 3, 4, 5].map((level) => (
          <div
            key={level}
            className={`w-2 h-4 rounded-sm ${
              level <= axis.bloom_level
                ? 'bg-primary'
                : 'bg-muted-foreground/20'
            }`}
          />
        ))}
      </div>
    </div>
  );
}

// ─── ProfileSkillCard ───────────────────────────────────────────────────────

interface ProfileSkillCardProps {
  skill: ProfileSkill;
  onToggle: (id: string) => void;
  onDelete: (id: string) => void;
  isToggling: boolean;
  isDeleting: boolean;
}

/**
 * Displays a single profile skill with narrative, AI interpretation, axes, and controls.
 * Requirements: 1.7, 4.1, 5.1
 */
function ProfileSkillCard({
  skill,
  onToggle,
  onDelete,
  isToggling,
  isDeleting,
}: ProfileSkillCardProps) {
  const [expanded, setExpanded] = useState(true);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  return (
    <>
      <Card className={`transition-opacity ${!skill.active ? 'opacity-60' : ''}`}>
        <CardContent className="pt-4 pb-3 space-y-3">
          {/* Header row: narrative + controls */}
          <div className="flex items-start gap-3">
            <div className="flex-1 min-w-0">
              {/* Original narrative — prominent (Req 1.7) */}
              <p className="text-sm leading-relaxed">{skill.original_narrative}</p>
              {skill.source === 'claimed' && (
                <Badge variant="outline" className="mt-1 text-xs">Claimed</Badge>
              )}
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <Switch
                checked={skill.active}
                onCheckedChange={() => onToggle(skill.id)}
                disabled={isToggling}
                aria-label={skill.active ? 'Deactivate skill' : 'Activate skill'}
              />
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setShowDeleteConfirm(true)}
                disabled={isDeleting}
                className="h-8 w-8 p-0 text-destructive hover:text-destructive"
                aria-label="Delete skill"
              >
                <Trash2 className="w-4 h-4" />
              </Button>
            </div>
          </div>

          {/* AI Interpretation */}
          {skill.ai_interpretation && (
            <div className="flex items-center gap-2 flex-wrap">
              <Badge variant="secondary" className="gap-1">
                <Sparkles className="w-3 h-3" />
                {skill.ai_interpretation.concept_label}
              </Badge>
              <span className="text-xs text-muted-foreground">
                {skill.ai_interpretation.source_attribution}
              </span>
            </div>
          )}

          {skill.ai_interpretation?.learning_direction && (
            <p className="text-xs text-muted-foreground italic">
              {skill.ai_interpretation.learning_direction}
            </p>
          )}

          {/* No AI interpretation — narrative only (Req 1.8) */}
          {!skill.ai_interpretation && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <AlertCircle className="w-3.5 h-3.5" />
              <span>AI interpretation not available. Narrative saved.</span>
            </div>
          )}

          {/* Axes section */}
          {skill.axes.length > 0 && (
            <div>
              <button
                onClick={() => setExpanded(!expanded)}
                className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors mb-1"
              >
                {expanded ? (
                  <ChevronUp className="w-3.5 h-3.5" />
                ) : (
                  <ChevronDown className="w-3.5 h-3.5" />
                )}
                {skill.axes.length} concept {skill.axes.length === 1 ? 'axis' : 'axes'}
              </button>
              {expanded && (
                <div className="space-y-1.5">
                  {skill.axes.map((axis) => (
                    <ProfileAxisDisplay key={axis.key} axis={axis} />
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Created date */}
          <p className="text-xs text-muted-foreground">
            Created {formatDate(skill.created_at)}
            {!skill.active && ' · Inactive'}
          </p>
        </CardContent>
      </Card>

      {/* Delete confirmation */}
      <AlertDialog open={showDeleteConfirm} onOpenChange={setShowDeleteConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete area of focus?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently remove this skill and all its progression history.
              This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                onDelete(skill.id);
                setShowDeleteConfirm(false);
              }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

// ─── CreateProfileSkillDialog ───────────────────────────────────────────────

interface CreateProfileSkillDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Two-step dialog for creating a profile skill:
 * 1. Enter narrative text
 * 2. Preview AI generation (concept_label, axes), then approve
 *
 * Handles AI generation failure by allowing save with narrative only (Req 1.8).
 * Requirements: 1.2, 1.3, 1.4, 1.8
 */
function CreateProfileSkillDialog({ open, onOpenChange }: CreateProfileSkillDialogProps) {
  const { toast } = useToast();
  const generateMutation = useGenerateProfileSkill();
  const approveMutation = useApproveProfileSkill();

  const [narrative, setNarrative] = useState('');
  const [step, setStep] = useState<'input' | 'preview'>('input');
  const [preview, setPreview] = useState<{
    ai_interpretation: AIInterpretation | null;
    axes: { key: string; label: string; description: string }[];
  } | null>(null);
  const [generationFailed, setGenerationFailed] = useState(false);

  const resetDialog = () => {
    setNarrative('');
    setStep('input');
    setPreview(null);
    setGenerationFailed(false);
  };

  const handleClose = (isOpen: boolean) => {
    if (!isOpen) {
      resetDialog();
    }
    onOpenChange(isOpen);
  };

  const handleGenerate = async () => {
    setGenerationFailed(false);
    try {
      const result = await generateMutation.mutateAsync({ narrative: narrative.trim() });
      setPreview({
        ai_interpretation: result.ai_interpretation ?? null,
        axes: result.axes ?? [],
      });
      setStep('preview');
    } catch (error) {
      console.error('Profile skill generation failed:', error);
      setGenerationFailed(true);
      // Allow saving with narrative only (Req 1.8)
      setPreview({ ai_interpretation: null, axes: [] });
      setStep('preview');
      toast({
        variant: 'destructive',
        title: 'AI generation unavailable',
        description: 'You can still save your narrative and retry axis generation later.',
      });
    }
  };

  const handleRetryGenerate = async () => {
    setGenerationFailed(false);
    try {
      const result = await generateMutation.mutateAsync({ narrative: narrative.trim() });
      setPreview({
        ai_interpretation: result.ai_interpretation ?? null,
        axes: result.axes ?? [],
      });
    } catch (error) {
      console.error('Profile skill generation retry failed:', error);
      setGenerationFailed(true);
      toast({
        variant: 'destructive',
        title: 'AI generation still unavailable',
        description: 'You can save with narrative only for now.',
      });
    }
  };

  const handleApprove = async () => {
    try {
      await approveMutation.mutateAsync({
        narrative: narrative.trim(),
        ai_interpretation: preview?.ai_interpretation ?? null,
        axes: preview?.axes ?? [],
      });
      toast({
        title: 'Area of focus created',
        description: 'Your new area of focus has been saved.',
      });
      handleClose(false);
    } catch (error) {
      console.error('Profile skill approval failed:', error);
      toast({
        variant: 'destructive',
        title: 'Error saving skill',
        description: 'Could not save the area of focus. Please try again.',
      });
    }
  };

  const isGenerating = generateMutation.isPending;
  const isApproving = approveMutation.isPending;

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {step === 'input' ? 'Create Area of Focus' : 'Preview & Approve'}
          </DialogTitle>
          <DialogDescription>
            {step === 'input'
              ? 'Describe what you want to grow in. Share the story, podcast, person, or insight that inspired you.'
              : 'Review the AI interpretation and concept axes generated from your narrative.'}
          </DialogDescription>
        </DialogHeader>

        {step === 'input' && (
          <div className="space-y-3">
            <Textarea
              value={narrative}
              onChange={(e) => setNarrative(e.target.value)}
              placeholder="e.g., I was listening to Diary of a CEO where Jocko Willink talked about Extreme Ownership — taking full responsibility for everything in your world..."
              rows={5}
              className="resize-none"
            />

          </div>
        )}

        {step === 'preview' && preview && (
          <div className="space-y-4 max-h-[60vh] overflow-y-auto">
            {/* Narrative recap */}
            <div className="p-3 rounded-md bg-muted/40 border">
              <p className="text-xs font-medium text-muted-foreground mb-1">Your narrative</p>
              <p className="text-sm">{narrative}</p>
            </div>

            {/* AI Interpretation */}
            {preview.ai_interpretation ? (
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <Sparkles className="w-4 h-4 text-primary" />
                  <span className="text-sm font-medium">AI Interpretation</span>
                </div>
                <div className="pl-6 space-y-1">
                  <p className="text-sm">
                    <span className="font-medium">{preview.ai_interpretation.concept_label}</span>
                    {' — '}
                    <span className="text-muted-foreground">
                      {preview.ai_interpretation.source_attribution}
                    </span>
                  </p>
                  <p className="text-xs text-muted-foreground italic">
                    {preview.ai_interpretation.learning_direction}
                  </p>
                </div>
              </div>
            ) : (
              <div className="flex items-center gap-2 p-3 rounded-md bg-destructive/10 border border-destructive/20">
                <AlertCircle className="w-4 h-4 text-destructive shrink-0" />
                <div className="flex-1">
                  <p className="text-sm">AI interpretation could not be generated.</p>
                  <p className="text-xs text-muted-foreground">
                    You can save with your narrative only, or retry.
                  </p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleRetryGenerate}
                  disabled={isGenerating}
                >
                  {isGenerating ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <RefreshCw className="w-3.5 h-3.5" />
                  )}
                  <span className="ml-1">Retry</span>
                </Button>
              </div>
            )}

            {/* Axes preview */}
            {preview.axes.length > 0 && (
              <div className="space-y-2">
                <p className="text-sm font-medium">Concept Axes ({preview.axes.length})</p>
                <div className="space-y-1.5">
                  {preview.axes.map((axis) => (
                    <div key={axis.key} className="py-2 px-3 rounded-md bg-muted/30">
                      <p className="text-sm font-medium">{axis.label}</p>
                      <p className="text-xs text-muted-foreground">{axis.description}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {preview.axes.length === 0 && preview.ai_interpretation && (
              <p className="text-xs text-muted-foreground">No concept axes were generated.</p>
            )}
          </div>
        )}

        <DialogFooter>
          {step === 'input' && (
            <>
              <Button variant="outline" onClick={() => handleClose(false)}>
                Cancel
              </Button>
              <Button
                onClick={handleGenerate}
                disabled={!narrative.trim() || isGenerating}
              >
                {isGenerating && <Loader2 className="w-4 h-4 animate-spin mr-2" />}
                Generate Preview
              </Button>
            </>
          )}
          {step === 'preview' && (
            <>
              <Button variant="outline" onClick={() => setStep('input')}>
                Back
              </Button>
              <Button onClick={handleApprove} disabled={isApproving}>
                {isApproving && <Loader2 className="w-4 h-4 animate-spin mr-2" />}
                {generationFailed ? 'Save Narrative Only' : 'Approve & Save'}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── ProfileSkillsSection (main export) ─────────────────────────────────────

interface ProfileSkillsSectionProps {
  userId: string;
  organizationId: string;
}

export function ProfileSkillsSection({
  userId,
  organizationId,
}: ProfileSkillsSectionProps) {
  const { toast } = useToast();
  const { data: skills, isLoading, isError, refetch } = useProfileSkills(userId);
  const toggleMutation = useToggleProfileSkill();
  const deleteMutation = useDeleteProfileSkill();

  const [createDialogOpen, setCreateDialogOpen] = useState(false);

  const handleToggle = (id: string) => {
    toggleMutation.mutate(id, {
      onError: () => {
        toast({
          variant: 'destructive',
          title: 'Error',
          description: 'Could not update skill status. Please try again.',
        });
      },
    });
  };

  const handleDelete = (id: string) => {
    deleteMutation.mutate(id, {
      onError: () => {
        toast({
          variant: 'destructive',
          title: 'Error',
          description: 'Could not delete skill. Please try again.',
        });
      },
    });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <BookOpen className="w-5 h-5" />
          Areas of Focus
          <Popover>
            <PopoverTrigger asChild>
              <Button variant="ghost" size="sm" className="h-auto p-1">
                <Info className="w-4 h-4 text-muted-foreground hover:text-foreground" />
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-80">
              <div className="space-y-2">
                <p className="font-medium">Areas of Focus</p>
                <p className="text-sm text-muted-foreground">
                  Areas of focus are self-directed learning lenses carried across all your actions.
                  They preserve your original narrative and generate concept axes that
                  integrate into quiz generation, tracking your Bloom's progression over time.
                </p>
              </div>
            </PopoverContent>
          </Popover>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Loading state */}
        {isLoading && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground py-4">
            <Loader2 className="w-4 h-4 animate-spin" />
            Loading areas of focus…
          </div>
        )}

        {/* Error state */}
        {isError && !isLoading && (
          <div className="flex flex-col items-center gap-3 py-6 text-center">
            <AlertCircle className="w-8 h-8 text-destructive" />
            <p className="text-sm text-muted-foreground">
              Could not load areas of focus.
            </p>
            <Button variant="outline" size="sm" onClick={() => refetch()}>
              <RefreshCw className="w-4 h-4 mr-1" />
              Retry
            </Button>
          </div>
        )}

        {/* Empty state */}
        {!isLoading && !isError && skills && skills.length === 0 && (
          <div className="text-center py-6 space-y-2">
            <Sparkles className="w-8 h-8 mx-auto text-muted-foreground/50" />
            <p className="text-sm text-muted-foreground">
              No areas of focus yet. Create your first one to start tracking
              your growth across all actions.
            </p>
          </div>
        )}

        {/* Skills list */}
        {!isLoading && !isError && skills && skills.length > 0 && (
          <div className="space-y-3">
            {skills.map((skill) => (
              <ProfileSkillCard
                key={skill.id}
                skill={skill}
                onToggle={handleToggle}
                onDelete={handleDelete}
                isToggling={toggleMutation.isPending && toggleMutation.variables === skill.id}
                isDeleting={deleteMutation.isPending && deleteMutation.variables === skill.id}
              />
            ))}
          </div>
        )}

        {/* Create button */}
        {!isLoading && !isError && (
          <Button
            onClick={() => setCreateDialogOpen(true)}
            variant="outline"
            className="w-full"
          >
            <Plus className="w-4 h-4 mr-2" />
            Create Area of Focus
          </Button>
        )}

        <CreateProfileSkillDialog
          open={createDialogOpen}
          onOpenChange={setCreateDialogOpen}
        />
      </CardContent>
    </Card>
  );
}
