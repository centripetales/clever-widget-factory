import { simulate, inputValues, dateOfStep, expectedOn, summarize, type ExpectationModel } from '@/lib/expectations';
import { isExpectation } from '@/lib/expectationModels';
import type { StateSpaceModelRecord } from '@/lib/stateSpaceApi';

// What the Market tab draws from an item's price model: how likely it is to sell at each price,
// and when the first spoilage is expected. Both come from the model's agreed values.

const MODEL_NEEDS = {
  variables: ['spotted', 'percent_of_full'],
  inputs: ['sensitivity', 'price_vs_fair'],
};

// The latest version of the item's price model: one with the spotting and demand parts.
export function latestMarketModel(records: StateSpaceModelRecord[]): ExpectationModel | null {
  const models = records
    .filter(isExpectation)
    .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())
    .map((record) => record.model_definition as unknown as ExpectationModel)
    .filter((d) => MODEL_NEEDS.variables.every((k) => k in d.variables) && MODEL_NEEDS.inputs.every((k) => d.inputs && k in d.inputs));
  return models.length > 0 ? models[models.length - 1] : null;
}

export interface DemandCurve {
  // Price as a percent of what buyers see as fair, and the chance a kilo sells at it (0-100).
  points: Array<{ price: number; chance: number }>;
  posted: { price: number; chance: number };
  // The price that earns the most for each kilo put up for sale: the largest box of price times
  // chance it sells. `earns` is that product, in percent of the fair value per kilo offered.
  best: { price: number; chance: number; earns: number };
}

// Buyers are indifferent at the fair value and respond smoothly to the price (a logistic of its
// log), as the model does for the chance it sells at the posted price.
export function demandCurve(model: ExpectationModel): DemandCurve {
  const { sensitivity, price_vs_fair } = inputValues(model);
  const chance = (price: number) => 100 / (1 + Math.exp(Math.log(price / 100) / sensitivity));
  const points: DemandCurve['points'] = [];
  for (let price = 40; price <= 160; price += 2) points.push({ price, chance: chance(price) });
  let best = { price: 40, chance: chance(40), earns: 0 };
  for (let price = 40; price <= 160; price += 0.5) {
    const earns = (price * chance(price)) / 100;
    if (earns > best.earns) best = { price, chance: chance(price), earns };
  }
  return { points, posted: { price: price_vs_fair, chance: chance(price_vs_fair) }, best };
}

export interface FirstSpot {
  // Days after the anchor: the middle of the bunches and the middle 80%. Null where it is
  // later than the model covers.
  median: number | null;
  p10: number | null;
  p90: number | null;
  medianDate: string | null;
  p10Date: string | null;
  p90Date: string | null;
  // The chance spoilage has begun by each day.
  byDay: Array<{ day: number; chance: number }>;
  notByTheEnd: number;
}

// When the first spoilage is expected, from the simulated runs: the day each run's `spotted` (spoilage has begun)
// first turns on.
export function firstSpot(model: ExpectationModel): FirstSpot {
  const run = simulate(model);
  const onsets: number[] = [];
  for (let r = 0; r < run.runs; r++) {
    let step = -1;
    for (let s = 0; s < run.steps; s++) {
      if (run.samples.spotted[s][r] === 1) { step = s; break; }
    }
    onsets.push(step);
  }
  const spotted = onsets.filter((s) => s >= 0).sort((a, b) => a - b);
  const at = (q: number): number | null => {
    const index = Math.floor(q * run.runs);
    return index < spotted.length ? spotted[index] : null;
  };
  const day = (step: number | null) => (step === null ? null : step * model.time_step_days);
  const date = (step: number | null) => (step === null ? null : dateOfStep(model, step));

  const byDay: FirstSpot['byDay'] = [];
  const every = Math.max(1, Math.round(1 / model.time_step_days));
  for (let s = 0; s < run.steps; s += every) {
    const values = run.samples.spotted[s];
    let sum = 0;
    for (let r = 0; r < values.length; r++) sum += values[r];
    byDay.push({ day: s * model.time_step_days, chance: (100 * sum) / values.length });
  }

  return {
    median: day(at(0.5)), p10: day(at(0.1)), p90: day(at(0.9)),
    medianDate: date(at(0.5)), p10Date: date(at(0.1)), p90Date: date(at(0.9)),
    byDay,
    notByTheEnd: (run.runs - spotted.length) / run.runs,
  };
}

export interface PriceNow {
  // The full price in pesos per kg (what a flawless kilo sells for), and the expected price on the
  // day: the middle of the bunches and the middle 80%. Null when the day is outside the model.
  full: number;
  today: { mean: number; p10: number; p90: number } | null;
}

// The price in pesos from the model's `price` variable and its `full_price` input.
export function priceNow(model: ExpectationModel, now: Date = new Date()): PriceNow | null {
  if (!('price' in model.variables) || !model.inputs || !('full_price' in model.inputs)) return null;
  const run = simulate(model);
  const found = expectedOn(model, run, 'price', now);
  const summary = found ? summarize(found.values) : null;
  return { full: inputValues(model).full_price, today: summary ? { mean: summary.mean, p10: summary.p10, p90: summary.p90 } : null };
}
