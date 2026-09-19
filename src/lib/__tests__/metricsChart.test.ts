import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  manilaDayKey,
  parseMetricName,
  mergeObservations,
  observationDisplayTime,
  rangeStartMs,
  buildMetricChart,
  collectContainerPoints,
  CHART_START_MS,
  type GroupContainer,
  type GroupObservation,
} from '../metricsChart';

const obs = (id: string, observed_at: string, metrics: { name: string; value: string; unit?: string }[]): GroupObservation => ({
  id,
  observation_text: null,
  observed_by: 'u1',
  observed_by_name: 'U',
  observed_at,
  photos: null,
  metrics: metrics.map((m) => ({ metric_id: `m-${m.name}`, metric_name: m.name, value: m.value, unit: m.unit ?? null })),
});

const container = (observations: GroupObservation[]): GroupContainer => ({
  toolId: 't1',
  toolName: "Rotary",
  sourceOrgId: 'o1',
  sourceOrgName: 'Org',
  sourcePhone: null,
  observations,
  actions: [],
  experiences: [],
});

describe('manilaDayKey', () => {
  it('buckets by Manila calendar day, not UTC', () => {
    // 2026-07-21 03:00 Manila == 2026-07-20 19:00 UTC: same Manila day as 23:00 Manila.
    const early = manilaDayKey('2026-07-20T19:00:00Z');
    const late = manilaDayKey('2026-07-21T15:00:00Z');
    expect(early).toBe(late);
    expect(early).toBe(new Date('2026-07-20T16:00:00Z').getTime());
  });

  it('starts a new day at midnight Manila', () => {
    expect(manilaDayKey('2026-07-21T16:00:00Z')).toBeGreaterThan(manilaDayKey('2026-07-21T15:59:00Z'));
  });
});

describe('parseMetricName', () => {
  it('splits family and subtype on the first colon', () => {
    expect(parseMetricName('Moisture: Squeeze Test')).toEqual({ family: 'Moisture', subtype: 'Squeeze Test' });
  });
  it('returns null subtype without a colon', () => {
    expect(parseMetricName('Temperature')).toEqual({ family: 'Temperature', subtype: null });
  });
  it('treats an empty subtype as null', () => {
    expect(parseMetricName('Moisture:  ')).toEqual({ family: 'Moisture', subtype: null });
  });
});

describe('mergeObservations', () => {
  it('takes the max per metric, keeps the unit, and orders by time', () => {
    const merged = mergeObservations([
      obs('b', '2026-07-22T06:00:00Z', [{ name: 'Coverage %', value: '40', unit: '%' }]),
      obs('a', '2026-07-22T01:00:00Z', [{ name: 'Coverage %', value: '55', unit: '%' }]),
    ]);
    expect(merged.metrics).toHaveLength(1);
    expect(merged.metrics![0].value).toBe('55.00');
    expect(merged.metrics![0].unit).toBe('%');
    expect(merged.id).toBe('a');
    expect(merged.mergedIds).toEqual(['a', 'b']);
    expect(merged.observed_at).toBe('2026-07-22T06:00:00Z');
  });
});

describe('rangeStartMs', () => {
  afterEach(() => vi.useRealTimers());

  it('is null for all time and now-minus-window otherwise', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-19T00:00:00Z'));
    const day = 24 * 60 * 60 * 1000;
    expect(rangeStartMs('all')).toBeNull();
    expect(rangeStartMs('week')).toBe(Date.now() - 7 * day);
    expect(rangeStartMs('month')).toBe(Date.now() - 30 * day);
    expect(rangeStartMs('3months')).toBe(Date.now() - 90 * day);
  });
});

describe('collectContainerPoints', () => {
  it('keeps every reading at its own timestamp for non-Coverage metrics', () => {
    const c = container([
      obs('1', '2026-09-01T00:00:00Z', [{ name: 'Temperature', value: '40' }]),
      obs('2', '2026-09-01T08:00:00Z', [{ name: 'Temperature', value: '55' }]),
    ]);
    const points = collectContainerPoints(c, 'Temperature', false);
    expect(points.map((p) => p.value)).toEqual([40, 55]);
    expect(points[0].timestamp).not.toBe(points[1].timestamp);
  });

  it('collapses same-day Coverage % to one point and applies the cutoff only there', () => {
    const c = container([
      obs('before', '2026-07-20T00:00:00Z', [{ name: 'Coverage %', value: '10' }]),
      obs('a', '2026-07-22T01:00:00Z', [{ name: 'Coverage %', value: '30' }]),
      obs('b', '2026-07-22T05:00:00Z', [{ name: 'Coverage %', value: '50' }]),
    ]);
    const points = collectContainerPoints(c, 'Coverage %', true);
    expect(points).toHaveLength(1);
    expect(points[0].value).toBe(50);
    expect(points[0].timestamp).toBeGreaterThanOrEqual(CHART_START_MS);

    const early = container([obs('before', '2026-07-20T00:00:00Z', [{ name: 'Temperature', value: '61' }])]);
    expect(collectContainerPoints(early, 'Temperature', false)).toHaveLength(1);
  });

  it('skips non-numeric values', () => {
    const c = container([obs('1', '2026-09-01T00:00:00Z', [{ name: 'Moisture', value: 'Temperature' }])]);
    expect(collectContainerPoints(c, 'Moisture', false)).toEqual([]);
  });
});

