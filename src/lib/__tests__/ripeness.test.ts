import { describe, it, expect } from 'vitest';
import { batchRipeness, expectedRipeness } from '@/lib/ripeness';
import type { Observation } from '@/hooks/usePartHistory';

describe('expectedRipeness', () => {
  it('rises from stage 1 at harvest to stage 7 on the day spoilage is expected, and stays there', () => {
    const points = expectedRipeness(14, 28);
    expect(points[0]).toEqual({ day: 0, stage: 1 });
    expect(points[7].stage).toBeCloseTo(4, 6);
    expect(points[14].stage).toBeCloseTo(7, 6);
    expect(points[28].stage).toBe(7);
  });

  it('reaches stage 7 at the end of the model when spoilage is not expected within it', () => {
    const points = expectedRipeness(null, 28);
    expect(points[28].stage).toBeCloseTo(7, 6);
  });
});

describe('batchRipeness', () => {
  const batch = { code: 'SF112126LA01', toolId: 'tool-1', start: new Date('2026-11-21T00:00:00Z'), observations: 1 };
  const observation = (id: string, at: string, tool: string, value?: number | string, extra: Partial<Observation> = {}) => ({
    id, observation_text: null, observed_by: 'u', observed_by_name: 'S', observed_at: at,
    metrics: value === undefined ? [] : [{ snapshot_id: id, metric_name: 'Ripeness stage', value, unit: 'stage' }],
    links: [{ entity_type: 'tool', entity_id: tool }],
    ...extra,
  }) as Observation;

  it("gives the batch's readings in days since it began, earliest first", () => {
    const readings = batchRipeness([
      observation('b', '2026-11-28T12:00:00Z', 'tool-1', 5),
      observation('a', '2026-11-21T00:00:00Z', 'tool-1', '2'),
    ], batch);
    expect(readings).toEqual([{ day: 0, stage: 2 }, { day: 7.5, stage: 5 }]);
  });

  it("leaves out other batches' readings, observations without one, and shared observations", () => {
    expect(batchRipeness([
      observation('x', '2026-11-22T00:00:00Z', 'tool-2', 3),
      observation('y', '2026-11-22T00:00:00Z', 'tool-1'),
      observation('z', '2026-11-22T00:00:00Z', 'tool-1', 3, { share_info: { target_org_id: 'o', target_org_name: 'O' } }),
    ], batch)).toEqual([]);
  });
});
