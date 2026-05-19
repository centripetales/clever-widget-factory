import { useState, useMemo, useEffect, useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { Loader2, AlertCircle, RefreshCw, AlertTriangle, CircleMinus, CheckCircle2, CircleDot, BookOpen, GraduationCap, ChevronDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { apiService } from '@/lib/apiService';
import { capabilityProfileQueryKey } from '@/lib/queryKeys';
import { useAuth } from '@/hooks/useCognitoAuth';
import { useLearningObjectives } from '@/hooks/useLearning';
import type { LearningObjective, LearningAxis } from '@/hooks/useLearning';
import { SkillRadialChart } from '@/components/RadialChart';
import { AxisDrilldown } from '@/components/AxisDrilldown';
import { computeGapItems, sortGapsBySeverity, computeGapSummary, computeAxisProgress, isAxisComplete, isAllLearningComplete } from '@/lib/learningUtils';
import { scoreToGrowthLabel } from '@/lib/progressionUtils';
import type { GapItem, ObjectiveProgress } from '@/lib/learningUtils';
import type { BaseAction } from '@/types/actions';
import type { SkillProfile } from '@/hooks/useSkillProfile';
import type { CapabilityProfile } from '@/hooks/useCapability';

const LOADING_TIMEOUT_MS = 30_000;

export interface CapabilityAssessmentProps {
  action: BaseAction;
}

/** Bloom's level labels for display */
const BLOOM_LABELS: Record<number, string> = {
  0: 'Not yet assessed',
  1: 'Remember',
  2: 'Understand',
  3: 'Apply',
  4: 'Analyze',
  5: 'Create',
};

function bloomLabel(level: number): string {
  return BLOOM_LABELS[level] ?? `Level ${level}`;
}

/** Severity indicator component for a gap item */
function SeverityIndicator({ severity }: { severity: GapItem['severity'] }) {
  switch (severity) {
    case 'needs_learning':
      return (
        <span className="inline-flex items-center gap-1 text-orange-600">
          <AlertTriangle className="h-4 w-4" />
          <span className="text-xs font-medium">Needs learning</span>
        </span>
      );
    case 'partial_readiness':
      return (
        <span className="inline-flex items-center gap-1 text-yellow-600">
          <CircleMinus className="h-4 w-4" />
          <span className="text-xs font-medium">Partial readiness</span>
        </span>
      );
    case 'met':
      return (
        <span className="inline-flex items-center gap-1 text-green-600">
          <CheckCircle2 className="h-4 w-4" />
          <span className="text-xs font-medium">Met</span>
        </span>
      );
  }
}

/** Gap checklist for a single person */
function PersonGapChecklist({
  actionId,
  profile,
  skillProfile,
  learningAxes,
}: {
  actionId: string;
  profile: CapabilityProfile;
  skillProfile: SkillProfile;
  learningAxes?: LearningAxis[];
}) {
  const navigate = useNavigate();
  const gapItems = useMemo(
    () => sortGapsBySeverity(computeGapItems(skillProfile, profile)),
    [skillProfile, profile]
  );

  const summary = useMemo(
    () => computeGapSummary(skillProfile, profile),
    [skillProfile, profile]
  );

  // Build learning status per axis from objectives data (includes continuous score)
  const axisLearningStatus = useMemo(() => {
    const status = new Map<string, { hasObjectives: boolean; allComplete: boolean; completed: number; total: number; continuousScore: number }>();
    if (learningAxes) {
      for (const axis of learningAxes) {
        const total = axis.objectives.length;
        const completed = axis.objectives.filter(o => o.status === 'completed').length;
        status.set(axis.axisKey, {
          hasObjectives: total > 0,
          allComplete: total > 0 && completed === total,
          completed,
          total,
          continuousScore: axis.continuousScore ?? 0,
        });
      }
    }
    return status;
  }, [learningAxes]);

  // Count gaps that still need learning (not yet completed via quiz)
  const gapsStillNeeding = gapItems.filter(g => {
    const ls = axisLearningStatus.get(g.axisKey);
    return !ls?.allComplete;
  }).length;

  const hasGaps = summary.gaps > 0;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-medium text-foreground">
          {profile.user_name}
        </h4>
        {hasGaps ? (
          <span className="text-xs text-muted-foreground">
            {gapsStillNeeding > 0
              ? `${gapsStillNeeding} of ${summary.total} skills need attention`
              : `All learning complete — ${summary.gaps} skill${summary.gaps !== 1 ? 's' : ''} still building capability`}
          </span>
        ) : (
          <span className="text-xs text-green-600 font-medium flex items-center gap-1">
            <CheckCircle2 className="h-3.5 w-3.5" />
            All requirements met
          </span>
        )}
      </div>

      {hasGaps && (
        <ul className="space-y-1.5">
          {gapItems.map((gap) => {
            const ls = axisLearningStatus.get(gap.axisKey);
            const hasObjectives = ls?.hasObjectives ?? false;
            const allComplete = ls?.allComplete ?? false;
            return (
              <li
                key={gap.axisKey}
                className={`rounded-md border px-3 py-2 text-sm space-y-1.5 ${allComplete ? 'border-green-200 bg-green-50/50' : ''}`}
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 min-w-0">
                    {allComplete && <CheckCircle2 className="h-4 w-4 text-green-600 shrink-0" />}
                    <span className="font-medium truncate">{gap.axisLabel}</span>
                    <Badge variant="outline" className="text-xs shrink-0">
                      {(() => {
                        const displayScore = Math.max(ls?.continuousScore ?? 0, gap.currentLevel);
                        return `${displayScore.toFixed(1)} — ${scoreToGrowthLabel(displayScore)}`;
                      })()}
                    </Badge>
                    <span className="text-muted-foreground text-xs shrink-0">→</span>
                    <Badge variant="secondary" className="text-xs shrink-0">
                      {bloomLabel(gap.requiredLevel)}
                    </Badge>
                  </div>
                  <div className="shrink-0 ml-2">
                    {allComplete ? (
                      <span className="inline-flex items-center gap-1 text-green-600">
                        <CheckCircle2 className="h-4 w-4" />
                        <span className="text-xs font-medium">Learning complete</span>
                      </span>
                    ) : ls && ls.total > 0 ? (
                      <span className="text-xs text-muted-foreground">
                        {ls.completed}/{ls.total} objectives
                      </span>
                    ) : (
                      <SeverityIndicator severity={gap.severity} />
                    )}
                  </div>
                </div>
                <div>
                  <Button
                    variant={hasObjectives ? 'outline' : 'default'}
                    size="sm"
                    onClick={() => navigate(`/actions/${actionId}/quiz/${gap.axisKey}`)}
                  >
                    <BookOpen className="h-4 w-4 mr-1.5" />
                    {allComplete ? 'Review Learning' : hasObjectives ? 'Continue Learning' : 'Start Learning'}
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** Convert a LearningObjective from the API into ObjectiveProgress for utility functions */
function toObjectiveProgress(obj: LearningObjective): ObjectiveProgress {
  return {
    objectiveId: obj.id,
    status: obj.status,
    completionType: obj.completionType,
  };
}

/** Status icon for a learning objective */
function ObjectiveStatusIcon({ status }: { status: LearningObjective['status'] }) {
  switch (status) {
    case 'not_started':
      return <span className="h-4 w-4 flex items-center justify-center text-muted-foreground">•</span>;
    case 'in_progress':
      return <CircleDot className="h-4 w-4 text-blue-500" />;
    case 'completed':
      return <CheckCircle2 className="h-4 w-4 text-green-600" />;
  }
}

/** Learning objectives section */
function LearningObjectivesSection({
  actionId,
  axes,
  capabilityLevels,
}: {
  actionId: string;
  axes: LearningAxis[];
  capabilityLevels?: Map<string, number>;
}) {
  const navigate = useNavigate();

  // Only show axes that have objectives
  const axesWithObjectives = axes.filter(a => a.objectives.length > 0);

  if (axesWithObjectives.length === 0) {
    return null;
  }

  // Build a Map<string, ObjectiveProgress[]> for isAllLearningComplete
  const axisObjectivesMap = new Map<string, ObjectiveProgress[]>();
  for (const axis of axesWithObjectives) {
    axisObjectivesMap.set(
      axis.axisKey,
      axis.objectives.map(toObjectiveProgress)
    );
  }

  const allComplete = isAllLearningComplete(axisObjectivesMap);
  const [expanded, setExpanded] = useState(!allComplete);

  return (
    <div className="space-y-3">
      {allComplete && (
        <button
          onClick={() => setExpanded(!expanded)}
          className="flex items-center justify-between w-full rounded-md border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-700 cursor-pointer hover:bg-green-100 transition-colors"
        >
          <span className="flex items-center gap-2">
            <CheckCircle2 className="h-4 w-4 shrink-0" />
            All learning objectives completed for this action
          </span>
          <ChevronDown className={`h-4 w-4 transition-transform ${expanded ? 'rotate-180' : ''}`} />
        </button>
      )}

      {(!allComplete || expanded) && (
      <div className="space-y-3">
        {axesWithObjectives.map((axisData) => {
          const objectives = axisData.objectives;
          const progressItems = objectives.map(toObjectiveProgress);
          const progress = computeAxisProgress(progressItems);
          const axisComplete = isAxisComplete(progressItems);
          const progressPercent = progress.total > 0 ? (progress.completed / progress.total) * 100 : 0;
          const axisLabel = axisData.axisLabel;

          return (
            <div key={axisData.axisKey} className={`rounded-md border p-3 space-y-2 ${axisComplete ? 'border-green-200 bg-green-50/50' : ''}`}>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 min-w-0">
                  {axisComplete && <CheckCircle2 className="h-4 w-4 text-green-600 shrink-0" />}
                  <span className="text-sm font-medium truncate">{axisLabel}</span>
                  <Badge variant="outline" className="text-xs shrink-0">
                    {(() => {
                      const capLevel = capabilityLevels?.get(axisData.axisKey) ?? 0;
                      const displayScore = Math.max(axisData.continuousScore ?? 0, capLevel);
                      return `${displayScore.toFixed(1)} — ${scoreToGrowthLabel(displayScore)}`;
                    })()}
                  </Badge>
                </div>
                <div className="shrink-0 ml-2">
                  {axisComplete ? (
                    <span className="inline-flex items-center gap-1 text-green-600">
                      <CheckCircle2 className="h-4 w-4" />
                      <span className="text-xs font-medium">Learning complete</span>
                    </span>
                  ) : (
                    <span className="text-xs text-muted-foreground">
                      {progress.completed} of {progress.total} objectives
                    </span>
                  )}
                </div>
              </div>

              <Progress value={progressPercent} className="h-2" />

              <ul className="space-y-1">
                  {objectives.map((obj) => (
                    <li key={obj.id} className="flex items-center gap-2 text-sm py-0.5">
                      <ObjectiveStatusIcon status={obj.status} />
                      <span className={obj.status === 'completed' ? 'text-muted-foreground' : 'text-foreground'}>
                        {obj.text}
                      </span>
                      {obj.status === 'completed' && obj.completionType && (
                        <Badge variant="outline" className="text-xs shrink-0">
                          {obj.completionType}
                        </Badge>
                      )}
                    </li>
                  ))}
                </ul>

              {/* Action button */}
              <div className="pt-1">
                {axisComplete ? (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => navigate(`/actions/${actionId}/quiz/${axisData.axisKey}`)}
                  >
                    <BookOpen className="h-4 w-4 mr-1.5" />
                    Review Learning
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    onClick={() => navigate(`/actions/${actionId}/quiz/${axisData.axisKey}`)}
                  >
                    <BookOpen className="h-4 w-4 mr-1.5" />
                    Continue Learning
                  </Button>
                )}
              </div>
            </div>
          );
        })}
      </div>
      )}
    </div>
  );
}

/**
 * Container component that fetches capability profiles for all involved people
 * and the organization, then renders the radar chart with drilldown support
 * and a gap checklist per person.
 *
 * Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 2.1, 2.2, 2.3, 2.4, 2.5, 3.1, 3.2, 3.3, 3.4, 3.5, 4.1, 4.7, 6.1, 6.2, 7.1, 7.2, 7.3, 7.4, 7.5
 */
export function CapabilityAssessment({ action }: CapabilityAssessmentProps) {
  const [selectedAxis, setSelectedAxis] = useState<string | null>(null);
  const [timedOut, setTimedOut] = useState(false);
  const [isRescoring, setIsRescoring] = useState(false);
  const { user } = useAuth();
  const queryClient = useQueryClient();

  // Check if the action has an approved skill profile
  const hasApprovedSkillProfile = !!action.skill_profile?.approved_at;
  const skillProfile = action.skill_profile as SkillProfile | null | undefined;

  // Fetch the current user's own capability profile — userId always from auth context
  const capabilityQuery = useQuery({
    queryKey: capabilityProfileQueryKey(action.id),
    queryFn: async () => {
      const result = await apiService.get<{ data: CapabilityProfile }>(
        `/capability/${action.id}`
      );
      return result.data;
    },
    enabled: hasApprovedSkillProfile,
    staleTime: 60_000,
  });

  const isLoading = capabilityQuery.isLoading;
  const hasError = capabilityQuery.isError;

  // 30-second loading timeout
  useEffect(() => {
    if (!isLoading) {
      setTimedOut(false);
      return;
    }
    const timer = setTimeout(() => setTimedOut(true), LOADING_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [isLoading]);

  // Retry failed query
  const handleRetry = useCallback(() => {
    setTimedOut(false);
    if (capabilityQuery.isError) capabilityQuery.refetch();
  }, [capabilityQuery]);

  // Collect successful capability profile (single user — self)
  const capabilityProfiles = useMemo(
    () => (capabilityQuery.isSuccess && capabilityQuery.data ? [capabilityQuery.data] : []),
    [capabilityQuery.isSuccess, capabilityQuery.data]
  );

  // Fetch learning objectives for the current user (used by gap checklist and objectives section)
  const { data: learningData, refetch: refetchLearning, isLoading: isLoadingLearning } = useLearningObjectives(
    hasApprovedSkillProfile ? action.id : undefined,
    hasApprovedSkillProfile ? user?.id : undefined
  );
  const learningAxes = learningData?.axes;

  // Build continuous scores map from learning axes for the radar chart
  const continuousScores = useMemo(() => {
    if (!learningAxes) return undefined;
    const scores = new Map<string, number>();
    for (const axis of learningAxes) {
      scores.set(axis.axisKey, axis.continuousScore);
    }
    return scores;
  }, [learningAxes]);

  // Build capability level map per axis for consistent score display (Math.max of learning + capability)
  const capabilityLevelsByAxis = useMemo(() => {
    const levels = new Map<string, number>();
    for (const p of capabilityProfiles) {
      for (const axis of p.axes) {
        levels.set(axis.key, Math.max(levels.get(axis.key) ?? 0, axis.level));
      }
    }
    return levels;
  }, [capabilityProfiles]);

  // Refetch learning objectives when capability data updates (e.g., after Regenerate)
  const capabilitySettled = !capabilityQuery.isLoading && !capabilityQuery.isFetching;
  const [prevSettled, setPrevSettled] = useState(false);
  useEffect(() => {
    if (capabilitySettled && !prevSettled && user?.id) {
      refetchLearning();
    }
    setPrevSettled(capabilitySettled);
  }, [capabilitySettled, prevSettled, refetchLearning, user?.id]);

  // Force rescore — bypasses cache and recomputes via Bedrock
  const handleRescore = useCallback(async () => {
    setIsRescoring(true);
    try {
      const result = await apiService.get<{ data: CapabilityProfile }>(
        `/capability/${action.id}?force=true`
      );
      queryClient.setQueryData(capabilityProfileQueryKey(action.id), result.data);
      refetchLearning();
    } catch (err) {
      console.error('Rescore failed:', err);
    } finally {
      setIsRescoring(false);
    }
  }, [action.id, queryClient, refetchLearning]);

  // --- Empty state: no approved skill profile ---
  // Don't render anything — SkillProfilePanel already handles the empty/generate flow.
  if (!hasApprovedSkillProfile || !skillProfile) {
    return null;
  }

  // --- Loading state ---
  if (isLoading && !timedOut) {
    return (
      <div className="flex flex-col items-center justify-center py-12">
        <Loader2 className="h-8 w-8 animate-spin text-primary mb-3" />
        <p className="text-sm text-muted-foreground">Analyzing target growth areas…</p>
      </div>
    );
  }

  // --- Timeout state ---
  if (timedOut) {
    return (
      <div className="flex flex-col items-center justify-center py-8 text-center space-y-3">
        <AlertCircle className="h-8 w-8 text-destructive" />
        <p className="text-sm text-muted-foreground">
          Analyzing growth areas is taking longer than expected.
        </p>
        <Button variant="outline" size="sm" onClick={handleRetry}>
          <RefreshCw className="h-4 w-4 mr-2" />
          Retry
        </Button>
      </div>
    );
  }

  // --- Error state ---
  if (hasError) {
    return (
      <div className="flex flex-col items-center justify-center py-8 text-center space-y-3">
        <AlertCircle className="h-8 w-8 text-destructive" />
        <p className="text-sm text-muted-foreground">
          Unable to load target growth areas. Please try again.
        </p>
        <Button variant="outline" size="sm" onClick={handleRetry}>
          <RefreshCw className="h-4 w-4 mr-2" />
          Retry
        </Button>
      </div>
    );
  }

  // --- Radar chart + gap checklist + drilldown ---
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-foreground">Target Growth Areas</h3>
        <Button
          variant="outline"
          size="sm"
          onClick={handleRescore}
          disabled={isRescoring || isLoading}
          className="h-7 px-2 text-xs"
        >
          {isRescoring ? (
            <Loader2 className="h-3 w-3 animate-spin mr-1" />
          ) : (
            <RefreshCw className="h-3 w-3 mr-1" />
          )}
          Rescore
        </Button>
      </div>

      <SkillRadialChart
        skillProfile={skillProfile}
        capabilityProfiles={capabilityProfiles}
        continuousScores={continuousScores}
        onAxisClick={(axisKey) => setSelectedAxis(axisKey)}
      />
      {isLoadingLearning && (
        <div className="flex items-center justify-center gap-2 -mt-2 text-xs text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" />
          Updating scores…
        </div>
      )}

      {/* Learning objectives */}
      {isLoadingLearning ? (
        <div className="flex items-center gap-2 py-3 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading learning objectives…
        </div>
      ) : learningAxes && learningAxes.length > 0 ? (
        <LearningObjectivesSection
          actionId={action.id}
          axes={learningAxes}
          capabilityLevels={capabilityLevelsByAxis}
        />
      ) : null}

      {selectedAxis && (
        <AxisDrilldown
          actionId={action.id}
          axisKey={selectedAxis}
          skillProfile={skillProfile}
          capabilityProfiles={capabilityProfiles}
          isOpen={!!selectedAxis}
          onClose={() => setSelectedAxis(null)}
        />
      )}
    </div>
  );
}
