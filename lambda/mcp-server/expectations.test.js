import { test, describe } from 'node:test';
import assert from 'node:assert';
import { simulate, summarize, tailProbability, expectedPath, expectedOn, compareReadings } from './expectations.js';

const model = (variables, extra = {}) => ({
  kind: 'expectation', anchor: '2026-09-01', time_step_days: 1, horizon_days: 30, variables, ...extra,
});

const coverage = model({
  coverage: { name: 'Coverage', distribution: 'normal', params: { mean: '100 / (1 + exp(-(t - 15) / 3))', sd: 5 }, min: 0, max: 100 },
});

describe('simulate', () => {
  test('formulas use the agreed input values, or what-if values in their place', () => {
    const pond = model(
      { value: { name: 'Value/day', distribution: 'fixed', params: { value: 'area * 0.25' } } },
      { inputs: { area: { label: 'Area', unit: 'm²', value: 8, min: 8, max: 40000 } } },
    );
    assert.strictEqual(summarize(simulate(pond).samples.value[0]).mean, 2);
    assert.strictEqual(summarize(simulate(pond, { inputs: { area: 10000 } }).samples.value[0]).mean, 2500);
  });

  test('the same model gives the same numbers every time', () => {
    const a = simulate(coverage);
    const b = simulate(coverage);
    assert.deepStrictEqual(summarize(a.samples.coverage[10]), summarize(b.samples.coverage[10]));
  });

  test('follows the mean formula over time and keeps draws within min and max', () => {
    const run = simulate(coverage);
    assert.strictEqual(run.steps, 31);
    const early = summarize(run.samples.coverage[0]);
    const middle = summarize(run.samples.coverage[15]);
    assert.ok(early.mean < 5, `early mean ${early.mean}`);
    assert.ok(Math.abs(middle.mean - 50) < 2, `middle mean ${middle.mean}`);
    const all = run.samples.coverage.flatMap((s) => [...s]);
    assert.ok(Math.min(...all) >= 0 && Math.max(...all) <= 100);
  });

  test('a variable can use another in the same step, whatever order they are given in, and its own previous value', () => {
    const run = simulate(model({
      eggs: { name: 'Eggs/day', distribution: 'poisson', params: { lambda: 'flock * 0.5' } },
      flock: { name: 'Flock', distribution: 'binomial', params: { n: 'flock_prev', p: 0.99 }, initial: 40 },
    }));
    const flockStart = summarize(run.samples.flock[0]).mean;
    const flockEnd = summarize(run.samples.flock[30]).mean;
    assert.ok(flockStart > 38 && flockStart <= 40, `flock at start ${flockStart}`);
    assert.ok(flockEnd < flockStart - 5, `flock declines: ${flockStart} → ${flockEnd}`);
    const eggs = summarize(run.samples.eggs[30]).mean;
    assert.ok(Math.abs(eggs - flockEnd * 0.5) < 2, `eggs ${eggs} follow the flock ${flockEnd}`);
  });

  test('bernoulli draws are 0 or 1 at the given rate', () => {
    const run = simulate(model({ termite_free: { name: 'Termite-free', distribution: 'bernoulli', params: { p: 0.8 } } }));
    const values = [...run.samples.termite_free[5]];
    assert.ok(values.every((v) => v === 0 || v === 1));
    assert.ok(Math.abs(summarize(values).mean - 0.8) < 0.08);
  });
});

describe('tailProbability', () => {
  const values = Float64Array.from({ length: 101 }, (_, i) => i);
  test('is near 1 in the middle and near 0 at the edges', () => {
    assert.ok(tailProbability(values, 50) > 0.95);
    assert.ok(tailProbability(values, 0) < 0.05);
    assert.strictEqual(tailProbability(values, 500), 0);
  });
});

describe('expected path', () => {
  test('gives evenly spaced dates through the horizon, ending on its last day', () => {
    const run = simulate(coverage);
    const path = expectedPath(coverage, run, 'coverage', 4);
    assert.deepStrictEqual(path.map((p) => p.date), ['2026-09-01', '2026-09-11', '2026-09-21', '2026-10-01']);
  });

  test('a time of day on the farm falls on that day, and outside the horizon there is none', () => {
    const run = simulate(coverage);
    assert.strictEqual(expectedOn(coverage, run, 'coverage', '2026-09-03T15:00:00Z').step, 2); // 11 PM in Manila
    assert.strictEqual(expectedOn(coverage, run, 'coverage', '2026-09-03T17:00:00Z').step, 3); // 1 AM the next day
    assert.strictEqual(expectedOn(coverage, run, 'coverage', '2026-08-31T12:00:00Z'), null);
    assert.strictEqual(expectedOn(coverage, run, 'coverage', '2026-10-05T12:00:00Z'), null);
  });
});

describe('compareReadings', () => {
  const flat = (mean) => model({ coverage: { name: 'Coverage', distribution: 'normal', params: { mean, sd: 5 } } });
  const v1 = flat(20);
  const v2 = flat(60);
  const versions = [
    { version: '1', approved_at: '2026-09-05T00:00:00Z', definition: v1, run: simulate(v1) },
    { version: '2', approved_at: '2026-09-20T00:00:00Z', definition: v2, run: simulate(v2) },
  ];

  test('judges each reading by the version in force when it was taken', () => {
    const [before, first, second, odd] = compareReadings(versions, 'coverage', [
      { observation_id: 'o1', captured_at: '2026-09-02T00:00:00Z', value: '20' },
      { observation_id: 'o2', captured_at: '2026-09-10T00:00:00Z', value: '21' },
      { observation_id: 'o3', captured_at: '2026-09-25T00:00:00Z', value: '21' },
      { observation_id: 'o4', captured_at: '2026-09-26T00:00:00Z', value: 'cloudy' },
    ]);
    assert.match(before.note, /evidence, not a test/);
    assert.strictEqual(first.version, '1');
    assert.strictEqual(first.position, 'within the middle 80%');
    assert.ok(first.tail_probability > 0.5);
    assert.strictEqual(second.version, '2');
    assert.strictEqual(second.position, 'below the middle 80%');
    assert.strictEqual(second.tail_probability, 0);
    assert.strictEqual(odd.note, 'not a number');
  });

  test('a reading past the horizon is outside the model', () => {
    const [late] = compareReadings(versions, 'coverage', [{ observation_id: 'o5', captured_at: '2026-11-01T00:00:00Z', value: '50' }]);
    assert.strictEqual(late.version, '2');
    assert.match(late.note, /outside the time/);
  });
});
