import type { Observation } from '@/hooks/usePartHistory';
import type { Batch } from '@/lib/batchCurves';

// Ripeness is read on the peel colour index, stage 1 (green) to 7 (yellow with spoilage spots).
export const RIPENESS_METRIC = 'Ripeness stage';
const FIRST_STAGE = 1;
const SPOILAGE_STAGE = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

// The stage expected each day after harvest: an assumed straight line from stage 1 on the day of
// harvest to stage 7 on the day the first spoilage is expected (the middle of the model's bunches).
// A starting assumption, to be corrected by the batches' own readings.
export function expectedRipeness(spoilageDay: number | null, horizonDays: number): Array<{ day: number; stage: number }> {
  const reach = spoilageDay && spoilageDay > 0 ? spoilageDay : horizonDays;
  const points: Array<{ day: number; stage: number }> = [];
  for (let day = 0; day <= horizonDays; day++) {
    points.push({ day, stage: Math.min(SPOILAGE_STAGE, FIRST_STAGE + ((SPOILAGE_STAGE - FIRST_STAGE) * day) / reach) });
  }
  return points;
}

// The ripeness readings recorded for a batch, in days since it began.
export function batchRipeness(observations: Observation[], batch: Batch): Array<{ day: number; stage: number }> {
  const readings: Array<{ day: number; stage: number }> = [];
  for (const observation of observations) {
    if (observation.share_info) continue;
    if (!(observation.links ?? []).some((l) => l.entity_type === 'tool' && l.entity_id === batch.toolId)) continue;
    const metric = (observation.metrics ?? []).find((m) => m.metric_name === RIPENESS_METRIC);
    const stage = metric === undefined ? NaN : Number(metric.value);
    if (!Number.isFinite(stage)) continue;
    const day = (new Date(observation.observed_at).getTime() - batch.start.getTime()) / DAY_MS;
    readings.push({ day: Math.round(Math.max(0, day) * 10) / 10, stage });
  }
  return readings.sort((a, b) => a.day - b.day);
}
