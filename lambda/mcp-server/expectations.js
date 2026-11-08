import { compile, parse } from 'mathjs';

// Expectation models (kind "expectation" in state_space_models): what a
// metric is expected to do over time, as random variables. The server only
// simulates them forward; choosing and fitting a model is Claude's job, and
// a person approves it. Validation lives in the state-space service.

const DAY_MS = 24 * 60 * 60 * 1000;
// Keeps a long daily horizon within a Lambda's time: fewer runs, never under 100.
const MAX_DRAWS = 400000;

// A seeded generator, so the same model always gives the same numbers.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function samplers(rand) {
  const normal = () => Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
  return {
    fixed: ({ value }) => value,
    normal: ({ mean, sd }) => mean + sd * normal(),
    lognormal: ({ mu, sigma }) => Math.exp(mu + sigma * normal()),
    poisson: ({ lambda }) => {
      if (lambda <= 0) return 0;
      if (lambda > 30) return Math.max(0, Math.round(lambda + Math.sqrt(lambda) * normal()));
      const limit = Math.exp(-lambda);
      let k = 0;
      for (let p = rand(); p > limit; p *= rand()) k++;
      return k;
    },
    binomial: ({ n, p }) => {
      let k = 0;
      for (let i = 0; i < Math.round(n); i++) if (rand() < p) k++;
      return k;
    },
    bernoulli: ({ p }) => (rand() < p ? 1 : 0),
  };
}

const namesIn = (expr) => {
  const names = [];
  parse(expr).traverse((node, path, parent) => {
    if (node.type === 'SymbolNode' && !(parent?.type === 'FunctionNode' && path === 'fn')) names.push(node.name);
  });
  return names;
};

// Each variable after the ones it uses in the same step (the service
// rejects loops on save).
function stepOrder(variables) {
  const keys = Object.keys(variables);
  const uses = Object.fromEntries(keys.map((k) => [k, Object.values(variables[k].params)
    .filter((p) => typeof p === 'string')
    .flatMap(namesIn)
    .filter((n) => keys.includes(n))]));
  const ordered = [];
  const visit = (k) => {
    if (ordered.includes(k)) return;
    uses[k].forEach(visit);
    ordered.push(k);
  };
  keys.forEach(visit);
  return ordered;
}

// Draws of every variable at every step: samples[key][step] is one array of
// `runs` values.
export function simulate(model, { seed = 1 } = {}) {
  const keys = Object.keys(model.variables);
  const steps = Math.floor(model.horizon_days / model.time_step_days) + 1;
  const runs = Math.max(100, Math.min(500, Math.floor(MAX_DRAWS / (steps * keys.length))));
  const draw = samplers(mulberry32(seed));
  const order = stepOrder(model.variables);
  const params = Object.fromEntries(keys.map((k) => [k, Object.entries(model.variables[k].params)
    .map(([name, p]) => [name, typeof p === 'number' ? () => p : ((c) => (scope) => c.evaluate(scope))(compile(p))])]));
  const samples = Object.fromEntries(keys.map((k) => [k, Array.from({ length: steps }, () => new Float64Array(runs))]));

  for (let r = 0; r < runs; r++) {
    const prev = Object.fromEntries(keys.map((k) => [`${k}_prev`, model.variables[k].initial]));
    for (let s = 0; s < steps; s++) {
      const scope = { t: s * model.time_step_days, ...prev };
      for (const k of order) {
        const v = model.variables[k];
        const args = Object.fromEntries(params[k].map(([name, f]) => [name, Number(f(scope))]));
        let x = draw[v.distribution](args);
        if (v.min !== undefined) x = Math.max(v.min, x);
        if (v.max !== undefined) x = Math.min(v.max, x);
        scope[k] = x;
        samples[k][s][r] = x;
      }
      for (const k of keys) prev[`${k}_prev`] = scope[k];
    }
  }
  return { steps, runs, samples };
}

const round = (x) => Math.round(x * 100) / 100;

// The mean and the middle 80% of the draws.
export function summarize(values) {
  const sorted = Float64Array.from(values).sort();
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  return {
    mean: round(sorted.reduce((a, b) => a + b, 0) / sorted.length),
    p10: round(at(0.1)),
    p50: round(at(0.5)),
    p90: round(at(0.9)),
  };
}

// How rarely the expectation would give a reading this far out, in either
// direction: 1 is right in the middle, near 0 is a surprise.
export function tailProbability(values, x) {
  let below = 0;
  let above = 0;
  for (const v of values) {
    if (v <= x) below++;
    if (v >= x) above++;
  }
  return round(Math.min(1, (2 * Math.min(below, above)) / values.length));
}

// The anchor date is a day on the farm (Asia/Manila).
const anchorTime = (model) => new Date(`${model.anchor}T00:00:00+08:00`).getTime();
const stepAt = (model, when) => Math.floor((new Date(when).getTime() - anchorTime(model)) / (model.time_step_days * DAY_MS));
export const dateOfStep = (model, step) =>
  new Date(anchorTime(model) + step * model.time_step_days * DAY_MS).toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' });

// The expected path of one variable, at about `points` evenly spaced steps.
export function expectedPath(model, run, key, points = 12) {
  const every = Math.max(1, Math.ceil((run.steps - 1) / (points - 1)));
  const steps = [];
  for (let s = 0; s < run.steps; s += every) steps.push(s);
  if (steps[steps.length - 1] !== run.steps - 1) steps.push(run.steps - 1);
  return steps.map((s) => ({ date: dateOfStep(model, s), ...summarize(run.samples[key][s]) }));
}

// The expectation for a variable on a date, or null outside the model's time.
export function expectedOn(model, run, key, when) {
  const step = stepAt(model, when);
  if (step < 0 || step >= run.steps) return null;
  return { step, values: run.samples[key][step] };
}

// Each reading against the version of the model in force when it was taken
// (versions oldest first, each { version, approved_at, definition, run }).
// Readings from before the first version are evidence, not a test of it.
export function compareReadings(versions, key, readings) {
  return readings.map((r) => {
    const value = Number(r.value);
    const base = { observation_id: r.observation_id, captured_at: r.captured_at, value: r.value };
    if (Number.isNaN(value)) return { ...base, note: 'not a number' };
    const inForce = versions.filter((v) => new Date(v.approved_at) <= new Date(r.captured_at)).pop();
    if (!inForce) return { ...base, note: 'before the first expectation: evidence, not a test of it' };
    const found = expectedOn(inForce.definition, inForce.run, key, r.captured_at);
    if (!found) return { ...base, version: inForce.version, note: 'outside the time the model covers' };
    const expected = summarize(found.values);
    return {
      ...base,
      version: inForce.version,
      expected,
      position: value < expected.p10 ? 'below the middle 80%' : value > expected.p90 ? 'above the middle 80%' : 'within the middle 80%',
      tail_probability: tailProbability(found.values, value),
    };
  });
}
