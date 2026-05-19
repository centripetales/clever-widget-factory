import { useMemo } from 'react';
import { format } from 'date-fns';
import { useNavigate } from 'react-router-dom';
import { ExternalLink, Camera, BookOpen } from 'lucide-react';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { Progress } from '@/components/ui/progress';
import { getThumbnailUrl, getImageUrl } from '@/lib/imageUtils';
import { useAuth } from '@/hooks/useCognitoAuth';
import { useLearningObjectives } from '@/hooks/useLearning';
import { scoreToGrowthLabel } from '@/lib/progressionUtils';
import type { SkillProfile } from '@/hooks/useSkillProfile';
import type { CapabilityProfile, ObservationEvidence, AxisEvidence } from '@/hooks/useCapability';

export interface AxisDrilldownProps {
  actionId: string;
  axisKey: string;
  skillProfile: SkillProfile;
  capabilityProfiles: CapabilityProfile[];
  organizationProfile?: CapabilityProfile;
  isOpen: boolean;
  onClose: () => void;
}

const BLOOM_LABELS = ['Not yet assessed', 'Remember', 'Understand', 'Apply', 'Analyze', 'Create'];

/** Format a 0-5 Bloom's level as a readable string. */
function formatLevel(level: number): string {
  const rounded = Math.round(level);
  const label = BLOOM_LABELS[rounded] || `Level ${rounded}`;
  return `${rounded} — ${label}`;
}

/** Determine gap status between requirement and capability. */
function hasGap(requirement: number, capability: number): boolean {
  return requirement - capability > 1;
}

/** Format a relevance score as a human-readable label. */
function relevanceLabel(score: number): string {
  if (score >= 0.8) return 'High';
  if (score >= 0.5) return 'Medium';
  return 'Low';
}

/**
 * Format a question type string for display.
 * Replaces underscores with hyphens and capitalizes each word.
 * e.g., "self_explanation" → "Self-Explanation"
 */
function formatQuestionTypeLabel(questionType: string): string {
  return questionType
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join('-');
}

function relevanceVariant(score: number): 'default' | 'secondary' | 'outline' {
  if (score >= 0.8) return 'default';
  if (score >= 0.5) return 'secondary';
  return 'outline';
}

/** Render a single observation evidence card. */
function EvidenceCard({ evidence }: { evidence: ObservationEvidence }) {
  const capturedDate = useMemo(() => {
    try {
      return format(new Date(evidence.captured_at), 'MMM d, yyyy');
    } catch {
      return evidence.captured_at;
    }
  }, [evidence.captured_at]);

  return (
    <div className="rounded-lg border bg-card p-3 space-y-2">
      {/* Header: action title + relevance */}
      <div className="flex items-start justify-between gap-2">
        <a
          href={`/actions/${evidence.action_id}`}
          className="text-sm font-medium text-primary hover:underline flex items-center gap-1 min-w-0"
        >
          <ExternalLink className="h-3 w-3 flex-shrink-0" />
          <span className="truncate">{evidence.action_title}</span>
        </a>
        {evidence.relevance_score != null && !isNaN(evidence.relevance_score) && (
          <Badge variant={relevanceVariant(evidence.relevance_score)} className="flex-shrink-0 text-xs">
            {relevanceLabel(evidence.relevance_score)} ({formatLevel(evidence.relevance_score)})
          </Badge>
        )}
      </div>

      {/* Text excerpt */}
      {evidence.text_excerpt && (
        <p className="text-sm text-muted-foreground line-clamp-3">
          {evidence.text_excerpt}
        </p>
      )}

      {/* Thumbnail photos */}
      {evidence.photo_urls && evidence.photo_urls.length > 0 && (
        <div className="flex gap-2 overflow-x-auto">
          {evidence.photo_urls.map((url, idx) => {
            const thumbSrc = getThumbnailUrl(url) || getImageUrl(url) || url;
            return (
              <img
                key={idx}
                src={thumbSrc}
                alt={`Observation photo ${idx + 1}`}
                className="w-16 h-16 object-cover rounded border flex-shrink-0"
                loading="lazy"
              />
            );
          })}
        </div>
      )}

      {/* Capture date */}
      <div className="flex items-center gap-1 text-xs text-muted-foreground">
        <Camera className="h-3 w-3" />
        <span>{capturedDate}</span>
      </div>
    </div>
  );
}

