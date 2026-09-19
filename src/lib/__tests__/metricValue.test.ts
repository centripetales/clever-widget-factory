import { describe, it, expect } from 'vitest';
import { validateMetricValue, describeRange } from '../metricValue';

const number = (min: number | null = null, max: number | null = null) => ({
  name: 'Ammonia', value_type: 'number' as const, min_value: min, max_value: max,
});
const text = { name: 'Estrus Signs', value_type: 'text' as const, min_value: null, max_value: null };

describe('validateMetricValue', () => {
  it('accepts a blank, which just means no reading', () => {
    expect(validateMetricValue(number(0, 5), '')).toBeNull();
    expect(validateMetricValue(number(0, 5), '  ')).toBeNull();
    expect(validateMetricValue(text, '')).toBeNull();
  });

  it('accepts any text for a text metric, even something numeric', () => {
    expect(validateMetricValue(text, 'tail flicking, discharge')).toBeNull();
    expect(validateMetricValue(text, '12')).toBeNull();
  });

  it('rejects a non-number for a number metric', () => {
    expect(validateMetricValue(number(), 'Temperature')).toBe('Enter a number');
    expect(validateMetricValue(number(), '4 5')).toBe('Enter a number');
  });

  it('enforces the range, inclusive of both ends', () => {
    expect(validateMetricValue(number(0, 5), '0')).toBeNull();
    expect(validateMetricValue(number(0, 5), '5')).toBeNull();
    expect(validateMetricValue(number(0, 5), '-1')).toBe('Must be at least 0');
    expect(validateMetricValue(number(0, 5), '5.1')).toBe('Must be at most 5');
  });

  it('allows a one-sided range', () => {
    expect(validateMetricValue(number(0, null), '1000')).toBeNull();
    expect(validateMetricValue(number(null, 100), '-50')).toBeNull();
  });
});

describe('describeRange', () => {
  it('describes both, one-sided and no range', () => {
    expect(describeRange({ min_value: 0, max_value: 5 })).toBe('0–5');
    expect(describeRange({ min_value: 0, max_value: null })).toBe('≥ 0');
    expect(describeRange({ min_value: null, max_value: 100 })).toBe('≤ 100');
    expect(describeRange({ min_value: null, max_value: null })).toBeNull();
  });
});
