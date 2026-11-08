'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert');
const { validateStateSpaceModel } = require('./validation');

const expectation = (variables) => ({
  kind: 'expectation',
  model_metadata: { name: 'Azolla coverage', version: '1', author: 'Stefan Hamilton', description: 'Covers the pond in about 3 weeks' },
  anchor: '2026-09-01',
  time_step_days: 1,
  horizon_days: 30,
  variables,
  rationale: 'Logistic growth',
  evidence: { summary: 'Borrowed from a study' },
});

describe('expectation models', () => {
  test('a model with formulas of t, other variables and previous values is accepted', () => {
    const result = validateStateSpaceModel(expectation({
      eggs: { name: 'Eggs/day', distribution: 'poisson', params: { lambda: 'flock * 0.7 * 1 / (1 + exp(-(t - 150) / 20))' } },
      flock: { name: 'Flock', distribution: 'binomial', params: { n: 'flock_prev', p: 0.99 }, initial: 25 },
    }));
    assert.strictEqual(result.success, true, JSON.stringify(result.errors));
    assert.deepStrictEqual(result.model.evidence, { summary: 'Borrowed from a study', observation_ids: [], experience_ids: [] });
  });

  test('wrong parameters, unknown names and missing initial values are reported', () => {
    const result = validateStateSpaceModel(expectation({
      a: { name: 'A', distribution: 'normal', params: { mean: 'rain * 2' } },
      b: { name: 'B', distribution: 'poisson', params: { lambda: 'b_prev + 1' } },
      c: { name: 'C', distribution: 'fixed', params: { value: 1 }, min: 5, max: 1 },
    }));
    assert.strictEqual(result.success, false);
    assert.deepStrictEqual(result.errors, [
      'variables.a: normal takes mean, sd',
      'variables.a.params.mean: undefined variable "rain"',
      'variables.b.params.lambda: b_prev needs an initial value on b',
      'variables.c: min is above max',
    ]);
  });

  test('formulas can use the model\'s inputs; bad inputs are reported', () => {
    const ok = validateStateSpaceModel({
      ...expectation({ value: { name: 'Value/day', distribution: 'fixed', params: { value: 'area * yield' } } }),
      inputs: {
        area: { label: 'Area', unit: 'm²', value: 8, min: 8, max: 40000 },
        yield: { label: 'Yield', value: 0.18, min: 0.05, max: 0.3, step: 0.01 },
      },
    });
    assert.strictEqual(ok.success, true, JSON.stringify(ok.errors));
    assert.strictEqual(ok.model.inputs.area.value, 8);

    const bad = validateStateSpaceModel({
      ...expectation({ value: { name: 'Value/day', distribution: 'fixed', params: { value: 'area' } } }),
      inputs: {
        area: { label: 'Area', value: 1, min: 8, max: 40000 },
        value: { label: 'Clash', value: 1, min: 0, max: 2 },
        t: { label: 'Time', value: 1, min: 2, max: 0 },
      },
    });
    assert.strictEqual(bad.success, false);
    assert.deepStrictEqual(bad.errors, [
      'inputs.area: value is outside min–max',
      'inputs.value: the name is taken (a variable, t, pi, e or a _prev name)',
      'inputs.t: the name is taken (a variable, t, pi, e or a _prev name)',
      'inputs.t: min is above max',
    ]);
  });

  test('variables using each other within a step are a loop', () => {
    const result = validateStateSpaceModel(expectation({
      a: { name: 'A', distribution: 'fixed', params: { value: 'b + 1' } },
      b: { name: 'B', distribution: 'fixed', params: { value: 'a + 1' } },
    }));
    assert.strictEqual(result.success, false);
    assert.match(result.errors[0], /loop within a step: a → b → a/);
  });

  test('the rest of the format is still checked: anchor, variables, rationale and evidence', () => {
    const { anchor, rationale, evidence, ...rest } = expectation({});
    const result = validateStateSpaceModel({ ...rest, anchor: 'Sept 1' });
    assert.strictEqual(result.success, false);
    assert.ok(result.errors.some((e) => e.startsWith('anchor:')));
    assert.ok(result.errors.some((e) => e.startsWith('variables:')));
    assert.ok(result.errors.some((e) => e.startsWith('rationale:')));
    assert.ok(result.errors.some((e) => e.startsWith('evidence:')));
  });
});

describe('existing models', () => {
  test('a model without kind is still validated as a nonlinear state-space model', () => {
    const result = validateStateSpaceModel({ model_metadata: { name: 'Drum', version: '1', author: 'a', description: 'd' } });
    assert.strictEqual(result.success, false);
    assert.ok(result.errors.some((e) => e.startsWith('constants:')));
  });
});
