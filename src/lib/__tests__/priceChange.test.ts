import { describe, it, expect } from 'vitest';
import { chanceToSell, marketPriceOf, withNewPrice } from '@/lib/priceChange';
import type { ExpectationModel } from '@/lib/expectations';

const model = {
  kind: 'expectation',
  model_metadata: {
    name: 'Latundan price', version: '5', author: 'Stefan Hamilton',
    description: 'Everything is a percent of full price, and the price in pesos is that percent times the full price, set at ₱63.75 per kg (90% of the PSA Region VI retail price of ₱70.83). At full price, set at 90% of what buyers see as fair, about 6 in 10 kilos are expected to sell.',
  },
  anchor: '2026-11-21', time_step_days: 0.5, horizon_days: 28,
  inputs: {
    full_price: { label: 'Full price', unit: '₱/kg', value: 63.75, min: 20, max: 200, step: 0.5 },
    price_vs_fair: { label: 'Full price as a percent of fair', unit: '%', value: 90, min: 50, max: 120, step: 1 },
    sensitivity: { label: 'Buyer sensitivity', value: 0.25, min: 0.08, max: 0.6 },
  },
  variables: {},
  rationale: 'Because.',
  evidence: { summary: 'No sales yet.', observation_ids: [], experience_ids: [] },
} as unknown as ExpectationModel;

const change = { fullPrice: 25, marketPrice: 27.5, reason: "Mae says it sells for 25 to 30 pesos", author: 'Stefan Hamilton', now: new Date('2026-11-22T06:00:00Z') };

describe('marketPriceOf', () => {
  it('is the full price divided by its percent of what buyers see as fair', () => {
    expect(marketPriceOf(model)).toBe(70.83);
  });
});

describe('withNewPrice', () => {
  const next = withNewPrice(model, change);

  it('is one version on, by the person who changed it', () => {
    expect(next.model_metadata.version).toBe('6');
    expect(next.model_metadata.author).toBe('Stefan Hamilton');
  });

  it('sets the full price and its percent of the market price', () => {
    expect(next.inputs!.full_price.value).toBe(25);
    expect(next.inputs!.price_vs_fair.value).toBe(90.9);
    expect(marketPriceOf(next)).toBeCloseTo(27.5, 1);
  });

  it('widens the slider ranges to hold the new values, and never narrows them', () => {
    const low = withNewPrice(model, { ...change, fullPrice: 8, marketPrice: 6 });
    expect(low.inputs!.full_price.min).toBeLessThanOrEqual(4);
    expect(low.inputs!.price_vs_fair.max).toBeGreaterThanOrEqual(200);
    expect(next.inputs!.full_price.max).toBe(200);
  });

  it('keeps the words about the price true to the new numbers', () => {
    expect(next.model_metadata.description).toContain('set at ₱25.00 per kg (90.9% of a market price of ₱27.50)');
    expect(next.model_metadata.description).toContain('set at 90.9% of what buyers see as fair');
    expect(next.model_metadata.description).toContain(`about ${Math.round(chanceToSell(90.9, 0.25) * 10)} in 10 kilos`);
  });

  it('records the reason and who in the rationale and the evidence, keeping what was there', () => {
    expect(next.rationale).toContain('Because.');
    expect(next.rationale).toContain('Mae says it sells for 25 to 30 pesos');
    expect(next.evidence.summary).toContain('No sales yet.');
    expect(next.evidence.summary).toContain('on 2026-11-22');
  });

  it('leaves the original untouched', () => {
    expect(model.inputs!.full_price.value).toBe(63.75);
    expect(model.model_metadata.version).toBe('5');
  });

  it('needs prices above zero and a reason', () => {
    expect(() => withNewPrice(model, { ...change, fullPrice: 0 })).toThrow(/above 0/);
    expect(() => withNewPrice(model, { ...change, marketPrice: -1 })).toThrow(/above 0/);
    expect(() => withNewPrice(model, { ...change, reason: '  ' })).toThrow(/reason/);
  });

  it('refuses a model that has no full price', () => {
    expect(() => withNewPrice({ ...model, inputs: {} } as ExpectationModel, change)).toThrow(/no full price/);
  });
});

describe('chanceToSell', () => {
  it('is one half at the fair value and falls as the price rises', () => {
    expect(chanceToSell(100, 0.25)).toBeCloseTo(0.5, 6);
    expect(chanceToSell(120, 0.25)).toBeLessThan(chanceToSell(90, 0.25));
  });
});

describe('withNewPrice buyer sensitivity', () => {
  const change = { fullPrice: 25, marketPrice: 27.5, reason: 'r', author: 'S', now: new Date('2026-11-22T06:00:00Z') };

  it('sets the sensitivity, widens its range, and records it', () => {
    const next = withNewPrice(model, { ...change, sensitivity: 0.04 });
    expect(next.inputs!.sensitivity.value).toBe(0.04);
    expect(next.inputs!.sensitivity.min).toBe(0.04);
    expect(next.rationale).toContain('buyer sensitivity set to 0.04');
  });

  it('is left as it was when not given or unchanged', () => {
    expect(withNewPrice(model, change).inputs!.sensitivity).toEqual(model.inputs!.sensitivity);
    expect(withNewPrice(model, { ...change, sensitivity: 0.25 }).rationale).not.toContain('sensitivity set');
  });

  it('uses the new sensitivity for the chance to sell in the description', () => {
    const next = withNewPrice(model, { ...change, sensitivity: 0.1 });
    expect(next.model_metadata.description).toContain(`about ${Math.round(chanceToSell(90.9, 0.1) * 10)} in 10 kilos`);
  });

  it('needs a sensitivity above zero', () => {
    expect(() => withNewPrice(model, { ...change, sensitivity: 0 })).toThrow(/above 0/);
  });
});

describe('withNewPrice with only the sensitivity', () => {
  it('keeps both prices and their percent exactly, and says only the sensitivity changed', () => {
    const next = withNewPrice(model, { sensitivity: 0.1, reason: 'Fits sales better', author: 'S', now: new Date('2026-11-22T06:00:00Z') });
    expect(next.inputs!.full_price.value).toBe(63.75);
    expect(next.inputs!.price_vs_fair.value).toBe(90);
    expect(next.inputs!.sensitivity.value).toBe(0.1);
    expect(next.model_metadata.version).toBe('6');
    expect(next.rationale).toContain('Buyer sensitivity set to 0.1 by S');
    expect(next.rationale).not.toContain('Full price set');
    expect(next.model_metadata.description).toContain('set at ₱63.75 per kg (90% of the PSA');
  });
});

describe('reason', () => {
  it('is not needed to change only the sensitivity, and is left out of the record', () => {
    const next = withNewPrice(model, { sensitivity: 0.1, reason: '', author: 'S', now: new Date('2026-11-22T06:00:00Z') });
    expect(next.rationale).toContain('Buyer sensitivity set to 0.1 by S on 2026-11-22.');
  });
});
