import { describe, it, expect } from 'vitest';
import { experienceFromAction } from './experienceFromAction';
import type { Observation } from '@/types/observations';

const observation = (id: string, captured_at: string, existingStateOf?: string): Observation => ({
  id,
  captured_at,
  links: [
    { id: `${id}-a`, observation_id: id, entity_type: 'action', entity_id: 'a-1' },
    ...(existingStateOf ? [{ id: `${id}-e`, observation_id: id, entity_type: 'existing_state', entity_id: existingStateOf }] : []),
  ],
} as unknown as Observation);

describe('experienceFromAction', () => {
  it('puts the existing state first and the later observations as next states, in time order', () => {
    const request = experienceFromAction({ id: 'a-1', asset_id: 'tool-1' }, [
      observation('o-3', '2026-10-16T00:00:00Z'),
      observation('o-1', '2026-10-02T00:00:00Z', 'a-1'),
      observation('o-0', '2026-10-01T00:00:00Z'),
      observation('o-2', '2026-10-09T00:00:00Z'),
    ]);
    expect(request).toEqual({
      entity_type: 'tool',
      entity_id: 'tool-1',
      initial_state_ids: ['o-1'],
      action_ids: ['a-1'],
      final_state_ids: ['o-2', 'o-3'],
    });
  });

  it('is null without an existing state for this action', () => {
    expect(experienceFromAction({ id: 'a-1' }, [
      observation('o-1', '2026-10-02T00:00:00Z', 'other-action'),
      observation('o-2', '2026-10-09T00:00:00Z'),
    ])).toBeNull();
  });

  it('leaves out the asset when the action has none', () => {
    const request = experienceFromAction({ id: 'a-1', asset_id: null }, [observation('o-1', '2026-10-02T00:00:00Z', 'a-1')]);
    expect(request).toEqual({ initial_state_ids: ['o-1'], action_ids: ['a-1'], final_state_ids: [] });
  });
});