/** Format evidence type as a human-readable label. */
function evidenceTypeLabel(type: string): string {
  if (type === 'quiz') return 'Quiz';
  return 'Observation';
}

/** Get badge variant for evidence type. */
function evidenceTypeVariant(type: string): 'default' | 'secondary' {
  if (type === 'quiz') return 'default';
  return 'secondary';
}

/** Render a single per-axis evidence card with similarity score and evidence type. */
function AxisEvidenceCard({ evidence }: { evidence: AxisEvidence }) {
  return (
    <div className="rounded-lg border bg-card p-3 space-y-2">
      {/* Header: source action title + badges */}
      <div className="flex items-start justify-between gap-2">
        <span className="text-sm font-medium min-w-0 truncate">
          {evidence.source_action_title || 'Unknown source'}
        </span>
        <div className="flex items-center gap-1 flex-shrink-0">
          {evidence.similarity_score != null && (
            <Badge variant="outline" className="text-xs">
              {Math.round(evidence.similarity_score * 100)}%
            </Badge>
          )}
          <Badge
            variant={evidenceTypeVariant(evidence.evidence_type)}
            className="text-xs"
          >
            {evidenceTypeLabel(evidence.evidence_type)}
          </Badge>
        </div>
      </div>

      {/* Text excerpt */}
      {evidence.text_excerpt && (
        <p className="text-sm text-muted-foreground line-clamp-3">
          {evidence.text_excerpt}
        </p>
      )}
    </div>
  );
}

