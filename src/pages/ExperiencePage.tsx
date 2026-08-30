/**
 * ExperiencePage
 *
 * Organizes one experience as S → A → S′, with every component's real content
 * visible and editable in one place.
 *
 * Each leg is a list, not a single slot. An experience genuinely has several
 * states and actions per leg — start with ash, measure phosphorus and take a
 * water sample (two actions), end with the phosphorus reading and the water
 * reading (two final states). The readings *are* the end state, so they show
 * as first-class metric chips rather than only as prose.
 *
 * Any leg may be empty: an experience whose outcome hasn't been observed yet
 * is a normal in-progress experiment, not an error.
 *
 * Replaces the old ExperienceBuilderDialog, which assumed one state per leg
 * and picked it from a text-preview dropdown — so a state with photos but no
 * text was invisible and unreachable.
 */

import { useEffect, useMemo, useState } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import { ArrowLeft, Loader2, Plus, X, ImagePlus, Camera, Route } from 'lucide-react';
import { format } from 'date-fns';
import { useToast } from '@/hooks/use-toast';
import { useOrganization } from '@/hooks/useOrganization';
import { useExperience, useCreateExperience, useUpdateExperience } from '@/hooks/useExperiences';
import { useStates } from '@/hooks/useStates';
import { useFileUpload } from '@/hooks/useFileUpload';
import { stateService } from '@/services/stateService';
import { actionService, type ActionResponse } from '@/services/actionService';
import { snapshotService } from '@/services/snapshotService';
import { apiService, draftExperience, type DraftExperienceProposal } from '@/lib/apiService';
import { PhotoUploadPanel, type PhotoItem } from '@/components/shared/PhotoUploadPanel';
import { getImageUrl } from '@/lib/imageUtils';
import { LinkExistingPhotoDialog, type LinkablePhoto } from '@/components/shared/LinkExistingPhotoDialog';
import type { Experience, ExperienceComponent } from '@/types/experiences';
import type { Observation } from '@/types/observations';

type LegKey = 'initial_states' | 'final_states';

/** Local editing buffer for one state card. */
interface StateDraft {
  stateId: string;
  text: string;
  photos: PhotoItem[];
  dirty: boolean;
  /** Person-corrected date for this state, when the extracted/logged date
   *  was wrong. Distinct from any photo's own date — this is a correction
   *  to the state's own captured_at, not to a photo. */
  capturedAtOverride?: string | null;
}

/**
 * Promoting an individual photo builds up a NEW state that this experience
 * owns, rather than appending to an observation that came from elsewhere —
 * promoting shouldn't silently edit someone's original observation. These
 * pending states hold promoted photos until Save, when they're created for
 * real and attached to their lane.
 */
const PENDING_STATE_ID: Record<LegKey, string> = {
  initial_states: '__pending_initial_state__',
  final_states: '__pending_final_state__',
};
const isPendingStateId = (id: string) =>
  id === PENDING_STATE_ID.initial_states || id === PENDING_STATE_ID.final_states;

// Same sentinel pattern as PENDING_STATE_ID: an AI-drafted action (from an
// observation-anchored "Draft Experience") doesn't exist yet, so it's held
// under this id in the Action lane until Save creates it for real.
const DRAFT_ACTION_ID = '__draft_action__';

// A person-authored new action (title + observation, no AI involved) — same
// "held here until Save" pattern as DRAFT_ACTION_ID and PENDING_STATE_ID.
const NEW_ACTION_ID = '__new_action__';

