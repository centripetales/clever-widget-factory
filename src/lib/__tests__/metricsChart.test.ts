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

describe('buildMetricChart experience connectors', () => {
  const series = [{ toolId: 't1', name: 'Rotary', color: '#f00' }];
  const temp = (id: string, at: string, value: string) => obs(id, at, [{ name: 'Temperature', value, unit: 'C' }]);
  const action = (id: string, at: string) => ({
    id, title: 'Add sawdust', description: null, status: 'completed', created_at: at, completed_at: at, claim: null, scoring_data: null,
  });

  it('pins every action to the top of the axis and flags those that belong to an experience', () => {
    const c = container([temp('a', '2026-09-01T00:00:00Z', '61'), temp('b', '2026-09-03T00:00:00Z', '57')]);
    c.actions = [action('x1', '2026-09-02T00:00:00Z'), action('x2', '2026-09-02T12:00:00Z')];
    c.experiences = [{ id: 'e1', initial_state_ids: ['a'], final_state_ids: ['b'], action_ids: ['x1'] }];
    const bundle = buildMetricChart([c], series, { name: 'Temperature', unit: 'C' });
    expect(bundle.actionMarkers.map((m) => [m.action.id, m.inExperience])).toEqual([['x1', true], ['x2', false]]);
    expect(bundle.actionMarkers.every((m) => m.y === bundle.leftAxis.domain[1])).toBe(true);
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

describe('buildMetricChart legend', () => {
  const two = [
    { toolId: 't1', name: 'Rotary Composter', color: '#f00' },
    { toolId: 't2', name: 'Chicken Coop', color: '#00f' },
  ];
  const oneSeries = [two[0]];
  const containerWith = (toolId: string, name: string, observations: GroupObservation[]): GroupContainer => ({
    ...container(observations), toolId, toolName: name,
  });
  const reading = (id: string, name: string, value: string) => obs(id, '2026-09-01T00:00:00Z', [{ name, value }]);

  it('shows a sensor row for a single container, colored by sensor, and no container row', () => {
    const c = container([obs('a', '2026-09-01T00:00:00Z', [
      { name: 'Ammonia: Smell', value: '4' },
    ])]);
    const { legend, chartSeries } = buildMetricChart([c], oneSeries, { name: 'Ammonia', unit: null });
    expect(legend.sensors.map((x) => x.label)).toEqual(['Smell']);
    expect(legend.containers).toEqual([]);
    expect(chartSeries[0].marker).toBe('circle');
  });

  it('has no legend at all for one container with no sensor', () => {
    const c = container([reading('a', 'Coverage %', '40')]);
    const { legend } = buildMetricChart([c], oneSeries, { name: 'Coverage %', unit: '%' });
    expect(legend).toEqual({ sensors: [], containers: [] });
  });

  it('gives every container its own marker shape and a colored chip when there is no sensor', () => {
    const a = containerWith('t1', 'Rotary Composter', [reading('a', 'Temp', '40')]);
    const b = containerWith('t2', 'Chicken Coop', [reading('b', 'Temp', '30')]);
    const { legend, chartSeries } = buildMetricChart([a, b], two, { name: 'Temp', unit: null });
    expect(legend.sensors).toEqual([]);
    expect(legend.containers.map((x) => [x.label, x.marker, x.color])).toEqual([
      ['Rotary Composter', 'circle', '#f00'],
      ['Chicken Coop', 'square', '#00f'],
    ]);
    expect(chartSeries.map((s) => s.marker)).toEqual(['circle', 'square']);
  });

  it('colors by sensor across containers and keeps the container chips neutral', () => {
    const a = containerWith('t1', 'Rotary Composter', [reading('a', 'Temp: Probe', '40')]);
    const b = containerWith('t2', 'Chicken Coop', [reading('b', 'Temp: Probe', '30'), reading('c', 'Temp: IR Gun', '31')]);
    const { legend, chartSeries } = buildMetricChart([a, b], two, { name: 'Temp', unit: null });
    expect(legend.sensors.map((x) => x.label)).toEqual(['IR Gun', 'Probe']);
    expect(legend.containers.every((x) => x.color === null)).toBe(true);
    const probeColors = new Set(chartSeries.filter((s) => s.sensor === 'Probe').map((s) => s.color));
    expect(probeColors.size).toBe(1);
    expect(chartSeries.find((s) => s.sensor === 'Probe' && s.toolId === 't1')!.label).toBe('Rotary Composter — Probe');
  });

  it('lets a chip toggle every line of its sensor or container', () => {
    const a = containerWith('t1', 'Rotary Composter', [reading('a', 'Temp: Probe', '40')]);
    const b = containerWith('t2', 'Chicken Coop', [reading('b', 'Temp: Probe', '30')]);
    const { legend } = buildMetricChart([a, b], two, { name: 'Temp', unit: null });
    expect(legend.sensors[0].seriesKeys).toEqual(['t1::Probe', 't2::Probe']);
    expect(legend.containers[0]).toMatchObject({ seriesKeys: ['t1::Probe'], toolIds: ['t1'] });
  });
});