describe('buildMetricChart', () => {
  it('builds one row per timestamp with an axis domain padded around the data', () => {
    const c = container([
      obs('1', '2026-09-01T00:00:00Z', [{ name: 'Temperature', value: '40', unit: 'C' }]),
      obs('2', '2026-09-03T00:00:00Z', [{ name: 'Temperature', value: '60', unit: 'C' }]),
    ]);
    const bundle = buildMetricChart([c], [{ toolId: 't1', name: 'Rotary', color: '#fff' }], { name: 'Temperature', unit: 'C' });
    expect(bundle.chartSeries).toHaveLength(1);
    expect(bundle.leftAxis.domain[0]).toBeLessThan(40);
    expect(bundle.leftAxis.domain[1]).toBeGreaterThan(60);
    expect(bundle.rightAxis).toBeNull();
    // real rows plus a filler row for the day between them
    expect(bundle.chartData.length).toBe(3);
  });

  it('uses a right axis when subtypes have different units', () => {
    const c = container([
      obs('1', '2026-09-01T00:00:00Z', [
        { name: 'Moisture: Squeeze Test', value: '3', unit: 'drips' },
        { name: 'Moisture: IR Meter', value: '60', unit: '%' },
      ]),
    ]);
    const bundle = buildMetricChart([c], [{ toolId: 't1', name: 'Rotary', color: '#fff' }], { name: 'Moisture', unit: null });
    expect(bundle.chartSeries.map((s) => s.yAxisId).sort()).toEqual(['left', 'right']);
    expect(bundle.rightAxis).not.toBeNull();
    expect(bundle.titlePrefix).toBe('Rotary');
  });
});

describe('buildMetricChart experience bands', () => {
  const series = [{ toolId: 't1', name: 'Rotary', color: '#f00' }];
  const temp = (id: string, at: string, value: string) => obs(id, at, [{ name: 'Temperature', value, unit: 'C' }]);
  const action = (id: string, at: string) => ({
    id, title: 'Add sawdust', description: null, status: 'completed', created_at: at, completed_at: at, claim: null, scoring_data: null,
  });

  it('draws a band from the initial state to the final state and covers the readings inside it', () => {
    const c = container([
      temp('a', '2026-09-01T00:00:00Z', '61'),
      temp('b', '2026-09-03T00:00:00Z', '57'),
      temp('c', '2026-09-08T00:00:00Z', '50'),
    ]);
    c.experiences = [{ id: 'e1', initial_state_ids: ['a'], final_state_ids: ['b'], action_ids: [] }];
    const bundle = buildMetricChart([c], series, { name: 'Temperature', unit: 'C' });

    expect(bundle.experienceBands).toHaveLength(1);
    const band = bundle.experienceBands[0];
    expect(band.start).toBe(new Date('2026-09-01T00:00:00Z').getTime());
    expect(band.end).toBe(new Date('2026-09-03T00:00:00Z').getTime());
    expect(band.open).toBe(false);
    expect(bundle.coveredLines).toEqual([{ key: 't1__cov__e1', seriesKey: 't1' }]);
    const covered = bundle.chartData.filter((r) => r['t1__cov__e1'] !== undefined);
    expect(covered.map((r) => r['t1__cov__e1'])).toEqual([61, 57]);
  });

  it('runs an experience with no final state to the newest reading and marks it open', () => {
    const c = container([temp('a', '2026-09-01T00:00:00Z', '61'), temp('b', '2026-09-05T00:00:00Z', '58')]);
    c.experiences = [{ id: 'e1', initial_state_ids: ['a'], final_state_ids: [], action_ids: [] }];
    const [band] = buildMetricChart([c], series, { name: 'Temperature', unit: 'C' }).experienceBands;
    expect(band.open).toBe(true);
    expect(band.end).toBe(new Date('2026-09-05T00:00:00Z').getTime());
  });

  it('skips an experience whose end states have no reading of this metric', () => {
    const c = container([
      obs('a', '2026-09-01T00:00:00Z', [{ name: 'Moisture', value: '3' }]),
      temp('t', '2026-09-02T00:00:00Z', '60'),
    ]);
    c.experiences = [{ id: 'e1', initial_state_ids: ['a'], final_state_ids: [], action_ids: [] }];
    expect(buildMetricChart([c], series, { name: 'Temperature', unit: 'C' }).experienceBands).toEqual([]);
  });

  it('pins every action to the top of the axis and flags those that belong to an experience', () => {
    const c = container([temp('a', '2026-09-01T00:00:00Z', '61'), temp('b', '2026-09-03T00:00:00Z', '57')]);
    c.actions = [action('x1', '2026-09-02T00:00:00Z'), action('x2', '2026-09-02T12:00:00Z')];
    c.experiences = [{ id: 'e1', initial_state_ids: ['a'], final_state_ids: ['b'], action_ids: ['x1'] }];
    const bundle = buildMetricChart([c], series, { name: 'Temperature', unit: 'C' });
    expect(bundle.actionMarkers.map((m) => [m.action.id, m.inExperience])).toEqual([['x1', true], ['x2', false]]);
    expect(bundle.actionMarkers.every((m) => m.y === bundle.leftAxis.domain[1])).toBe(true);
  });
});

