import { useDeferredValue, useMemo, useState } from 'react';
import { ComposedChart, Area, Line, Scatter, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import { formatManila, MANILA_DATE_OPTS } from '@/lib/metricsChart';
import { expectedFor, type ToolExpectation, type ExpectedVariable } from '@/lib/expectationModels';
import { simulate } from '@/lib/expectations';

// What a tool's metrics are expected to do over time (its expectation
// models, set with Claude), and each reading against the expectation in
// force when it was taken. Models are proposed by Claude and approved by
// the person accountable for the tool; a model's inputs can be tried at other
// values here (what-ifs), which are never saved.

const fmtDate = (time: number) => formatManila(time, MANILA_DATE_OPTS);

function VariableChart({ v }: { v: ExpectedVariable }) {
  const unit = v.variable.unit ? ` ${v.variable.unit}` : '';
  const band = v.path.map((p) => ({ time: p.time, range: [p.p10, p.p90], mean: p.mean }));
  const tested = v.readings.filter((r) => r.expected);
  const within = tested.filter((r) => r.position === 'within the middle 80%');
  const outside = tested.filter((r) => r.position !== 'within the middle 80%');
  const evidence = v.readings.filter((r) => !r.expected);
  const point = (r: (typeof v.readings)[number]) => ({ time: r.time, value: Number(r.value) });
  const times = [...v.path.map((p) => p.time), ...v.readings.map((r) => r.time)];

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h4 className="font-medium">{v.variable.name}</h4>
        {v.today && (
          <span className="text-sm text-muted-foreground">
            Expected today: {v.today.mean}{unit} (most likely {v.today.p10}–{v.today.p90}{unit})
          </span>
        )}
      </div>
      <ResponsiveContainer width="100%" height={260}>
        <ComposedChart data={band} margin={{ top: 8, right: 8, bottom: 0, left: -12 }}>
          <CartesianGrid strokeDasharray="3 3" opacity={0.4} />
          <XAxis
            dataKey="time" type="number" scale="time" tickFormatter={fmtDate}
            domain={[Math.min(...times), Math.max(...times)]} fontSize={12}
          />
          <YAxis fontSize={12} />
          <Tooltip
            labelFormatter={(t) => fmtDate(Number(t))}
            formatter={(value, name) =>
              Array.isArray(value) ? [`${value[0]}–${value[1]}${unit}`, 'Middle 80%'] : [`${value}${unit}`, String(name)]}
          />
          <Area dataKey="range" name="Middle 80%" stroke="none" fill="#3b82f6" fillOpacity={0.15} isAnimationActive={false} />
          <Line dataKey="mean" name="Expected" stroke="#2563eb" dot={false} strokeWidth={2} isAnimationActive={false} />
          <Scatter data={evidence.map(point)} dataKey="value" name="Before the model" fill="#9ca3af" isAnimationActive={false} />
          <Scatter data={within.map(point)} dataKey="value" name="Reading" fill="#111827" isAnimationActive={false} />
          <Scatter data={outside.map(point)} dataKey="value" name="Surprising reading" fill="#ea580c" isAnimationActive={false} />
        </ComposedChart>
      </ResponsiveContainer>
      {v.variable.metric_id && (
        <p className="text-xs text-muted-foreground">
          {tested.length} reading{tested.length === 1 ? '' : 's'} since the first version
          {outside.length > 0 && <>, <span className="text-orange-600">{outside.length} outside the middle 80%</span></>}
          {evidence.length > 0 && <> · {evidence.length} earlier (grey) were evidence for it</>}
        </p>
      )}
    </div>
  );
}

function ModelCard({ e }: { e: ToolExpectation }) {
  const inputs = Object.entries(e.latest.inputs ?? {});
  const [whatIf, setWhatIf] = useState<Record<string, number>>({});
  const deferred = useDeferredValue(whatIf);
  const changed = Object.keys(deferred).length > 0;
  // With other input values, the expected paths come from a what-if run;
  // readings stay judged against the agreed model.
  const variables = useMemo(() => {
    if (!changed) return e.variables;
    const run = simulate(e.latest, { inputs: deferred });
    return e.variables.map((v) => ({ ...v, ...expectedFor(e.latest, run, v.key) }));
  }, [e, deferred, changed]);

  return (
    <div className="rounded-md border p-4 space-y-4">
      <div className="space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-lg font-semibold">{e.name}</h3>
          <Badge variant={e.basis === 'farm' ? 'default' : 'secondary'}>
            {e.basis === 'farm' ? 'Farm readings' : 'Borrowed'}
          </Badge>
        </div>
        <p>{e.latest.model_metadata.description}</p>
        <p className="text-xs text-muted-foreground">
          Version {e.version}{e.versionCount > 1 && ` of ${e.versionCount}`} · approved {fmtDate(new Date(e.approvedAt).getTime())}
          {' '}· set by {e.latest.model_metadata.author} · from {fmtDate(new Date(`${e.latest.anchor}T00:00:00+08:00`).getTime())}
        </p>
      </div>
      {inputs.length > 0 && (
        <div className="rounded-md bg-muted/50 p-3 space-y-3">
          {inputs.map(([key, input]) => {
            const value = whatIf[key] ?? input.value;
            return (
              <div key={key} className="grid grid-cols-[minmax(0,10rem)_1fr_auto] items-center gap-3 text-sm">
                <label htmlFor={`input-${key}`} className="text-muted-foreground">{input.label}</label>
                <Slider
                  id={`input-${key}`} min={input.min} max={input.max} step={input.step ?? (input.max - input.min) / 100}
                  value={[value]}
                  onValueChange={([x]) => setWhatIf((w) => ({ ...w, [key]: x }))}
                />
                <span className="tabular-nums font-medium">
                  {Number(value.toPrecision(3)).toLocaleString()}{input.unit ? ` ${input.unit}` : ''}
                </span>
              </div>
            );
          })}
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
            <span>
              {changed
                ? 'What-if: not saved. Readings are still judged against the agreed values.'
                : 'Move a slider to see what could be. Nothing is saved.'}
            </span>
            {Object.keys(whatIf).length > 0 && (
              <Button variant="outline" size="sm" onClick={() => setWhatIf({})}>Back to agreed values</Button>
            )}
          </div>
        </div>
      )}
      {variables.map((v) => <VariableChart key={v.key} v={v} />)}
      <details className="text-sm">
        <summary className="cursor-pointer text-muted-foreground">Why this expectation</summary>
        <div className="mt-2 space-y-2">
          <p>{e.latest.rationale}</p>
          <p className="text-muted-foreground">Evidence: {e.latest.evidence.summary}</p>
        </div>
      </details>
    </div>
  );
}

export function ExpectationsTab({ expectations }: { expectations: ToolExpectation[] }) {
  return (
    <div className="space-y-6">
      {expectations.map((e) => <ModelCard key={e.name} e={e} />)}
    </div>
  );
}
