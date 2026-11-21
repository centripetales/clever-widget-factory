import { describe, it, expect } from 'vitest';
import { demandCurve, firstSpot, latestMarketModel, priceNow } from '@/lib/marketCurves';
import type { StateSpaceModelRecord } from '@/lib/stateSpaceApi';
import type { ExpectationModel } from '@/lib/expectations';

const fixed = (value: string, extra: object = {}) => ({ name: value, distribution: 'fixed', params: { value }, ...extra });

// The shape of the Latundan price model: onset of brown spots at about 14 days, price in percent of full.
const definition = {
  kind: 'expectation',
  model_metadata: { name: 'Latundan price', version: '3', author: 'Stefan Hamilton', description: 'd' },
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
    spotted: fixed('age - age_now >= theta ? 1 : 0', { name: 'Spotted', min: 0, max: 1 }),
    days_spotted: fixed('spotted * (days_spotted_prev + 0.5)', { name: 'Days', initial: 0 }),
    severity: fixed('0.85 * (1 - exp(-days_spotted / spreadtime))', { name: 'Severity', min: 0, max: 1 }),
    percent_of_full: fixed('max(5, 100 - spotdrop * severity)', { name: 'Price', unit: '% of full price', min: 0, max: 100 }),
    price: fixed('full_price * percent_of_full / 100', { name: 'Price', unit: 'pesos per kg' }),
  },
  rationale: 'r', evidence: { summary: 's', observation_ids: [], experience_ids: [] },
} as unknown as ExpectationModel;

const record = (created_at: string, model_definition: unknown) => ({ id: created_at, name: 'Latundan price', created_at, model_definition }) as unknown as StateSpaceModelRecord;

describe('latestMarketModel', () => {
  it('takes the latest version that has the spotting and demand parts, and ignores older or other models', () => {
    const older = { ...definition, variables: { price: definition.variables.percent_of_full }, inputs: {} };
    const found = latestMarketModel([record('2026-11-22T00:00:00Z', definition), record('2026-11-21T00:00:00Z', older), record('2026-11-23T00:00:00Z', { model_metadata: {} })]);
    expect(found).toBe(definition);
  });

  it('is null when no model has them', () => {
    expect(latestMarketModel([record('2026-11-21T00:00:00Z', { ...definition, variables: {} })])).toBeNull();
    expect(latestMarketModel([])).toBeNull();
  });
});

describe('demandCurve', () => {
  it('is 50% at the fair value, falls as the price rises, and marks the posted price', () => {
    const { points, posted } = demandCurve(definition);
    expect(points.find((p) => p.price === 100)!.chance).toBeCloseTo(50, 5);
    const chances = points.map((p) => p.chance);
    expect([...chances].sort((a, b) => b - a)).toEqual(chances);
    expect(posted.price).toBe(90);
    expect(posted.chance).toBeCloseTo(60.4, 1);
  });

  it('moves with the buyers\' sensitivity', () => {
    const sharper = { ...definition, inputs: { ...definition.inputs!, sensitivity: { ...definition.inputs!.sensitivity, value: 0.1 } } };
    expect(demandCurve(sharper).posted.chance).toBeGreaterThan(demandCurve(definition).posted.chance);
  });
});

describe('firstSpot', () => {
  const spot = firstSpot(definition);

  it('puts the middle of the first spot near the median of 14 days, with a wider late side', () => {
    expect(spot.median!).toBeGreaterThan(12);
    expect(spot.median!).toBeLessThan(16);
    expect(spot.p10!).toBeLessThan(spot.median!);
    expect(spot.p90!).toBeGreaterThan(spot.median!);
    expect(spot.p90! - spot.median!).toBeGreaterThan(spot.median! - spot.p10!);
  });

  it('says the date as well, counted from the anchor', () => {
    expect(spot.medianDate).toMatch(/^2026-12-/);
  });

  it('gives the chance spots have appeared by each day, rising from nothing', () => {
    expect(spot.byDay[0]).toEqual({ day: 0, chance: 0 });
    const chances = spot.byDay.map((p) => p.chance);
    expect([...chances].sort((a, b) => a - b)).toEqual(chances);
    expect(chances[chances.length - 1]).toBeGreaterThan(90);
  });

  it('has later spots when the median onset is later', () => {
    const later = { ...definition, inputs: { ...definition.inputs!, median_onset: { ...definition.inputs!.median_onset, value: 20 } } };
    expect(firstSpot(later).median!).toBeGreaterThan(spot.median!);
  });
});

describe('priceNow', () => {
  it('is the full price on the harvest day and falls once spots are likely', () => {
    const harvest = priceNow(definition, new Date('2026-11-21T12:00:00+08:00'))!;
    expect(harvest.full).toBe(63.75);
    expect(harvest.today!.mean).toBeCloseTo(63.75, 2);
    const later = priceNow(definition, new Date('2026-12-09T12:00:00+08:00'))!;
    expect(later.today!.mean).toBeLessThan(45);
    expect(later.today!.p10).toBeLessThan(later.today!.mean);
  });

  it('has no price for a day outside the model, but still the full price', () => {
    const after = priceNow(definition, new Date('2027-03-01T12:00:00+08:00'))!;
    expect(after.today).toBeNull();
    expect(after.full).toBe(63.75);
  });

  it('is null for a model with no price in pesos', () => {
    const { price: _price, ...variables } = definition.variables;
    expect(priceNow({ ...definition, variables } as ExpectationModel)).toBeNull();
  });
});

describe('demandCurve best price', () => {
  it('is where price times the chance it sells is largest', () => {
    const curve = demandCurve(definition);
    const chance = (price: number) => 100 / (1 + Math.exp(Math.log(price / 100) / 0.25));
    for (const price of [40, 60, 80, 100, 120, 160]) {
      expect(curve.best.earns).toBeGreaterThanOrEqual((price * chance(price)) / 100 - 1e-9);
    }
    expect(curve.best.price).toBeGreaterThan(40);
    expect(curve.best.price).toBeLessThan(160);
  });
});