describe('observationDisplayTime', () => {
  const withPhotos = (captured: (string | null)[]): GroupObservation => ({
    ...obs('o', '2026-09-16T13:03:00Z', []),
    photos: captured.map((c, i) => ({ id: `p${i}`, photo_url: `u${i}`, photo_description: null, captured_at: c })),
  });

  it('uses the newest photo time, not the submission time', () => {
    expect(observationDisplayTime(withPhotos(['2026-09-16T06:25:00Z', '2026-09-16T06:40:00Z']))).toBe('2026-09-16T06:40:00Z');
  });
  it('falls back to the submission time when no photo is dated', () => {
    expect(observationDisplayTime(withPhotos([null]))).toBe('2026-09-16T13:03:00Z');
    expect(observationDisplayTime(obs('o', '2026-09-16T13:03:00Z', []))).toBe('2026-09-16T13:03:00Z');
  });

});

describe('buildMetricChart experience connectors', () => {
  const series = [{ toolId: 't1', name: 'Rotary', color: '#f00' }];
  const temp = (id: string, at: string, value: string) => obs(id, at, [{ name: 'Temperature', value, unit: 'C' }]);
  const action = (id: string, at: string) => ({
    id, title: 'Add sawdust', description: null, status: 'completed', created_at: at, completed_at: at, claim: null, scoring_data: null,
  });

  it('connects an action marker to its experience\'s initial and final readings, and only those', () => {
    const c = container([
      temp('a', '2026-09-01T00:00:00Z', '61'),
      temp('b', '2026-09-03T00:00:00Z', '57'),
      temp('other', '2026-09-05T00:00:00Z', '50'),
    ]);
    c.actions = [action('x1', '2026-09-02T00:00:00Z')];
    c.experiences = [{ id: 'e1', initial_state_ids: ['a'], final_state_ids: ['b'], action_ids: ['x1'] }];
    const bundle = buildMetricChart([c], series, { name: 'Temperature', unit: 'C' });
    const marker = bundle.actionMarkers[0];
    expect(bundle.experienceLinks.map((l) => [l.to.x, l.to.y])).toEqual([
      [new Date('2026-09-01T00:00:00Z').getTime(), 61],
      [new Date('2026-09-03T00:00:00Z').getTime(), 57],
    ]);
    expect(bundle.experienceLinks.every((l) => l.from.x === marker.timestamp && l.from.y === marker.y)).toBe(true);
  });

  it('attaches a state with no reading of the metric to the nearest reading in time', () => {
    const c = container([
      temp('a', '2026-09-01T00:00:00Z', '61'),
      temp('last', '2026-09-03T09:00:00Z', '57'),
      obs('final', '2026-09-03T12:00:00Z', [{ name: 'Moisture', value: '2' }]),
    ]);
    c.actions = [action('x1', '2026-09-02T00:00:00Z')];
    c.experiences = [{ id: 'e1', initial_state_ids: ['a'], final_state_ids: ['final'], action_ids: ['x1'] }];
    const links = buildMetricChart([c], series, { name: 'Temperature', unit: 'C' }).experienceLinks;
    expect(links.map((l) => l.to.y)).toEqual([61, 57]);
  });

  it('draws no connectors for an action that is not in an experience', () => {
    const c = container([temp('a', '2026-09-01T00:00:00Z', '61'), temp('b', '2026-09-03T00:00:00Z', '57')]);
    c.actions = [action('x2', '2026-09-02T00:00:00Z')];
    expect(buildMetricChart([c], series, { name: 'Temperature', unit: 'C' }).experienceLinks).toEqual([]);
  });
});
