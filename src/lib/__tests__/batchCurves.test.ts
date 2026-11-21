import { describe, it, expect } from 'vitest';
import { batchCurve, batchesFrom } from '@/lib/batchCurves';
import type { ExpectationModel } from '@/lib/expectations';
import type { Observation } from '@/hooks/usePartHistory';

const fixed = (value: string, extra: object = {}) => ({ name: value, distribution: 'fixed', params: { value }, ...extra });

const model = {
  kind: 'expectation',
  model_metadata: { name: 'Latundan price', version: '5', author: 'Stefan Hamilton', description: 'd' },
  anchor: '2026-11-21', time_step_days: 0.5, horizon_days: 28,
  inputs: {
    full_price: { label: 'Full price', value: 63.75, min: 20, max: 200 },
    price_vs_fair: { label: 'Full price vs fair', value: 90, min: 50, max: 120 },
    sensitivity: { label: 'Buyer sensitivity', value: 0.25, min: 0.08, max: 0.6 },
    spotdrop: { label: 'Drop', value: 90, min: 0, max: 100 },
    median_onset: { label: 'Median', value: 14, min: 1, max: 30 },
    age_now: { label: 'Age', value: 0, min: 0, max: 10 },
    onset_sd: { label: 'Onset spread', value: 0.2, min: 0, max: 0.6 },
    speed_sd: { label: 'Speed spread', value: 0.25, min: 0, max: 0.6 },
    spreadtime: { label: 'Spread time', value: 3, min: 1, max: 8 },
  },
  variables: {
    speed: { name: 'Speed', distribution: 'lognormal', initial: 1, params: { mu: 't == 0 ? 0 : log(speed_prev)', sigma: 't == 0 ? speed_sd : 0' } },
    theta: { name: 'Threshold', distribution: 'lognormal', initial: 1, params: { mu: 't == 0 ? log(median_onset) : log(theta_prev)', sigma: 't == 0 ? onset_sd : 0' } },
    age: { name: 'Age', distribution: 'fixed', initial: 0, params: { value: 't == 0 ? age_now : age_prev + speed * 0.5' } },
    spotted: fixed('age - age_now >= theta ? 1 : 0', { name: 'Spoiled', min: 0, max: 1 }),
    days_spotted: fixed('spotted * (days_spotted_prev + 0.5)', { name: 'Days', initial: 0 }),
    severity: fixed('0.85 * (1 - exp(-days_spotted / spreadtime))', { name: 'Severity', min: 0, max: 1 }),
    percent_of_full: fixed('max(5, 100 - spotdrop * severity)', { name: 'Price', unit: '% of full price', min: 0, max: 100 }),
    price: fixed('full_price * percent_of_full / 100', { name: 'Price', unit: 'pesos per kg' }),
  },
  rationale: 'r', evidence: { summary: 's', observation_ids: [], experience_ids: [] },
} as unknown as ExpectationModel;

const observation = (id: string, observed_at: string, toolIds: string[], extra: Partial<Observation> = {}) => ({
  id, observation_text: null, observed_by: 'u', observed_by_name: 'Stefan', observed_at,
  metrics: [{ snapshot_id: `i-${id}`, metric_name: 'Inventory', value: 15, unit: 'kg' }],
  links: [{ entity_type: 'part', entity_id: 'part-1' }, ...toolIds.map((entity_id) => ({ entity_type: 'tool', entity_id }))],
  ...extra,
}) as Observation;

const tools = [
  { id: 'tool-1', serial_number: 'SF112126LA01' },
  { id: 'tool-2', serial_number: 'SF112326LA01' },
  { id: 'tool-3', serial_number: '  ' },
];

describe('batchesFrom', () => {
  it('finds the tools its observations link to, each starting at its first observation', () => {
    const batches = batchesFrom([
      observation('3', '2026-11-25T08:00:00Z', ['tool-1']),
      observation('1', '2026-11-21T06:00:00Z', ['tool-1']),
      observation('2', '2026-11-23T06:00:00Z', ['tool-2']),
      observation('4', '2026-11-22T06:00:00Z', []),
    ], tools);
    expect(batches.map((b) => b.code)).toEqual(['SF112126LA01', 'SF112326LA01']);
    expect(batches[0].start.toISOString()).toBe('2026-11-21T06:00:00.000Z');
    expect(batches[0].observations).toBe(2);
  });

  it('leaves out a tool that is no longer in use, one without a serial number, and shared observations', () => {
    const shared = observation('s', '2026-11-21T06:00:00Z', ['tool-1'], { share_info: { target_org_id: 'o', target_org_name: 'Other' } });
    expect(batchesFrom([shared, observation('r', '2026-11-21T06:00:00Z', ['tool-gone', 'tool-3'])], tools)).toEqual([]);
    // removed from the tools in use: the batch is gone
    expect(batchesFrom([observation('1', '2026-11-21T06:00:00Z', ['tool-1'])], tools.filter((t) => t.id !== 'tool-1'))).toEqual([]);
  });
});

describe('batchCurve', () => {
  const batch = { code: 'SF112126LA01', toolId: 'tool-1', start: new Date('2026-11-21T06:00:00Z'), observations: 1 };

  it('starts the price model on the day the batch began: full price then a fall', () => {
    const curve = batchCurve(model, batch, new Date('2026-11-21T12:00:00+08:00'));
    expect(curve.path[0].mean).toBeCloseTo(100, 1);
    expect(curve.path[curve.path.length - 1].mean).toBeLessThan(35);
    expect(curve.priceToday!.today!.mean).toBeCloseTo(63.75, 2);
    expect(curve.ageDays).toBe(0);
  });

  it('puts a later batch\'s curve later on the calendar, and its first spoilage later', () => {
    const later = batchCurve(model, { code: 'SF120526LA01', toolId: 'tool-9', start: new Date('2026-12-05T06:00:00Z'), observations: 1 }, new Date('2026-12-05T12:00:00+08:00'));
    const first = batchCurve(model, batch, new Date('2026-12-05T12:00:00+08:00'));
    expect(later.path[0].time).toBeGreaterThan(first.path[0].time);
    expect(later.spoilage.medianDate! > first.spoilage.medianDate!).toBe(true);
    expect(first.ageDays).toBe(14);
    expect(first.priceToday!.today!.mean).toBeLessThan(later.priceToday!.today!.mean);
  });
});
