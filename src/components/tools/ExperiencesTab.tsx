/**
 * ExperiencesTab
 *
 * A container's experiences, in three sections:
 * - Suggestions: AI-proposed action hypotheses (find suggestions + use/dismiss).
 *   Nothing here is real until a person confirms it.
 * - Open: confirmed actions (via "Use," or attached directly) with no
 *   full write-up yet.
 * - Completed: full experiences (initial + final state, any number of
 *   actions), editable in place. A decline is exactly as valid a result
 *   as growth here — "completed" describes the write-up, not that the
 *   outcome was new information to the person who lived it.
 */

import { useEffect, useMemo, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
import { Loader2, Sparkles, Check, X, Plus } from 'lucide-react';
import { format } from 'date-fns';
import { useToast } from '@/hooks/use-toast';
import {
  useExperienceSuggestions,
  useGenerateExperienceSuggestions,
  useConfirmExperienceSuggestion,
  useDismissExperienceSuggestion,
  useExperiences,
} from '@/hooks/useExperiences';
import { actionService, type ActionResponse } from '@/services/actionService';
import type { ExperienceSuggestion } from '@/lib/apiService';
import type { Experience } from '@/types/experiences';
import { ExperienceBuilderDialog } from './ExperienceBuilderDialog';

interface ExperiencesTabProps {
  entityType: 'tool' | 'part';
  entityId: string;
  entityName?: string;
  organizationId: string;
  disabled?: boolean;
}

function SuggestionCard({
  entityType,
  entityId,
  suggestion,
  onUsed,
}: {
  entityType: 'tool' | 'part';
  entityId: string;
  suggestion: ExperienceSuggestion;
  onUsed: () => void;
}) {
  const { toast } = useToast();
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(suggestion.title);
  const [description, setDescription] = useState(suggestion.description);
  const [expectedState, setExpectedState] = useState(suggestion.expected_state || '');
  const confirm = useConfirmExperienceSuggestion(entityType, entityId);
  const dismiss = useDismissExperienceSuggestion(entityType, entityId);

  const handleUse = async () => {
    try {
      await confirm.mutateAsync({
        perspective_id: suggestion.perspective_id,
        hypothesis_index: suggestion.hypothesis_index,
        title,
        description,
        action_type: suggestion.action_type,
        expected_state: expectedState || undefined,
      });
      toast({ title: 'Action confirmed', description: `"${title}" was added to Open.` });
      onUsed();
    } catch (err) {
      console.error(err);
      toast({ title: 'Error', description: 'Failed to confirm this action.', variant: 'destructive' });
    }
  };

  const handleDismiss = async () => {
    try {
      await dismiss.mutateAsync({ perspective_id: suggestion.perspective_id, hypothesis_index: suggestion.hypothesis_index });
      onUsed();
    } catch (err) {
      console.error(err);
      toast({ title: 'Error', description: 'Failed to dismiss this suggestion.', variant: 'destructive' });
    }
  };

  return (
    <Card>
      <CardContent className="pt-4 space-y-3">
        <div className="flex items-start justify-between gap-2">
          <div className="space-y-1 flex-1">
            {editing ? (
              <Input value={title} onChange={(e) => setTitle(e.target.value)} className="font-medium" />
            ) : (
              <p className="font-medium">{title}</p>
            )}
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Badge variant="outline">{suggestion.action_type === 'transformative' ? 'Transformative' : 'Entropy reduction'}</Badge>
              <span>{format(new Date(suggestion.final_captured_at), 'MMM d, yyyy')}</span>
              <span>confidence {(suggestion.confidence * 100).toFixed(0)}%</span>
            </div>
          </div>
          {suggestion.photos.length > 0 && (
            <div className="flex -space-x-2">
              {suggestion.photos.slice(0, 3).map((p) => (
                <img key={p.id} src={p.photo_url} alt="" className="h-10 w-10 rounded object-cover border-2 border-background" />
              ))}
            </div>
          )}
        </div>

        {editing ? (
          <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} />
        ) : (
          <p className="text-sm text-muted-foreground">{description}</p>
        )}

        {suggestion.expected_state && (
          editing ? (
            <Input
              value={expectedState}
              onChange={(e) => setExpectedState(e.target.value)}
              placeholder="Where we want to get to..."
              className="text-sm"
            />
          ) : (
            <p className="text-sm"><span className="text-muted-foreground">Goal: </span>{expectedState}</p>
          )
        )}

        <div className="flex justify-end gap-2 pt-1">
          <Button size="sm" variant="ghost" onClick={() => setEditing(!editing)}>
            {editing ? 'Done' : 'Edit'}
          </Button>
          <Button size="sm" variant="outline" onClick={handleDismiss} disabled={dismiss.isPending || confirm.isPending}>
            <X className="h-4 w-4 mr-1" />
            Dismiss
          </Button>
          <Button size="sm" onClick={handleUse} disabled={dismiss.isPending || confirm.isPending}>
            {confirm.isPending ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Check className="h-4 w-4 mr-1" />}
            Use
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

export function ExperiencesTab({ entityType, entityId, entityName, organizationId, disabled }: ExperiencesTabProps) {
  const { toast } = useToast();
  const { data: suggestionsRes, isLoading: loadingSuggestions, refetch: refetchSuggestions } = useExperienceSuggestions(entityType, entityId);
  const generateSuggestions = useGenerateExperienceSuggestions(entityType, entityId);
  const { data: experiencesRes, isLoading: loadingExperiences } = useExperiences({ entity_type: entityType, entity_id: entityId });

  const [openActions, setOpenActions] = useState<ActionResponse[]>([]);
  const [loadingOpenActions, setLoadingOpenActions] = useState(false);
  const [builderOpen, setBuilderOpen] = useState(false);
  const [builderPreselectedActionId, setBuilderPreselectedActionId] = useState<string | undefined>(undefined);
  const [editingExperience, setEditingExperience] = useState<Experience | undefined>(undefined);

  const experiences = experiencesRes?.data || [];

  const attachedActionIds = useMemo(() => {
    const ids = new Set<string>();
    experiences.forEach((exp) => (exp.components?.actions || []).forEach((c) => c.action_id && ids.add(c.action_id)));
    return ids;
  }, [experiences]);

  const fetchOpenActions = async () => {
    if (entityType !== 'tool') return;
    setLoadingOpenActions(true);
    try {
      const actions = await actionService.listActions({ asset_id: entityId, status: 'completed' });
      setOpenActions(actions);
    } catch (err) {
      console.error('Failed to load actions:', err);
    } finally {
      setLoadingOpenActions(false);
    }
  };

  useEffect(() => {
    fetchOpenActions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entityType, entityId]);

  const trulyOpenActions = openActions.filter((a) => !attachedActionIds.has(a.id));

  const completedExperiences = experiences.filter((exp) => exp.components?.initial_state && exp.components?.final_state);

  const handleGenerateSuggestions = async () => {
    try {
      const result = await generateSuggestions.mutateAsync();
      toast({
        title: 'Suggestions updated',
        description: result.experiences_found > 0
          ? `Found ${result.experiences_found} candidate action(s) across ${result.pairs_processed} observation pair(s).`
          : result.message || `No new actions found across ${result.pairs_processed} observation pair(s).`,
      });
    } catch (err) {
      console.error(err);
      toast({ title: 'Error', description: 'Failed to find suggestions.', variant: 'destructive' });
    }
  };

  const suggestions = suggestionsRes?.data || [];

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <CardTitle className="text-base">Suggestions</CardTitle>
          <Button size="sm" variant="outline" onClick={handleGenerateSuggestions} disabled={disabled || generateSuggestions.isPending}>
            {generateSuggestions.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Sparkles className="h-4 w-4 mr-2" />}
            {generateSuggestions.isPending ? 'Finding suggestions...' : 'Find suggestions'}
          </Button>
        </CardHeader>
        <CardContent className="space-y-3">
          {loadingSuggestions ? (
            <p className="text-sm text-muted-foreground">Loading...</p>
          ) : suggestions.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No open suggestions. Find suggestions to check recent observations for a reported action.
            </p>
          ) : (
            suggestions.map((s) => (
              <SuggestionCard
                key={`${s.perspective_id}:${s.hypothesis_index}`}
                entityType={entityType}
                entityId={entityId}
                suggestion={s}
                onUsed={() => { refetchSuggestions(); fetchOpenActions(); }}
              />
            ))
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <CardTitle className="text-base">Open</CardTitle>
          <Button size="sm" onClick={() => { setEditingExperience(undefined); setBuilderPreselectedActionId(undefined); setBuilderOpen(true); }} disabled={disabled}>
            <Plus className="h-4 w-4 mr-2" />
            New experience
          </Button>
        </CardHeader>
        <CardContent className="space-y-2">
          {loadingOpenActions ? (
            <p className="text-sm text-muted-foreground">Loading...</p>
          ) : trulyOpenActions.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nothing confirmed yet without a write-up.</p>
          ) : (
            trulyOpenActions.map((action) => (
              <div key={action.id} className="flex items-center justify-between rounded-md border p-3">
                <div>
                  <p className="font-medium text-sm">{action.title}</p>
                  {action.completed_at && (
                    <p className="text-xs text-muted-foreground">{format(new Date(action.completed_at), 'MMM d, yyyy')}</p>
                  )}
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => { setEditingExperience(undefined); setBuilderPreselectedActionId(action.id); setBuilderOpen(true); }}
                >
                  Write up
                </Button>
              </div>
            ))
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Completed</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {loadingExperiences ? (
            <p className="text-sm text-muted-foreground">Loading...</p>
          ) : completedExperiences.length === 0 ? (
            <p className="text-sm text-muted-foreground">No completed write-ups yet.</p>
          ) : (
            completedExperiences.map((exp) => (
              <div key={exp.id} className="rounded-md border p-3 space-y-1">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    {exp.components?.initial_state?.state?.captured_at && (
                      <span>{format(new Date(exp.components.initial_state.state.captured_at), 'MMM d, yyyy')}</span>
                    )}
                    <span>&rarr;</span>
                    {exp.components?.final_state?.state?.captured_at && (
                      <span>{format(new Date(exp.components.final_state.state.captured_at), 'MMM d, yyyy')}</span>
                    )}
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => { setEditingExperience(exp); setBuilderOpen(true); }}
                  >
                    Edit
                  </Button>
                </div>
                {(exp.components?.actions || []).map((c) => (
                  <Badge key={c.id} variant="secondary" className="mr-1">
                    {c.action?.title || 'Untitled action'}
                  </Badge>
                ))}
                {exp.components?.final_state?.state?.state_text && (
                  <p className="text-sm">{exp.components.final_state.state.state_text}</p>
                )}
              </div>
            ))
          )}
        </CardContent>
      </Card>

      <ExperienceBuilderDialog
        open={builderOpen}
        onOpenChange={(o) => { setBuilderOpen(o); if (!o) setEditingExperience(undefined); }}
        entityType={entityType}
        entityId={entityId}
        entityName={entityName}
        organizationId={organizationId}
        openActions={trulyOpenActions}
        preselectedActionId={builderPreselectedActionId}
        experience={editingExperience}
        onSuccess={() => { fetchOpenActions(); }}
      />
    </div>
  );
}
