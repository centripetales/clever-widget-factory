import type { Observation } from '@/types/observations';
import { stateService } from '@/services/stateService';
import type { CreateExperienceRequest } from '@/types/experiences';

/**
 * The experience an action makes, open or closed, from its observations: its
 * existing state(s) → initial, the action, and its other observations
 * captured after the existing state → next states, in time order. Null when
 * the action has no existing state (an `existing_state` link to it).
 */
export function experienceFromAction(
  action: { id: string; asset_id?: string | null },
  observations: Observation[]
): CreateExperienceRequest | null {
  const isExistingState = (o: Observation) =>
    o.links?.some((l) => l.entity_type === 'existing_state' && l.entity_id === action.id);
  const existing = observations.filter(isExistingState);
  if (existing.length === 0) return null;

  const time = (o: Observation) => new Date(o.captured_at).getTime();
  const since = Math.min(...existing.map(time));
  const next = observations
    .filter((o) => !isExistingState(o) && time(o) >= since)
    .sort((a, b) => time(a) - time(b));

  return {
    // Tool assumed when the action has an asset, as in UnifiedActionDialog.
    ...(action.asset_id ? { entity_type: 'tool' as const, entity_id: action.asset_id } : {}),
    initial_state_ids: existing.map((o) => o.id),
    action_ids: [action.id],
    final_state_ids: next.map((o) => o.id),
  };
}

/** The same, fetching the action's observations first. */
export async function loadExperienceFromAction(
  action: { id: string; asset_id?: string | null }
): Promise<CreateExperienceRequest | null> {
  const observations = await stateService.getStates({ entity_type: 'action', entity_id: action.id });
  return experienceFromAction(action, observations);
}
