// Types for expectations.js, which the app imports too (src/lib/expectations.ts).

export type Distribution = 'fixed' | 'normal' | 'lognormal' | 'poisson' | 'binomial' | 'bernoulli';

export interface ExpectationVariable {
  name: string;
  unit?: string;
  distribution: Distribution;
  params: Record<string, number | string>;
  initial?: number;
  min?: number;
  max?: number;
  metric_id?: string;
}

// A number the formulas use that people can try other values of in the app
// (what-ifs, never saved); `value` is the agreed one readings are judged by.
export interface ExpectationInput {
  label: string;
  unit?: string;
  value: number;
  min: number;
  max: number;
  step?: number;
}

export interface ExpectationModel {
  kind: 'expectation';
  model_metadata: { name: string; version: string; author: string; description: string };
  anchor: string;
  time_step_days: number;
  horizon_days: number;
  variables: Record<string, ExpectationVariable>;
  inputs?: Record<string, ExpectationInput>;
  rationale: string;
  evidence: { summary: string; observation_ids: string[]; experience_ids: string[] };
}

export interface Simulation {
  steps: number;
  runs: number;
  samples: Record<string, Float64Array[]>;
}

export interface Summary { mean: number; p10: number; p50: number; p90: number }

export interface ModelVersion {
  version: string;
  approved_at: string;
  definition: ExpectationModel;
  run: Simulation;
}

export interface Reading { observation_id: string; captured_at: string; value: string }

export interface ComparedReading extends Reading {
  version?: string;
  expected?: Summary;
  position?: 'below the middle 80%' | 'within the middle 80%' | 'above the middle 80%';
  tail_probability?: number;
  note?: string;
}

export function inputValues(model: Pick<ExpectationModel, 'inputs'>, overrides?: Record<string, number>): Record<string, number>;
export function simulate(model: Pick<ExpectationModel, 'time_step_days' | 'horizon_days' | 'variables' | 'inputs'>, options?: { seed?: number; inputs?: Record<string, number> }): Simulation;
export function summarize(values: ArrayLike<number>): Summary;
export function tailProbability(values: ArrayLike<number>, x: number): number;
export function dateOfStep(model: Pick<ExpectationModel, 'anchor' | 'time_step_days'>, step: number): string;
export function expectedPath(model: ExpectationModel, run: Simulation, key: string, points?: number): Array<Summary & { date: string }>;
export function expectedOn(model: ExpectationModel, run: Simulation, key: string, when: string | Date): { step: number; values: Float64Array } | null;
export function compareReadings(versions: ModelVersion[], key: string, readings: Reading[]): ComparedReading[];
