import { HISTORY_MAX_GAP_MS, orderHistorySamples, sameHistorySeries } from './model';
import type { QuotaHistorySample } from './types';

/** Preserve every real observation, breaking lines at gaps, resets and series boundaries. */
export function buildHistoryPlot(
  samples: readonly QuotaHistorySample[],
  periodBoundaries: readonly number[] = []
): {
  segments: QuotaHistorySample[][];
  gaps: { from: number; to: number }[];
  changes: number[];
} {
  const segments: QuotaHistorySample[][] = [];
  const gaps: { from: number; to: number }[] = [];
  const changes: number[] = [...periodBoundaries];
  const boundaries = [...periodBoundaries].sort((a, b) => a - b);
  let boundaryIndex = 0;
  let segment: QuotaHistorySample[] | null = null;
  let previous: QuotaHistorySample | null = null;
  for (const sample of orderHistorySamples(samples)) {
    let crossedBoundary = false;
    while (boundaryIndex < boundaries.length && boundaries[boundaryIndex] <= sample.observedAt) {
      crossedBoundary ||= previous !== null && boundaries[boundaryIndex] > previous.observedAt;
      boundaryIndex++;
    }
    if (
      sample.state !== 'ok' ||
      sample.usedPercent === null ||
      !Number.isFinite(sample.usedPercent) ||
      sample.usedPercent < 0 ||
      sample.usedPercent > 100
    ) {
      gaps.push({ from: sample.observedAt, to: sample.observedAt });
      segment = null;
      continue;
    }
    // Reset jitter is not a window change; see RESET_DRIFT_TOLERANCE_MS.
    const changed =
      previous !== null &&
      (crossedBoundary ||
        (previous.resetAt !== null && sample.resetAt !== null
          ? !sameHistorySeries(previous, sample)
          : previous.seriesId !== sample.seriesId || previous.resetAt !== sample.resetAt) ||
        previous.periodSeconds !== sample.periodSeconds ||
        sample.usedPercent < (previous.usedPercent ?? 0));
    const missing =
      previous !== null && sample.observedAt - previous.observedAt > HISTORY_MAX_GAP_MS;
    if (changed) changes.push(sample.observedAt);
    if (missing && previous) gaps.push({ from: previous.observedAt, to: sample.observedAt });
    if (
      !segment ||
      changed ||
      missing ||
      sample.resetAt === null ||
      sample.periodSeconds === null
    ) {
      segment = [];
      segments.push(segment);
    }
    segment.push(sample);
    previous = sample;
  }
  return { segments, gaps, changes: [...new Set(changes)] };
}