export function AxisDrilldown({
  actionId,
  axisKey,
  skillProfile,
  capabilityProfiles,
  organizationProfile,
  isOpen,
  onClose,
}: AxisDrilldownProps) {
  const navigate = useNavigate();
  const { user } = useAuth();

  // Fetch learning objectives for the current user on this action
  const { data: learningData } = useLearningObjectives(actionId, user?.id);

  // Check if objectives already exist for this axis
  const axisHasObjectives = useMemo(() => {
    if (!learningData?.axes) return false;
    return learningData.axes.some(
      (a) => a.axisKey === axisKey && a.objectives.length > 0
    );
  }, [learningData, axisKey]);

  // Find the learning axis data for continuous score and progression level
  const learningAxis = useMemo(() => {
    if (!learningData?.axes) return null;
    return learningData.axes.find((a) => a.axisKey === axisKey) ?? null;
  }, [learningData, axisKey]);

  // Find the skill axis definition
  const skillAxis = useMemo(
    () => skillProfile.axes.find((a) => a.key === axisKey),
    [skillProfile.axes, axisKey]
  );

  // Build per-person data for this axis
  const personData = useMemo(
    () =>
      capabilityProfiles.map((cp) => {
        const axis = cp.axes.find((a) => a.key === axisKey);
        return { profile: cp, axis };
      }),
    [capabilityProfiles, axisKey]
  );

  // Organization data for this axis
  const orgAxis = useMemo(
    () => organizationProfile?.axes.find((a) => a.key === axisKey),
    [organizationProfile, axisKey]
  );

  if (!skillAxis) return null;

  return (
    <Sheet open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <SheetContent side="right" className="w-[90vw] sm:max-w-md overflow-hidden">
        <SheetHeader>
          <SheetTitle>{skillAxis.label}</SheetTitle>
          <SheetDescription>
            Requirement level: {formatLevel(skillAxis.required_level)}
          </SheetDescription>
        </SheetHeader>

        {/* Continuous score and progression level */}
        {learningAxis && learningAxis.continuousScore > 0 && (
          <div className="mt-3 space-y-1.5 px-1">
            <p className="text-sm font-semibold">
              {learningAxis.continuousScore.toFixed(1)} — {scoreToGrowthLabel(learningAxis.continuousScore)}
            </p>
            {learningAxis.progressionLevel && (
              <p className="text-xs text-muted-foreground">
                Currently working on: {formatQuestionTypeLabel(learningAxis.progressionLevel)} questions
              </p>
            )}
          </div>
        )}

        <ScrollArea className="h-[calc(100vh-8rem)] mt-4 pr-2">
          <div className="space-y-6">
            {/* Organization section */}
            {organizationProfile && orgAxis && (
              <>
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium text-purple-600">Organization</span>
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold">{formatLevel(orgAxis.level)}</span>
                      {hasGap(skillAxis.required_level, orgAxis.level) && (
                        <Badge variant="destructive" className="text-xs">
                          Gap
                        </Badge>
                      )}
                    </div>
                  </div>
                  <div className="space-y-1">
                    <div className="flex justify-between text-xs text-muted-foreground">
                      <span>Organization capability</span>
                      <span>Requirement: {formatLevel(skillAxis.required_level)}</span>
                    </div>
                    <div className="relative">
                      <Progress value={orgAxis.level * 100} className="h-2" />
                      <div
                        className="absolute top-0 h-2 w-0.5 bg-foreground/60"
                        style={{ left: `${skillAxis.required_level * 100}%` }}
                      />
                    </div>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {orgAxis.evidence_count} contributing observation{orgAxis.evidence_count !== 1 ? 's' : ''}
                  </p>
                </div>
                <Separator />
              </>
            )}

            {/* Per-person sections */}
            {personData.map(({ profile, axis }) => {
              if (!axis) return null;

              const gap = hasGap(skillAxis.required_level, axis.level);
              // A gap axis is where currentLevel < requiredLevel (any gap, not just >1 difference)
              const isGapAxis = axis.level < skillAxis.required_level;

              return (
                <div key={profile.user_id} className="space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium">{profile.user_name}</span>
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold">{formatLevel(axis.level)}</span>
                      {gap && (
                        <Badge variant="destructive" className="text-xs">
                          Gap
                        </Badge>
                      )}
                    </div>
                  </div>

                  {/* Score bar */}
                  <div className="space-y-1">
                    <div className="flex justify-between text-xs text-muted-foreground">
                      <span>Capability</span>
                      <span>Requirement: {formatLevel(skillAxis.required_level)}</span>
                    </div>
                    <div className="relative">
                      <Progress value={axis.level * 100} className="h-2" />
                      <div
                        className="absolute top-0 h-2 w-0.5 bg-foreground/60"
                        style={{ left: `${skillAxis.required_level * 100}%` }}
                      />
                    </div>
                  </div>

                  {/* AI reasoning narrative — prefer per-axis narrative, fall back to profile narrative */}
                  {(axis.axis_narrative || profile.narrative) && (
                    <div className="rounded-md bg-muted/50 p-2">
                      <p className="text-xs text-muted-foreground italic">
                        {axis.axis_narrative || profile.narrative}
                      </p>
                    </div>
                  )}

                  {/* Evidence count */}
                  <p className="text-xs text-muted-foreground">
                    {axis.evidence_count} contributing observation{axis.evidence_count !== 1 ? 's' : ''}
                  </p>

                  {/* Evidence list — prefer per-axis evidence, fall back to observation evidence */}
                  {(axis.axis_evidence?.length ?? 0) > 0 ? (
                    <div className="space-y-2">
                      <p className="text-xs font-medium text-muted-foreground">
                        Per-axis evidence matches
                      </p>
                      {axis.axis_evidence.map((ev, idx) => (
                        <AxisEvidenceCard key={ev.observation_id || idx} evidence={ev} />
                      ))}
                    </div>
                  ) : (axis.evidence?.length ?? 0) > 0 ? (
                    <div className="space-y-2">
                      {axis.evidence.map((ev) => (
                        <EvidenceCard key={ev.observation_id} evidence={ev} />
                      ))}
                    </div>
                  ) : (
                    <p className="text-xs text-muted-foreground italic">
                      No specific observations for this axis.
                    </p>
                  )}

                  {/* Start Learning / Review Learning button for gap axes */}
                  {isGapAxis && profile.user_id === user?.id && (
                    <div className="pt-1">
                      {axisHasObjectives ? (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => navigate(`/actions/${actionId}/quiz/${axisKey}`)}
                        >
                          <BookOpen className="h-4 w-4 mr-1.5" />
                          Review Learning
                        </Button>
                      ) : (
                        <Button
                          size="sm"
                          onClick={() => navigate(`/actions/${actionId}/quiz/${axisKey}`)}
                        >
                          <BookOpen className="h-4 w-4 mr-1.5" />
                          Start Learning
                        </Button>
                      )}
                    </div>
                  )}

                  <Separator />
                </div>
              );
            })}

            {/* Empty state */}
            {personData.every(({ axis }) => !axis) && !orgAxis && (
              <p className="text-sm text-muted-foreground text-center py-8">
                No capability data available for this axis.
              </p>
            )}
          </div>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}
