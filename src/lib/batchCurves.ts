import { simulate, expectedPath, type ExpectationModel } from '@/lib/expectations';
import { firstSpot, priceNow, type FirstSpot, type PriceNow } from '@/lib/marketCurves';
import type { Observation } from '@/hooks/usePartHistory';

// A batch is a lightweight tool, with a serial number (its code), made when something is added to
// a part and linked from that addition's observation. It lasts until it is removed or concluded.
// Its start is the first observation that links it.
export interface Batch {
  code: string;
  toolId: string;
  start: Date;
  observations: number;
}

// The batches of a part: the tools in use that its observations link to. `tools` are the tools
// still in use, so a batch that was removed or concluded drops out.
export function batchesFrom(
  observations: Observation[],
  tools: Array<{ id: string; serial_number?: string | null }>
): Batch[] {
  const inUse = new Map(tools.filter((t) => (t.serial_number ?? '').trim() !== '').map((t) => [t.id, (t.serial_number as string).trim()]));
  const byTool = new Map<string, Batch>();
  for (const observation of observations) {
    if (observation.share_info) continue;
    const at = new Date(observation.observed_at);
    for (const link of observation.links ?? []) {
      if (link.entity_type !== 'tool') continue;
      const code = inUse.get(link.entity_id);
      if (!code) continue;
      const found = byTool.get(link.entity_id);
      if (!found) byTool.set(link.entity_id, { code, toolId: link.entity_id, start: at, observations: 1 });
      else {
        found.observations += 1;
        if (at < found.start) found.start = at;
      }
    }
  }
  return [...byTool.values()].sort((a, b) => a.start.getTime() - b.start.getTime());
}

export interface BatchCurve {
  code: string;
  toolId: string;
  start: Date;
  ageDays: number;
  observations: number;
  // The price after the batch began, in percent of full price: the middle of the batch and the
  // middle 80%, on the farm's calendar days.
  path: Array<{ time: number; mean: number; p10: number; p90: number }>;
  spoilage: FirstSpot;
  priceToday: PriceNow | null;
}

const farmDay = (date: Date) => date.toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' });
const dayTime = (day: string) => new Date(`${day}T00:00:00+08:00`).getTime();
const DAY_MS = 24 * 60 * 60 * 1000;

// The part's price model started on the day the batch began: when its first spoilage is expected,
// and what it should sell for as it ages. The same model for every batch, so differences between
// batches come from when they began, and, once a batch has its own model and readings, from those.
export function batchCurve(model: ExpectationModel, batch: Batch, now: Date = new Date()): BatchCurve {
  const definition: ExpectationModel = { ...model, anchor: farmDay(batch.start) };
  const run = simulate(definition);
  return {
    code: batch.code,
    toolId: batch.toolId,
    start: batch.start,
    ageDays: Math.max(0, Math.floor((now.getTime() - dayTime(farmDay(batch.start))) / DAY_MS)),
    observations: batch.observations,
    path: expectedPath(definition, run, 'percent_of_full', 29).map((p) => ({ time: dayTime(p.date), mean: p.mean, p10: p.p10, p90: p.p90 })),
    spoilage: firstSpot(definition),
    priceToday: priceNow(definition, now),
  };
}
