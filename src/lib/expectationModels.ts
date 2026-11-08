import type { StateSpaceModelRecord } from '@/lib/stateSpaceApi';
import type { ObservationHistoryEntry } from '@/hooks/tools/useToolHistory';
import {
  simulate, expectedPath, expectedOn, summarize, compareReadings,
  type ExpectationModel, type ExpectationVariable, type ModelVersion, type Simulation, type ComparedReading, type Summary,
} from '@/lib/expectations';

export interface ExpectedVariable {
  key: string;
  variable: ExpectationVariable;
  path: Array<Summary & { date: string; time: number }>;
  today: Summary | null;
  readings: Array<ComparedReading & { time: number }>;
}

export interface ToolExpectation {
  name: string;
  latest: ExpectationModel;
  version: string;
  approvedAt: string;
  versionCount: number;
  basis: 'farm' | 'borrowed';
  variables: ExpectedVariable[];
}

export const isExpectation = (record: StateSpaceModelRecord): boolean =>
  (record.model_definition as unknown as { kind?: string })?.kind === 'expectation';

// The farm calendar day as a time on the chart's axis.
const dayTime = (date: string) => new Date(`${date}T00:00:00+08:00`).getTime();

// What a variable is expected to do over time, and today, in one run of a
// model (the agreed one, or a what-if with other input values).
export function expectedFor(d: ExpectationModel, run: Simulation, key: string, now: Date = new Date()) {
  const now_ = expectedOn(d, run, key, now);
  return {
    path: expectedPath(d, run, key, Math.min(120, run.steps)).map((p) => ({ ...p, time: dayTime(p.date) })),
    today: now_ ? summarize(now_.values) : null,
  };
}

// Each expectation model on a tool (latest version), with the expected path
// of every variable and its metric's readings judged against the version in
// force when each was taken — as get_model reports them to Claude.
export function buildToolExpectations(
  records: StateSpaceModelRecord[],
  observations: ObservationHistoryEntry[],
  now: Date = new Date(),
): ToolExpectation[] {
  const models = records.filter(isExpectation)
    .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
  const names = [...new Set(models.map((m) => m.name))];
  return names.map((name) => {
    const versions: ModelVersion[] = models.filter((m) => m.name === name).map((m) => {
      const definition = m.model_definition as unknown as ExpectationModel;
      return { version: m.version, approved_at: m.created_at, definition, run: simulate(definition) };
    });
    const latest = versions[versions.length - 1];
    const d = latest.definition;
    return {
      name,
      latest: d,
      version: latest.version,
      approvedAt: latest.approved_at,
      versionCount: versions.length,
      basis: d.evidence.observation_ids.length > 0 ? 'farm' : 'borrowed',
      variables: Object.entries(d.variables).map(([key, variable]) => {
        const readings = variable.metric_id
          ? observations.flatMap((o) => (o.metrics ?? [])
            .filter((m) => m.metric_id === variable.metric_id)
            .map((m) => ({ observation_id: o.id, captured_at: o.observed_at, value: m.value })))
          : [];
        return {
          key,
          variable,
          ...expectedFor(d, latest.run, key, now),
          readings: compareReadings(versions, key, readings)
            .filter((r) => r.note !== 'not a number')
            .map((r) => ({ ...r, time: new Date(r.captured_at).getTime() })),
        };
      }),
    };
  });
}