export default function ExperiencePage() {
  const { experienceId } = useParams<{ experienceId?: string }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { toast } = useToast();
  const { organization } = useOrganization();
  const orgId = organization?.id || '';
  const { uploadFiles } = useFileUpload();

  const isNew = !experienceId || experienceId === 'new';

  // For a new experience the entity comes from the query string (the
  // Experiences tab links through with it); for an existing one it comes
  // from the experience itself.
  const entityTypeParam = (searchParams.get('entity_type') as 'tool' | 'part') || 'tool';
  const entityIdParam = searchParams.get('entity_id') || '';
  const preselectedActionId = searchParams.get('action_id') || undefined;

  // "Draft Experience" entry point: a person picked one real observation or
  // action they already recognize as worth writing up. draft_action_id wins
  // if both are somehow present.
  const draftStateIdParam = searchParams.get('draft_state_id') || undefined;
  const draftActionIdParam = searchParams.get('draft_action_id') || undefined;
  const draftAnchor = draftActionIdParam
    ? { type: 'action' as const, id: draftActionIdParam }
    : draftStateIdParam
      ? { type: 'state' as const, id: draftStateIdParam }
      : null;

  const { data: experience, isLoading } = useExperience(isNew ? '' : experienceId!);

  const entityType = experience?.entity_type || entityTypeParam;
  const entityId = experience?.entity_id || entityIdParam;

  const createExperience = useCreateExperience();
  const updateExperience = useUpdateExperience(entityType, entityId);

  // Candidate pool: this container's whole history.
  const { data: candidateStates } = useStates(orgId, {
    entity_type: entityType,
    entity_id: entityId,
  });
  const [candidateActions, setCandidateActions] = useState<ActionResponse[]>([]);

  useEffect(() => {
    if (entityType !== 'tool' || !entityId) return;
    actionService
      .listActions({ asset_id: entityId, status: 'completed' })
      .then(setCandidateActions)
      .catch((err) => console.error('Failed to load candidate actions:', err));
  }, [entityType, entityId]);

  // Name of the tool/part this experience belongs to — used so the
  // "Add from..." panel below names the actual asset instead of the
  // generic (and, for a part, simply wrong) word "container".
  const [entityName, setEntityName] = useState<string | null>(null);
  useEffect(() => {
    if (!entityId) return;
    setEntityName(null);
    apiService
      .get<{ data: { name?: string } }>(`/${entityType === 'tool' ? 'tools' : 'parts'}/${entityId}`)
      .then((res) => setEntityName(res.data?.name || null))
      .catch((err) => console.error('Failed to load entity name:', err));
  }, [entityType, entityId]);

  // --- Lane membership (component ids) ---------------------------------
  const [initialStateIds, setInitialStateIds] = useState<string[]>([]);
  const [finalStateIds, setFinalStateIds] = useState<string[]>([]);
  const [actionIds, setActionIds] = useState<string[]>([]);
  const [claimEdits, setClaimEdits] = useState<Record<string, string>>({});
  const [titleEdits, setTitleEdits] = useState<Record<string, string>>({});
  // Person-corrected completed_at per action, keyed by action id — same
  // correction purpose as StateDraft.capturedAtOverride, for the action's
  // own date instead of a state's.
  const [actionDateEdits, setActionDateEdits] = useState<Record<string, string>>({});
  // Person-corrected metric values, keyed by snapshot id (e.g. Coverage %
  // read wrong at capture time) — and snapshots marked for removal
  // entirely, when a metric doesn't belong on this state at all.
  const [metricValueEdits, setMetricValueEdits] = useState<Record<string, string>>({});
  const [removedMetricIds, setRemovedMetricIds] = useState<Set<string>>(new Set());
  // photo_urls explicitly picked from an action's already-linked set, for
  // this experience only (opt-in — default none) — the underlying
  // state_links are untouched, so any photo stays pickable regardless of
  // whether it's currently included here.
  const [photoInclusions, setPhotoInclusions] = useState<Record<string, string[]>>({});
  const [drafts, setDrafts] = useState<Record<string, StateDraft>>({});
  const [isSaving, setIsSaving] = useState(false);
  const [linkPhotoTarget, setLinkPhotoTarget] = useState<{ kind: 'state' | 'action'; id: string } | null>(null);

  // Photos attached directly to an action (not to a state leg) — new photos
  // pending attachment, created as the action's own linked observation on save.
  const [actionPhotoDrafts, setActionPhotoDrafts] = useState<Record<string, PhotoItem[]>>({});
  // Observations already linked to each action (entity_type='action'), fetched
  // on demand — same mechanism UnifiedActionDialog/StatesInline use.
  const [actionStatesById, setActionStatesById] = useState<Record<string, Observation[]>>({});

  // --- Draft Experience (AI-assisted, from one anchor + a person's note) ---
  const [draftNote, setDraftNote] = useState('');
  const [isDrafting, setIsDrafting] = useState(false);
  const [hasDrafted, setHasDrafted] = useState(false);
  // AI-proposed action content when anchored on an observation — the action
  // doesn't exist yet, so it's held here (editable) until Save creates it for
  // real, same "materialize at Save, not before" rule as everything else here.
  const [draftAction, setDraftAction] = useState<{
    title: string;
    description: string;
    action_type: 'transformative' | 'entropy_reduction';
    expected_state?: string;
  } | null>(null);
  // Points at the untouched AI draft (state_perspectives row) so Save can
  // stamp experiences.metadata with it for future contrast.
  const [draftPerspectiveId, setDraftPerspectiveId] = useState<string | null>(null);
  const [draftGenerationConfigId, setDraftGenerationConfigId] = useState<string | null>(null);

  // --- New action (person-authored: a title + one observation, no AI) ---
  // Doesn't exist yet, so it's held here (editable) until Save creates the
  // action and its observation for real — same pattern as draftAction above,
  // just without any AI involved.
  const [newActionDraft, setNewActionDraft] = useState<{
    title: string;
    text: string;
    photos: PhotoItem[];
  } | null>(null);

  // Seed local state from the fetched experience (or from the query string
  // for a brand new one).
  useEffect(() => {
    if (isNew) {
      setInitialStateIds([]);
      // A state-anchored draft places the real, already-existing observation
      // straight into the final-state lane — no AI needed for that leg, only
      // for the action and the initial state around it.
      setFinalStateIds(draftAnchor?.type === 'state' ? [draftAnchor.id] : []);
      const initialActionId = preselectedActionId || (draftAnchor?.type === 'action' ? draftAnchor.id : undefined);
      setActionIds(initialActionId ? [initialActionId] : []);
      setClaimEdits({});
      setTitleEdits({});
      setPhotoInclusions({});
      setDrafts({});
      setDraftNote('');
      setHasDrafted(false);
      setDraftAction(null);
      setDraftPerspectiveId(null);
      setDraftGenerationConfigId(null);
      setNewActionDraft(null);
      return;
    }
    if (!experience) return;

    const initial = (experience.components?.initial_states || [])
      .map((c) => c.state_id).filter(Boolean) as string[];
    const final = (experience.components?.final_states || [])
      .map((c) => c.state_id).filter(Boolean) as string[];
    const actions = (experience.components?.actions || [])
      .map((c) => c.action_id).filter(Boolean) as string[];

    setInitialStateIds(initial);
    setFinalStateIds(final);
    setActionIds(actions);

    const edits: Record<string, string> = {};
    const inclusions: Record<string, string[]> = {};
    for (const c of experience.components?.actions || []) {
      if (c.action_id && c.action?.claim_edit) edits[c.action_id] = c.action.claim_edit;
      if (c.action_id && c.action?.included_photo_urls?.length) {
        inclusions[c.action_id] = c.action.included_photo_urls;
      }
    }
    setClaimEdits(edits);
    setPhotoInclusions(inclusions);

    // Editing buffers for every attached state.
    const nextDrafts: Record<string, StateDraft> = {};
    for (const c of [...(experience.components?.initial_states || []), ...(experience.components?.final_states || [])]) {
      if (!c.state_id || !c.state) continue;
      nextDrafts[c.state_id] = {
        stateId: c.state_id,
        text: c.state.state_text || '',
        photos: (c.state.photos || []).map((p, idx) => ({
          id: p.id,
          photo_url: p.photo_url,
          photo_description: p.photo_description || '',
          photo_order: idx,
          previewUrl: p.photo_url,
          isExisting: true,
          captured_at: p.captured_at ?? null,
        })),
        dirty: false,
      };
    }
    setDrafts(nextDrafts);
  }, [experience, isNew, preselectedActionId, draftAnchor?.type, draftAnchor?.id]);

  // Fetch each action's already-linked observations (photos included) so the
  // card can show what's already there, not just what's added this session.
  useEffect(() => {
    const missing = actionIds.filter((id) => !(id in actionStatesById));
    if (missing.length === 0) return;
    Promise.all(
      missing.map((id) =>
        stateService
          .getStates({ entity_type: 'action', entity_id: id })
          .then((states) => [id, states] as const)
          .catch(() => [id, [] as Observation[]] as const)
      )
    ).then((results) => {
      setActionStatesById((prev) => {
        const next = { ...prev };
        for (const [id, states] of results) next[id] = states;
        return next;
      });
    });
  }, [actionIds]); // eslint-disable-line react-hooks/exhaustive-deps

  // --- Lookups ---------------------------------------------------------
  const statesById = useMemo(() => {
    const map = new Map<string, Observation>();
    for (const s of candidateStates || []) map.set(s.id, s);
    return map;
  }, [candidateStates]);

  const actionsById = useMemo(() => {
    const map = new Map<string, ActionResponse>();
    for (const a of candidateActions) map.set(a.id, a);
    return map;
  }, [candidateActions]);

  /** Component metadata (metrics, claim) from the fetched experience. */
  const componentByStateId = useMemo(() => {
    const map = new Map<string, ExperienceComponent>();
    for (const c of [...(experience?.components?.initial_states || []), ...(experience?.components?.final_states || [])]) {
      if (c.state_id) map.set(c.state_id, c);
    }
    return map;
  }, [experience]);

  const componentByActionId = useMemo(() => {
    const map = new Map<string, ExperienceComponent>();
    for (const c of experience?.components?.actions || []) {
      if (c.action_id) map.set(c.action_id, c);
    }
    return map;
  }, [experience]);

  const usedIds = useMemo(
    () => new Set([...initialStateIds, ...finalStateIds, ...actionIds]),
    [initialStateIds, finalStateIds, actionIds]
  );

  // --- Editing helpers -------------------------------------------------
  const buildInitialDraft = (stateId: string): StateDraft => {
    const comp = componentByStateId.get(stateId);
    const fallback = statesById.get(stateId);
    return {
      stateId,
      text: comp?.state?.state_text ?? fallback?.observation_text ?? '',
      photos: (comp?.state?.photos || fallback?.photos || []).map((p: any, idx: number) => ({
        id: p.id,
        photo_url: p.photo_url,
        photo_description: p.photo_description || '',
        photo_order: idx,
        previewUrl: p.photo_url,
        isExisting: true,
        // The photo's own EXIF/file date, when extracted — see PhotoItem's
        // captured_at doc comment for why this is worth showing here.
        captured_at: p.captured_at ?? null,
      })),
      dirty: false,
    };
  };

  const ensureDraft = (stateId: string): StateDraft => {
    if (drafts[stateId]) return drafts[stateId];
    const draft = buildInitialDraft(stateId);
    setDrafts((prev) => (prev[stateId] ? prev : { ...prev, [stateId]: draft }));
    return draft;
  };

  // Always merges onto prev[stateId] (React's actual latest state), never a
  // separately-read draft — ensureDraft's own reads/writes go through a
  // stale outer closure, so using it here as the merge base could silently
  // drop whatever a second update landed in the same tick (e.g. a just-added
  // photo overwritten by an immediately-following text change).
  const updateDraft = (stateId: string, patch: Partial<StateDraft>) => {
    setDrafts((prev) => ({
      ...prev,
      [stateId]: { ...(prev[stateId] ?? buildInitialDraft(stateId)), ...patch, dirty: true },
    }));
  };

  const handleEagerUpload = async (file: File) => {
    const result = await uploadFiles(file, { bucket: 'mission-attachments' });
    const r = Array.isArray(result) ? result[0] : result;
    return { url: r.url };
  };

  const addToLane = (leg: LegKey, id: string) => {
    const setter = leg === 'initial_states' ? setInitialStateIds : setFinalStateIds;
    setter((prev) => (prev.includes(id) ? prev : [...prev, id]));
    ensureDraft(id);
  };

  const removeFromLane = (leg: LegKey, id: string) => {
    const setter = leg === 'initial_states' ? setInitialStateIds : setFinalStateIds;
    setter((prev) => prev.filter((x) => x !== id));
    // A pending state exists only in this lane — discard its promoted photos
    // too, so re-promoting starts clean rather than resurrecting old ones.
    if (isPendingStateId(id)) {
      setDrafts((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
    }
  };

  /**
   * Promote one photo out of an observation into a lane. The photo is copied
   * into this experience's own pending state — the source observation keeps
   * its copy and is not modified.
   */
  const promotePhoto = (
    leg: LegKey,
    photo: { photo_url: string; photo_description?: string | null }
  ) => {
    const pendingId = PENDING_STATE_ID[leg];
    const existing = drafts[pendingId];
    const alreadyThere = (existing?.photos || []).some((p) => p.photo_url === photo.photo_url);
    if (alreadyThere) {
      toast({ title: 'Already added', description: 'That photo is already in this state.' });
      return;
    }

    const nextPhotos: PhotoItem[] = [
      ...(existing?.photos || []),
      {
        photo_url: photo.photo_url,
        photo_description: photo.photo_description || '',
        photo_order: existing?.photos.length || 0,
        previewUrl: photo.photo_url,
        isExisting: false,
      },
    ];

    setDrafts((prev) => ({
      ...prev,
      [pendingId]: {
        stateId: pendingId,
        text: existing?.text || '',
        photos: nextPhotos,
        dirty: true,
      },
    }));

    const setter = leg === 'initial_states' ? setInitialStateIds : setFinalStateIds;
    setter((prev) => (prev.includes(pendingId) ? prev : [...prev, pendingId]));
  };

  const handleLinkedPhotos = (stateId: string, linked: LinkablePhoto[]) => {
    const draft = ensureDraft(stateId);
    const existingUrls = new Set(draft.photos.map((p) => p.photo_url));
    const additions: PhotoItem[] = linked
      .filter((p) => !existingUrls.has(p.photo_url))
      .map((p, idx) => ({
        photo_url: p.photo_url,
        photo_description: p.photo_description || '',
        photo_order: draft.photos.length + idx,
        previewUrl: p.photo_url,
        isExisting: false,
      }));
    if (additions.length) updateDraft(stateId, { photos: [...draft.photos, ...additions] });
  };

  const handleLinkedActionPhotos = (actionId: string, linked: LinkablePhoto[]) => {
    // A brand-new action's photos live on newActionDraft, not actionPhotoDrafts
    // (there's no real action id yet to key the latter by).
    if (actionId === NEW_ACTION_ID) {
      setNewActionDraft((prev) => {
        if (!prev) return prev;
        const alreadyAttached = new Set(prev.photos.map((p) => p.photo_url));
        const additions: PhotoItem[] = linked
          .filter((p) => !alreadyAttached.has(p.photo_url))
          .map((p, idx) => ({
            photo_url: p.photo_url,
            photo_description: p.photo_description || '',
            photo_order: prev.photos.length + idx,
            previewUrl: p.photo_url,
            isExisting: false,
          }));
        return additions.length ? { ...prev, photos: [...prev.photos, ...additions] } : prev;
      });
      return;
    }
    const current = actionPhotoDrafts[actionId] || [];
    const alreadyAttached = new Set([
      ...current.map((p) => p.photo_url),
      ...(actionStatesById[actionId] || []).flatMap((s) => (s.photos || []).map((p) => p.photo_url)),
    ]);
    const additions: PhotoItem[] = linked
      .filter((p) => !alreadyAttached.has(p.photo_url))
      .map((p, idx) => ({
        photo_url: p.photo_url,
        photo_description: p.photo_description || '',
        photo_order: current.length + idx,
        previewUrl: p.photo_url,
        isExisting: false,
      }));
    if (additions.length) {
      setActionPhotoDrafts((prev) => ({ ...prev, [actionId]: [...current, ...additions] }));
    }
  };

  /**
   * Explicitly picks one of an action's already-linked photos into this
   * write-up. This never touches the underlying state_link — the photo
   * stays real and stays on the action either way; this only controls
   * whether it shows up as part of this particular experience.
   */
  const includeLinkedPhoto = (actionId: string, photoUrl: string) => {
    setPhotoInclusions((prev) => {
      const current = prev[actionId] || [];
      if (current.includes(photoUrl)) return prev;
      return { ...prev, [actionId]: [...current, photoUrl] };
    });
  };

  /** Un-picks a previously included photo. The link itself is untouched. */
  const removeIncludedPhoto = (actionId: string, photoUrl: string) => {
    setPhotoInclusions((prev) => {
      const current = prev[actionId] || [];
      if (!current.includes(photoUrl)) return prev;
      return { ...prev, [actionId]: current.filter((u) => u !== photoUrl) };
    });
  };

  /**
   * Fires the AI draft for the anchored observation/action plus the
   * person's note. Writes nothing real — only pre-fills the draft lanes
   * (via the existing pending-state mechanism, and a new draftAction for the
   * observation-anchored case) for the person to edit before Save.
   */
  const handleDraftExperience = async () => {
    if (!draftAnchor || !entityId) return;
    setIsDrafting(true);
    try {
      const res = await draftExperience({
        entity_type: entityType,
        entity_id: entityId,
        anchor_type: draftAnchor.type,
        anchor_id: draftAnchor.id,
        note: draftNote,
      });
      const proposal: DraftExperienceProposal = res.proposal;
      setDraftPerspectiveId(res.perspective_id);
      setDraftGenerationConfigId(res.llm_generation_config_id);

      const seedPendingState = (leg: LegKey, text: string | undefined) => {
        if (!text) return;
        const pendingId = PENDING_STATE_ID[leg];
        setDrafts((prev) => ({ ...prev, [pendingId]: { stateId: pendingId, text, photos: [], dirty: true } }));
        const setter = leg === 'initial_states' ? setInitialStateIds : setFinalStateIds;
        setter((prev) => (prev.includes(pendingId) ? prev : [...prev, pendingId]));
      };

      if (draftAnchor.type === 'state') {
        // Anchor is already the final state; propose the action and the
        // initial state around it.
        setDraftAction({
          title: proposal.title || 'Untitled action',
          description: proposal.description || '',
          action_type: proposal.action_type || 'entropy_reduction',
          expected_state: proposal.expected_state,
        });
        seedPendingState('initial_states', proposal.initial_state_text);
      } else {
        // Anchor is already the real action; propose both boundary states.
        seedPendingState('initial_states', proposal.initial_state_text);
        seedPendingState('final_states', proposal.final_state_text);
      }

      setHasDrafted(true);
    } catch (err) {
      console.error('Failed to draft experience:', err);
      toast({ title: 'Error', description: 'Failed to draft this experience.', variant: 'destructive' });
    } finally {
      setIsDrafting(false);
    }
  };

  // --- Save ------------------------------------------------------------
  const handleSave = async () => {
    if (!entityId) {
      toast({ title: 'Missing container', description: 'This experience has no container.', variant: 'destructive' });
      return;
    }
    setIsSaving(true);
    try {
      const toPhotoPayload = (photos: PhotoItem[]) =>
        photos
          .filter((p) => p.photo_url)
          .map((p, idx) => ({
            photo_url: p.photo_url!,
            photo_description: p.photo_description,
            photo_order: idx,
            client_captured_at: p.client_captured_at,
            capture_method: p.capture_method,
          }));

      // 1. Create any pending state built from promoted photos, and swap its
      //    placeholder id for the real one in the lane.
      let nextInitialIds = [...initialStateIds];
      let nextFinalIds = [...finalStateIds];

      for (const leg of ['initial_states', 'final_states'] as LegKey[]) {
        const pendingId = PENDING_STATE_ID[leg];
        const draft = drafts[pendingId];
        const laneIds = leg === 'initial_states' ? nextInitialIds : nextFinalIds;
        // Only create it if it's actually still in its lane — a promoted
        // photo or drafted text that was then removed must not leave an
        // orphan state behind. Content can come from photos (promote-photo
        // flow) or text alone (AI-drafted state text, no photos).
        const hasContent = draft && (draft.photos.length > 0 || draft.text.trim().length > 0);
        if (!hasContent || !laneIds.includes(pendingId)) continue;

        const createdState = await stateService.createState({
          state_text: draft.text.trim() || undefined,
          photos: toPhotoPayload(draft.photos),
          links: [{ entity_type: entityType, entity_id: entityId }],
        });

        const replaceIn = (ids: string[]) => ids.map((id) => (id === pendingId ? createdState.id : id));
        if (leg === 'initial_states') nextInitialIds = replaceIn(nextInitialIds);
        else nextFinalIds = replaceIn(nextFinalIds);
      }

      // 2. Persist edits to each existing state's own row, so the components
      //    reference already-current content.
      for (const draft of Object.values(drafts)) {
        if (!draft.dirty || isPendingStateId(draft.stateId)) continue;
        await stateService.updateState(draft.stateId, {
          // Send the trimmed text as-is, even when empty — the backend
          // treats `undefined` as "leave state_text untouched", so
          // `|| undefined` here would silently turn "clear the text" into
          // a no-op the moment the field became empty.
          state_text: draft.text.trim(),
          photos: toPhotoPayload(draft.photos),
          ...(draft.capturedAtOverride ? { captured_at: draft.capturedAtOverride } : {}),
        });
      }

      // 2b. Persist metric corrections/removals — a value fixed or a
      //     measurement removed from a state's card above.
      const allMetrics = [...initialStateIds, ...finalStateIds]
        .flatMap((id) => componentByStateId.get(id)?.state?.metrics || []);
      for (const snapshotId of removedMetricIds) {
        await snapshotService.deleteSnapshot(snapshotId);
      }
      for (const [snapshotId, newValue] of Object.entries(metricValueEdits)) {
        if (removedMetricIds.has(snapshotId)) continue;
        const original = allMetrics.find((m) => m.snapshot_id === snapshotId)?.value;
        if (String(original ?? '') === newValue) continue;
        await snapshotService.updateSnapshot(snapshotId, { value: newValue });
      }

      // 3. Attach any new photos to their action as a fresh linked
      //    observation — same mechanism UnifiedActionDialog uses when an
      //    action gets its existing state.
      for (const [actionId, photos] of Object.entries(actionPhotoDrafts)) {
        if (photos.length === 0) continue;
        await stateService.createState({
          photos: toPhotoPayload(photos),
          links: [
            { entity_type: 'action', entity_id: actionId },
            { entity_type: entityType, entity_id: entityId },
          ],
        });
      }

      // 4. Persist any action renames and date corrections directly to the
      //    action's own row — corrective edits, not something worth
      //    delta-tracking like the CLAIM text.
      const touchedActionIdsForEdits = new Set([...Object.keys(titleEdits), ...Object.keys(actionDateEdits)]);
      for (const actionId of touchedActionIdsForEdits) {
        const originalTitle = componentByActionId.get(actionId)?.action?.title || actionsById.get(actionId)?.title || '';
        const trimmedTitle = titleEdits[actionId]?.trim();
        const titleChanged = trimmedTitle && trimmedTitle !== originalTitle;

        const originalCompletedAt = componentByActionId.get(actionId)?.action?.completed_at || actionsById.get(actionId)?.completed_at;
        const originalDateStr = originalCompletedAt ? format(new Date(originalCompletedAt), 'yyyy-MM-dd') : '';
        const editedDateStr = actionDateEdits[actionId];
        const dateChanged = editedDateStr !== undefined && editedDateStr !== originalDateStr;

        if (!titleChanged && !dateChanged) continue;
        await actionService.updateAction(actionId, {
          id: actionId,
          ...(titleChanged ? { title: trimmedTitle } : {}),
          ...(dateChanged
            ? { completed_at: editedDateStr ? new Date(`${editedDateStr}T00:00:00`).toISOString() : null }
            : {}),
        });
      }

      // 5. Materialize an AI-drafted action (observation-anchored "Draft
      //    Experience") for real — it's just a normal action creation,
      //    the same call a human-authored action goes through.
      let nextActionIds = actionIds;
      if (draftAction) {
        const created = await actionService.createAction({
          title: draftAction.title,
          description: draftAction.description,
          expected_state: draftAction.expected_state,
          scoring_data: { action_type: draftAction.action_type },
          status: 'completed',
          completed_at: new Date().toISOString(),
          asset_id: entityType === 'tool' ? entityId : undefined,
        });
        nextActionIds = [...actionIds, created.id];
      }

      // 5b. Materialize a person-authored new action (title + one
      //     observation, no AI) — same actionService.createAction call
      //     UnifiedActionDialog uses, then its own linked observation via
      //     the same state_links mechanism as step 3 above. A title-less
      //     draft is dropped rather than saved as noise.
      if (newActionDraft && newActionDraft.title.trim()) {
        const createdAction = await actionService.createAction({
          title: newActionDraft.title.trim(),
          status: 'completed',
          completed_at: new Date().toISOString(),
          asset_id: entityType === 'tool' ? entityId : undefined,
        });
        const hasObservationContent = newActionDraft.text.trim().length > 0 || newActionDraft.photos.length > 0;
        if (hasObservationContent) {
          await stateService.createState({
            state_text: newActionDraft.text.trim() || undefined,
            photos: toPhotoPayload(newActionDraft.photos),
            links: [
              { entity_type: 'action', entity_id: createdAction.id },
              { entity_type: entityType, entity_id: entityId },
            ],
          });
        }
        nextActionIds = [...nextActionIds, createdAction.id];
      }

      // 6. Persist membership.
      if (isNew) {
        await createExperience.mutateAsync({
          entity_type: entityType,
          entity_id: entityId,
          initial_state_ids: nextInitialIds,
          action_ids: nextActionIds,
          final_state_ids: nextFinalIds,
          action_photo_inclusions: photoInclusions,
          experience_perspective_id: draftPerspectiveId || undefined,
          llm_generation_config_id: draftGenerationConfigId || undefined,
        });
        toast({ title: 'Experience created', description: 'Saved successfully.' });
      } else {
        await updateExperience.mutateAsync({
          experienceId: experienceId!,
          updates: {
            initial_state_ids: nextInitialIds,
            action_ids: nextActionIds,
            final_state_ids: nextFinalIds,
            action_claim_edits: claimEdits,
            action_photo_inclusions: photoInclusions,
            experience_perspective_id: draftPerspectiveId || undefined,
            llm_generation_config_id: draftGenerationConfigId || undefined,
          },
        });
        toast({ title: 'Experience saved', description: 'Saved successfully.' });
      }

      // Back to the Experiences tab — the freshly saved/created experience
      // shows up there (Reviewed, if it now has both an initial and final
      // state) rather than leaving the person staring at the same form. The
      // component unmounts on navigate, so there's no need to reset local
      // draft/lane state here.
      navigate(`/combined-assets/${entityId}/details?tab=experiences`);
    } catch (err) {
      console.error('Failed to save experience:', err);
      const message = err instanceof Error && err.message ? err.message : 'Failed to save this experience.';
      toast({ title: 'Save failed', description: message, variant: 'destructive' });
    } finally {
      setIsSaving(false);
    }
  };

  // --- Rendering -------------------------------------------------------
  const renderStateCard = (leg: LegKey, stateId: string) => {
    const draft = drafts[stateId];
    const comp = componentByStateId.get(stateId);
    const fallback = statesById.get(stateId);
    // A photo's own EXIF/file date is a more meaningful anchor than the
    // state row's captured_at, which is just when the observation was
    // logged — prefer the earliest photo date when one was extracted, same
    // as the date-range logic on the Experiences tab. Falls back to the
    // state's own date only when there's no photo to anchor to at all.
    const photoDates = (draft?.photos || [])
      .map((p) => p.captured_at || p.client_captured_at)
      .filter(Boolean) as string[];
    // A manual correction always wins over the computed guess — that's the
    // whole point of letting someone fix a date that came out wrong.
    const hasOverride = draft?.capturedAtOverride !== undefined && draft.capturedAtOverride !== null;
    const capturedAt = hasOverride
      ? draft!.capturedAtOverride!
      : photoDates.sort()[0] || comp?.state?.captured_at || fallback?.captured_at;
    const metrics = comp?.state?.metrics || [];
    const isPending = isPendingStateId(stateId);

    return (
      <div
        key={stateId}
        className={`rounded-md border p-3 space-y-2 bg-background ${isPending ? 'border-primary/50 border-dashed' : ''}`}
      >
        <div className="flex items-start justify-between gap-2">
          {isPending ? (
            <p className="text-xs text-muted-foreground">New — from promoted photos, created on save</p>
          ) : (
            <Input
              type="date"
              value={capturedAt ? format(new Date(capturedAt), 'yyyy-MM-dd') : ''}
              onChange={(e) =>
                updateDraft(stateId, {
                  capturedAtOverride: e.target.value ? new Date(`${e.target.value}T00:00:00`).toISOString() : null,
                })
              }
              className="h-7 text-xs w-36"
              aria-label="State date"
            />
          )}
          <Button
            size="sm"
            variant="ghost"
            className="h-6 px-2"
            onClick={() => removeFromLane(leg, stateId)}
            aria-label="Remove from this experience"
          >
            <X className="h-3 w-3" />
          </Button>
        </div>

        {/* Measurements are first-class: for a measurement-shaped state these
            readings ARE the outcome, not just prose. Editable/removable
            here too — a metric read wrong at capture time, or one that
            doesn't belong on this state, shouldn't require leaving the
            experience to fix. */}
        {metrics.filter((m) => !removedMetricIds.has(m.snapshot_id)).length > 0 && (
          <div className="flex flex-wrap gap-1">
            {metrics
              .filter((m) => !removedMetricIds.has(m.snapshot_id))
              .map((m) => (
                <div key={m.snapshot_id} className="flex items-center gap-1 rounded-full bg-secondary pl-2 pr-1 py-0.5 text-xs">
                  <span>{m.name}:</span>
                  <input
                    type="text"
                    value={metricValueEdits[m.snapshot_id] ?? m.value}
                    onChange={(e) => setMetricValueEdits((prev) => ({ ...prev, [m.snapshot_id]: e.target.value }))}
                    className="w-12 bg-transparent border-b border-muted-foreground/30 text-xs focus:outline-none focus:border-foreground"
                    aria-label={`${m.name} value`}
                  />
                  {m.unit && <span>{m.unit}</span>}
                  <button
                    type="button"
                    onClick={() => setRemovedMetricIds((prev) => new Set(prev).add(m.snapshot_id))}
                    className="rounded-full hover:bg-muted-foreground/20 p-0.5"
                    aria-label={`Remove ${m.name}`}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              ))}
          </div>
        )}

        <Textarea
          placeholder="Describe this state…"
          value={draft?.text ?? ''}
          onChange={(e) => updateDraft(stateId, { text: e.target.value })}
          rows={3}
          className="text-sm"
        />

        <PhotoUploadPanel
          photos={draft?.photos ?? []}
          onPhotosChange={(photos) => updateDraft(stateId, { photos })}
          onEagerUpload={handleEagerUpload}
          showDescriptions
          showCapturedDate
        />

        <Button
          size="sm"
          variant="outline"
          className="w-full"
          onClick={() => setLinkPhotoTarget({ kind: 'state', id: stateId })}
        >
          <ImagePlus className="h-4 w-4 mr-2" />
          Link existing photo
        </Button>
      </div>
    );
  };

  /** AI-proposed action content (observation-anchored draft) — editable,
   *  not yet real. Materialized via actionService.createAction at Save. */
  const renderDraftActionCard = () => {
    if (!draftAction) return null;
    return (
      <div key={DRAFT_ACTION_ID} className="rounded-md border p-3 space-y-2 bg-background border-primary/50 border-dashed">
        <div className="flex items-start justify-between gap-2">
          <Input
            value={draftAction.title}
            onChange={(e) => setDraftAction((prev) => (prev ? { ...prev, title: e.target.value } : prev))}
            className="h-7 text-sm font-medium px-2"
            aria-label="Action title"
          />
          <Button
            size="sm"
            variant="ghost"
            className="h-6 px-2 shrink-0"
            onClick={() => setDraftAction(null)}
            aria-label="Remove this drafted action"
          >
            <X className="h-3 w-3" />
          </Button>
        </div>
        <Badge variant="outline" className="text-[10px]">
          {draftAction.action_type === 'transformative' ? 'Transformative' : 'Entropy reduction'}
        </Badge>
        <Textarea
          placeholder="What was done…"
          value={draftAction.description}
          onChange={(e) => setDraftAction((prev) => (prev ? { ...prev, description: e.target.value } : prev))}
          rows={3}
          className="text-sm"
        />
        <p className="text-[11px] text-muted-foreground">
          New — from the AI draft, created on save.
        </p>
      </div>
    );
  };

  /**
   * A person-authored new action — just a title and one observation (text
   * + photos), the same shape as a state card. No action_type, expected_state,
   * or AI claim yet; those can be added later without changing this. Doesn't
   * exist yet — materialized (action, then its linked observation) at Save.
   */
  const renderNewActionCard = () => {
    if (!newActionDraft) return null;
    return (
      <div key={NEW_ACTION_ID} className="rounded-md border p-3 space-y-2 bg-background border-primary/50 border-dashed">
        <div className="flex items-start justify-between gap-2">
          <Input
            value={newActionDraft.title}
            onChange={(e) => setNewActionDraft((prev) => (prev ? { ...prev, title: e.target.value } : prev))}
            placeholder="Action title"
            className="h-7 text-sm font-medium px-2"
            aria-label="Action title"
          />
          <Button
            size="sm"
            variant="ghost"
            className="h-6 px-2 shrink-0"
            onClick={() => setNewActionDraft(null)}
            aria-label="Remove this new action"
          >
            <X className="h-3 w-3" />
          </Button>
        </div>
        <Textarea
          placeholder="Describe this state…"
          value={newActionDraft.text}
          onChange={(e) => setNewActionDraft((prev) => (prev ? { ...prev, text: e.target.value } : prev))}
          rows={3}
          className="text-sm"
        />
        <PhotoUploadPanel
          photos={newActionDraft.photos}
          onPhotosChange={(photos) => setNewActionDraft((prev) => (prev ? { ...prev, photos } : prev))}
          onEagerUpload={handleEagerUpload}
          showDescriptions
          showCapturedDate
        />
        <Button
          size="sm"
          variant="outline"
          className="w-full"
          onClick={() => setLinkPhotoTarget({ kind: 'action', id: NEW_ACTION_ID })}
        >
          <ImagePlus className="h-4 w-4 mr-2" />
          Link existing photo
        </Button>
        <p className="text-[11px] text-muted-foreground">
          New — not saved yet.
        </p>
      </div>
    );
  };

  const renderActionCard = (actionId: string) => {
    if (actionId === DRAFT_ACTION_ID) return renderDraftActionCard();
    if (actionId === NEW_ACTION_ID) return renderNewActionCard();
    const comp = componentByActionId.get(actionId);
    const fallback = actionsById.get(actionId);
    const title = comp?.action?.title || fallback?.title || 'Untitled action';
    const actionType = comp?.action?.action_type;
    const completedAt = comp?.action?.completed_at || fallback?.completed_at;
    const originalClaim = comp?.action?.claim || '';

    // An action's linked observations often carry photos unrelated to what
    // this write-up is actually about, so nothing shows here by default —
    // a person explicitly picks which ones belong, same as the initial/final
    // state legs. The underlying state_link is untouched either way.
    const included = new Set(photoInclusions[actionId] || []);
    // No per-photo EXIF date is available for an already-linked observation
    // photo here (unlike a state's own photos) — the observation's own
    // captured_at is the closest date we have, so it's carried along.
    const allLinkedPhotos = (actionStatesById[actionId] || [])
      .flatMap((s) => (s.photos || []).map((p) => ({ ...p, captured_at: s.captured_at })));
    const linkedPhotos = allLinkedPhotos.filter((p) => included.has(p.photo_url));
    const candidatePhotos = allLinkedPhotos.filter((p) => !included.has(p.photo_url));
    const newPhotos = actionPhotoDrafts[actionId] || [];

    return (
      <div key={actionId} className="rounded-md border p-3 space-y-2 bg-background">
        <div className="flex items-start justify-between gap-2">
          <Input
            value={titleEdits[actionId] ?? title}
            onChange={(e) => setTitleEdits((prev) => ({ ...prev, [actionId]: e.target.value }))}
            className="h-7 text-sm font-medium px-2"
            aria-label="Action title"
          />
          <Button
            size="sm"
            variant="ghost"
            className="h-6 px-2 shrink-0"
            onClick={() => setActionIds((prev) => prev.filter((x) => x !== actionId))}
            aria-label="Remove from this experience"
          >
            <X className="h-3 w-3" />
          </Button>
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          {actionType && (
            <Badge variant="outline" className="text-[10px]">
              {actionType === 'transformative' ? 'Transformative' : 'Entropy reduction'}
            </Badge>
          )}
          <Input
            type="date"
            value={
              actionDateEdits[actionId] !== undefined
                ? actionDateEdits[actionId]
                : completedAt
                  ? format(new Date(completedAt), 'yyyy-MM-dd')
                  : ''
            }
            onChange={(e) => setActionDateEdits((prev) => ({ ...prev, [actionId]: e.target.value }))}
            className="h-7 text-xs w-36"
            aria-label="Action date"
          />
        </div>

        {/* Photos deliberately picked for this write-up from the action's
            linked observations. Removing one only un-picks it here — it
            stays linked to the action and reappears below as a candidate. */}
        {linkedPhotos.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {linkedPhotos.map((p, idx) => (
              <div key={`${p.id || p.photo_url}-${idx}`} className="flex flex-col items-center">
                {p.captured_at && (
                  <p className="text-[10px] text-muted-foreground truncate max-w-14">
                    {format(new Date(p.captured_at), 'MMM d')}
                  </p>
                )}
                <div className="relative">
                <img
                  src={getImageUrl(p.photo_url) || p.photo_url}
                  alt={p.photo_description || ''}
                  title={p.photo_description || undefined}
                  className="h-14 w-14 rounded object-cover border"
                  loading="lazy"
                />
                <button
                  type="button"
                  onClick={() => removeIncludedPhoto(actionId, p.photo_url)}
                  aria-label="Remove this photo from this experience"
                  title="Remove from this experience — stays on the action"
                  className="absolute -top-1.5 -right-1.5 rounded-full bg-background border shadow-sm h-5 w-5 flex items-center justify-center"
                >
                  <X className="h-3 w-3" />
                </button>
                </div>
              </div>
            ))}
          </div>
        )}
        {/* Other photos already on this action's linked observations, not
            yet part of this write-up — pick any that actually belong. */}
        {candidatePhotos.length > 0 && (
          <div className="space-y-1">
            <p className="text-[11px] text-muted-foreground">Other photos on this action — add any that belong here:</p>
            <div className="flex flex-wrap gap-1">
              {candidatePhotos.map((p, idx) => (
                <div key={`${p.id || p.photo_url}-${idx}`} className="flex flex-col items-center">
                  {p.captured_at && (
                    <p className="text-[10px] text-muted-foreground truncate max-w-14">
                      {format(new Date(p.captured_at), 'MMM d')}
                    </p>
                  )}
                  <div className="relative">
                  <img
                    src={getImageUrl(p.photo_url) || p.photo_url}
                    alt={p.photo_description || ''}
                    title={p.photo_description || undefined}
                    className="h-14 w-14 rounded object-cover border opacity-60"
                    loading="lazy"
                  />
                  <button
                    type="button"
                    onClick={() => includeLinkedPhoto(actionId, p.photo_url)}
                    aria-label="Add this photo to this experience"
                    title="Add to this experience"
                    className="absolute -top-1.5 -right-1.5 rounded-full bg-background border shadow-sm h-5 w-5 flex items-center justify-center"
                  >
                    <Plus className="h-3 w-3" />
                  </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
        <PhotoUploadPanel
          photos={newPhotos}
          onPhotosChange={(photos) => setActionPhotoDrafts((prev) => ({ ...prev, [actionId]: photos }))}
          onEagerUpload={handleEagerUpload}
          showDescriptions
          showCapturedDate
        />
        <Button
          size="sm"
          variant="outline"
          className="w-full"
          onClick={() => setLinkPhotoTarget({ kind: 'action', id: actionId })}
        >
          <ImagePlus className="h-4 w-4 mr-2" />
          Link existing photo
        </Button>

        {!isNew && (
          <>
            <Textarea
              placeholder="What was done…"
              value={claimEdits[actionId] ?? originalClaim}
              onChange={(e) => setClaimEdits((prev) => ({ ...prev, [actionId]: e.target.value }))}
              rows={3}
              className="text-sm"
            />
            <p className="text-[11px] text-muted-foreground">
              Saved on this experience — the action's own record is left unchanged.
            </p>
          </>
        )}
      </div>
    );
  };

  const renderLane = (
    title: string,
    hint: string,
    ids: string[],
    render: (id: string) => React.ReactNode,
    emptyLabel: string,
    trailing?: React.ReactNode
  ) => (
    <Card className="flex-1 min-w-0">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm">{title}</CardTitle>
        <p className="text-xs text-muted-foreground">{hint}</p>
      </CardHeader>
      <CardContent className="space-y-2">
        {ids.length === 0 ? (
          <p className="text-xs text-muted-foreground py-4 text-center border border-dashed rounded-md">
            {emptyLabel}
          </p>
        ) : (
          ids.map(render)
        )}
        {trailing}
      </CardContent>
    </Card>
  );

  if (!isNew && isLoading) {
    return (
      <div className="container mx-auto p-3 sm:p-6 max-w-6xl">
        <div className="flex items-center justify-center py-16 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin mr-2" /> Loading experience…
        </div>
      </div>
    );
  }

  const unusedStates = (candidateStates || []).filter((s) => !usedIds.has(s.id));
  const unusedActions = candidateActions.filter((a) => !usedIds.has(a.id));
  // One chronological list instead of two separate ones — states and
  // actions interleave in time, so picking what belongs in an experience is
  // easier when they're not split into disconnected lists to scroll through.
  const unusedItems: Array<
    | { kind: 'state'; date: string; data: (typeof unusedStates)[number] }
    | { kind: 'action'; date: string; data: (typeof unusedActions)[number] }
  > = [
    ...unusedStates.map((s) => ({ kind: 'state' as const, date: s.captured_at, data: s })),
    ...unusedActions.map((a) => ({ kind: 'action' as const, date: a.completed_at || a.created_at || '', data: a })),
  ].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

  return (
    <div className="container mx-auto p-3 sm:p-6 max-w-6xl">
      <div className="mb-4">
        <Button variant="ghost" size="sm" onClick={() => navigate(-1)} className="gap-2">
          <ArrowLeft className="h-4 w-4" />
          Back
        </Button>
      </div>

      <div className="mb-4">
        <h1 className="text-xl font-semibold">{isNew ? 'New experience' : 'Experience'}</h1>
        <p className="text-sm text-muted-foreground">
          What the situation was, what was done, and what resulted. A decline is as valuable a
          result as growth.
        </p>
      </div>

      {draftAnchor && !hasDrafted && (
        <Card className="mb-4 border-primary/50">
          <CardContent className="pt-4 space-y-3">
            <p className="text-sm text-muted-foreground">
              What do you want captured about this {draftAnchor.type === 'action' ? 'action' : 'observation'}?
            </p>
            <Textarea
              placeholder="A short note steering what to focus on…"
              value={draftNote}
              onChange={(e) => setDraftNote(e.target.value)}
              rows={2}
            />
            <Button onClick={handleDraftExperience} disabled={isDrafting}>
              {isDrafting ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Route className="h-4 w-4 mr-2" />}
              {isDrafting ? 'Drafting…' : 'Draft Experience'}
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Lanes stack on mobile — this app is used in the field. */}
      <div className="rounded-lg border-2 border-[#8b5a2b] bg-[#8b5a2b]/5 p-3">
        <div className="flex flex-col lg:flex-row gap-4">
          {renderLane(
            'Initial state',
            'The condition this started from',
            initialStateIds,
            (id) => renderStateCard('initial_states', id),
            'No starting state yet'
          )}
          {renderLane(
            'Action(s)',
            'What was done',
            [
              ...(draftAction ? [DRAFT_ACTION_ID] : []),
              ...(newActionDraft ? [NEW_ACTION_ID] : []),
              ...actionIds,
            ],
            renderActionCard,
            'No actions attached yet',
            !newActionDraft && (
              <Button
                size="sm"
                variant="outline"
                className="w-full"
                onClick={() => setNewActionDraft({ title: '', text: '', photos: [] })}
              >
                <Plus className="h-3 w-3 mr-1" />
                New action
              </Button>
            )
          )}
          {renderLane(
            'Final state',
            'What resulted — including measurements',
            finalStateIds,
            (id) => renderStateCard('final_states', id),
            'No outcome observed yet'
          )}
        </div>
      </div>

      <div className="flex justify-end gap-2 mt-4">
        <Button variant="outline" onClick={() => navigate(-1)} disabled={isSaving}>
          Cancel
        </Button>
        <Button onClick={handleSave} disabled={isSaving}>
          {isSaving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
          {isSaving ? 'Saving…' : isNew ? 'Submit' : 'Save changes'}
        </Button>
      </div>

      <Separator className="my-6" />

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">
            Add from {entityName || (entityType === 'part' ? 'this part' : 'this container')}
          </CardTitle>
          <p className="text-xs text-muted-foreground">
            Observations and confirmed actions from {entityName || (entityType === 'part' ? 'this part' : 'this container')}, not yet used in this experience.
          </p>
        </CardHeader>
        <CardContent>
          {unusedItems.length === 0 ? (
            <p className="text-xs text-muted-foreground">Nothing left to add.</p>
          ) : (
            <div className="space-y-1 max-h-96 overflow-y-auto">
              {unusedItems.map((item) =>
                item.kind === 'state' ? (
                  <div key={`state-${item.data.id}`} className="rounded border p-2 space-y-2">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5">
                          <Badge variant="outline" className="text-[10px] shrink-0">Observation</Badge>
                          <p className="text-xs text-muted-foreground truncate">
                            {format(new Date(item.date), 'MMM d, yyyy')}
                            {item.data.photos?.length ? ` · ${item.data.photos.length} photo${item.data.photos.length === 1 ? '' : 's'}` : ''}
                          </p>
                        </div>
                        <p className="text-sm truncate">
                          {item.data.observation_text || <span className="text-muted-foreground italic">No description</span>}
                        </p>
                      </div>
                      <div className="flex gap-1 shrink-0">
                        <Button size="sm" variant="outline" className="h-7 text-xs"
                          onClick={() => addToLane('initial_states', item.data.id)}>
                          <Plus className="h-3 w-3 mr-1" />Initial
                        </Button>
                        <Button size="sm" variant="outline" className="h-7 text-xs"
                          onClick={() => addToLane('final_states', item.data.id)}>
                          <Plus className="h-3 w-3 mr-1" />Final
                        </Button>
                      </div>
                    </div>

                    {/* Individual photos can be promoted on their own — often
                        one image out of a busy observation is the thing that
                        actually shows the starting condition. */}
                    {!!item.data.photos?.length && (
                      <div className="flex flex-wrap gap-2">
                        {item.data.photos.map((p) => (
                          <div key={p.id} className="w-24">
                            <img
                              src={getImageUrl(p.photo_url) || p.photo_url}
                              alt={p.photo_description || ''}
                              title={p.photo_description || undefined}
                              className="h-20 w-24 rounded object-cover border"
                              loading="lazy"
                            />
                            <div className="flex gap-1 mt-1">
                              <Button
                                size="sm"
                                variant="ghost"
                                className="h-6 px-1 text-[10px] flex-1"
                                onClick={() => promotePhoto('initial_states', p)}
                                title="Promote this photo into the initial state"
                              >
                                Initial
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                className="h-6 px-1 text-[10px] flex-1"
                                onClick={() => promotePhoto('final_states', p)}
                                title="Promote this photo into the final state"
                              >
                                Final
                              </Button>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ) : (
                  <div key={`action-${item.data.id}`} className="flex items-center justify-between gap-2 rounded border p-2">
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        <Badge variant="outline" className="text-[10px] shrink-0">Action</Badge>
                        {item.date && (
                          <p className="text-xs text-muted-foreground">
                            {format(new Date(item.date), 'MMM d, yyyy')}
                          </p>
                        )}
                      </div>
                      <p className="text-sm truncate">{item.data.title}</p>
                    </div>
                    <Button size="sm" variant="outline" className="h-7 text-xs shrink-0"
                      onClick={() => setActionIds((prev) => [...prev, item.data.id])}>
                      <Plus className="h-3 w-3 mr-1" />Add
                    </Button>
                  </div>
                )
              )}
            </div>
          )}
        </CardContent>
      </Card>

      <LinkExistingPhotoDialog
        open={!!linkPhotoTarget}
        onOpenChange={(o) => { if (!o) setLinkPhotoTarget(null); }}
        organizationId={orgId}
        entityType={entityType}
        entityId={entityId}
        existingPhotoUrls={
          !linkPhotoTarget
            ? []
            : linkPhotoTarget.kind === 'state'
              ? (drafts[linkPhotoTarget.id]?.photos || []).map((p) => p.photo_url!).filter(Boolean)
              : linkPhotoTarget.id === NEW_ACTION_ID
                ? (newActionDraft?.photos || []).map((p) => p.photo_url!).filter(Boolean)
                : [
                    ...(actionPhotoDrafts[linkPhotoTarget.id] || []).map((p) => p.photo_url!).filter(Boolean),
                    ...(actionStatesById[linkPhotoTarget.id] || []).flatMap((s) => (s.photos || []).map((p) => p.photo_url)),
                  ]
        }
        onConfirm={(linked) => {
          if (!linkPhotoTarget) return;
          if (linkPhotoTarget.kind === 'state') handleLinkedPhotos(linkPhotoTarget.id, linked);
          else handleLinkedActionPhotos(linkPhotoTarget.id, linked);
        }}
      />
    </div>
  );
}
