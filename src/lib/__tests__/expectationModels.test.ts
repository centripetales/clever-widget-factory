import { describe, it, expect } from 'vitest';
import { buildToolExpectations } from '@/lib/expectationModels';
import type { StateSpaceModelRecord } from '@/lib/stateSpaceApi';
import type { ObservationHistoryEntry } from '@/hooks/tools/useToolHistory';

const record = (version: string, mean: number, created_at: string, observation_ids: string[] = []) => ({
  id: `m${version}`, organization_id: 'org-a', name: 'Azolla coverage', description: null, version, author: 'Stefan',
  is_public: false, created_by: null, created_at, updated_at: created_at,
  model_definition: {
    kind: 'expectation',
    model_metadata: { name: 'Azolla coverage', version, author: 'Stefan Hamilton', description: 'Covers the container' },
    anchor: '2026-09-01', time_step_days: 1, horizon_days: 30,
    variables: { coverage: { name: 'Coverage', unit: '%', distribution: 'normal', params: { mean, sd: 5 }, metric_id: 'metric-1' } },
    rationale: 'r', evidence: { summary: 's', observation_ids, experience_ids: [] },
  },
}) as unknown as StateSpaceModelRecord;

const observation = (id: string, observed_at: string, value: string, metric_id = 'metric-1') => ({
  id, type: 'observation', observed_by: 'u', observed_by_name: 'Lester', observed_at,
  metrics: [{ snapshot_id: `s-${id}`, metric_id, metric_name: 'Coverage %', value }],
}) as ObservationHistoryEntry;

describe('buildToolExpectations', () => {
  const nonlinear = { ...record('1', 0, '2026-09-01T00:00:00Z'), name: 'Drum', model_definition: { model_metadata: {} } } as unknown as StateSpaceModelRecord;

  it('shows only expectation models, latest version, with each reading judged by the version in force then', () => {
    const [e, ...rest] = buildToolExpectations(
      [record('2', 60, '2026-09-20T00:00:00Z', ['o1']), nonlinear, record('1', 20, '2026-09-05T00:00:00Z')],
      [
        observation('o1', '2026-09-02T00:00:00Z', '20'),
        observation('o2', '2026-09-10T00:00:00Z', '21'),
        observation('o3', '2026-09-25T00:00:00Z', '21'),
        observation('o4', '2026-09-25T00:00:00Z', '7', 'metric-other'),
      ],
      new Date('2026-09-25T04:00:00Z'),
    );
    expect(rest).toEqual([]);
    expect(e.version).toBe('2');
    expect(e.versionCount).toBe(2);
    expect(e.basis).toBe('farm');
    const [coverage] = e.variables;
    expect(coverage.readings.map((r) => [r.observation_id, r.version, r.position])).toEqual([
      ['o1', undefined, undefined],
      ['o2', '1', 'within the middle 80%'],
      ['o3', '2', 'below the middle 80%'],
    ]);
    expect(coverage.today?.mean).toBeGreaterThan(55);
    expect(coverage.path[0]).toMatchObject({ date: '2026-09-01', time: new Date('2026-09-01T00:00:00+08:00').getTime() });
  });

  it('has no today after the horizon, and no models gives nothing', () => {
    const [e] = buildToolExpectations([record('1', 20, '2026-09-05T00:00:00Z')], [], new Date('2026-12-01T00:00:00Z'));
    expect(e.basis).toBe('borrowed');
    expect(e.variables[0].today).toBeNull();
    expect(buildToolExpectations([], [])).toEqual([]);
  });
});
