import {
  buildHistoryTracks,
  RESET_DRIFT_TOLERANCE_MS,
  sameHistorySeries,
  type HistoryTrack,
} from '../history/model';
import type { QuotaHistorySample } from '../history/types';

export const DAY_MS = 86_400_000;
export const BURN_HISTORY_MS = 4 * DAY_MS;
export const BURN_FORWARD_MS = 3 * DAY_MS;
const GRID_MS = 5 * 60_000;
export type BurnWindow = 'long' | 'short';
export interface BurnPoint {
  at: number;
  remaining: number | null;
  /** Start a new recorded segment at this cell. */
  boundary?: boolean;
}
interface Contributor {
  latest: QuotaHistorySample & { usedPercent: number; resetAt: number; periodSeconds: number };
  rate: number | null;
}
export interface BurnGroup {
  key: string;
  limitId: string;
  periodSeconds: number;
  color: number;
  remaining: number;
  contributing: number;
  rated: number;
  ratePerDay: number | null;
  leftAtReset: number | null;
  nextReset: number;
  earliestExhaustion: number | null;
  credentialIdentity: boolean;
  history: BurnPoint[];
  projection: BurnPoint[] | null;
  refills: BurnPoint[];
  pastResets: number[];
}
function measurable(s: QuotaHistorySample): s is Contributor['latest'] {
  return (
    s.state === 'ok' &&
    s.usedPercent !== null &&
    Number.isFinite(s.usedPercent) &&
    s.usedPercent >= 0 &&
    s.usedPercent <= 100 &&
    s.periodSeconds !== null &&
    Number.isFinite(s.periodSeconds) &&
    s.periodSeconds > 0 &&
    s.resetAt !== null &&
    Number.isFinite(s.resetAt) &&
    s.resetAt > s.observedAt
  );
}
const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
function boundaryAt(track: HistoryTrack, at: number): number {
  return track.periodBoundaries.reduce(
    (last, time) => (time <= at ? Math.max(last, time) : last),
    -Infinity
  );
}
/** Missing window fields say nothing; known fields can still identify a boundary. */
function differentWindow(a: QuotaHistorySample, b: QuotaHistorySample): boolean {
  if (a.periodSeconds !== null && b.periodSeconds !== null && a.periodSeconds !== b.periodSeconds)
    return true;
  if (a.resetAt !== null && b.resetAt !== null) return !sameHistorySeries(a, b);
  return Boolean(a.seriesId && b.seriesId && a.seriesId !== b.seriesId);
}
function contributor(track: HistoryTrack, now: number, freshMs: number): Contributor | null {
  const rows = track.samples.filter((s) => s.observedAt <= now);
  const latest = rows[rows.length - 1];
  const boundary = boundaryAt(track, now);
  if (
    !latest ||
    !measurable(latest) ||
    latest.resetAt <= now ||
    now - latest.observedAt > freshMs ||
    latest.observedAt < boundary
  )
    return null;
  const periodMs = latest.periodSeconds * 1000;
  const from = Math.max(now - Math.min(DAY_MS, periodMs), latest.resetAt - periodMs, boundary);
  const usable = [latest];
  for (let i = rows.length - 2; i >= 0; i--) {
    const row = rows[i];
    if (row.observedAt < from) break;
    // Cumulative readings survive missing polls, but never a known window or usage reversal.
    if (differentWindow(row, latest)) break;
    if (!measurable(row)) continue;
    if (row.usedPercent > usable[usable.length - 1].usedPercent) break;
    usable.push(row);
  }
  const first = usable[usable.length - 1];
  const span = latest.observedAt - first.observedAt;
  const minimumSpan = Math.max(15 * 60_000, Math.min(2 * 3_600_000, periodMs * 0.05));
  const rate =
    usable.length >= 3 && span >= minimumSpan
      ? ((latest.usedPercent - first.usedPercent) * DAY_MS) / span
      : null;
  return { latest, rate };
}
function valueAt(account: Contributor, at: number): number {
  return Math.max(
    0,
    100 -
      account.latest.usedPercent -
      ((account.rate ?? 0) * Math.max(0, at - account.latest.observedAt)) / DAY_MS
  );
}
function distinctResets(values: number[]): number[] {
  const result: number[] = [];
  for (const value of values.sort((a, b) => a - b)) {
    if (!result.length || value - result[result.length - 1] > RESET_DRIFT_TOLERANCE_MS)
      result.push(value);
  }
  return result;
}
function pooledHistory(tracks: HistoryTrack[], now: number): BurnPoint[] {
  const indexes = tracks.map(() => -1);
  const previousReadings: (QuotaHistorySample | undefined)[] = tracks.map(() => undefined);
  const result: BurnPoint[] = [];
  const times: number[] = [];
  for (let at = Math.ceil((now - BURN_HISTORY_MS) / GRID_MS) * GRID_MS; at <= now; at += GRID_MS)
    times.push(at);
  if (times[times.length - 1] !== now) times.push(now);
  for (const at of times) {
    const values: number[] = [];
    let unknown = false;
    let boundary = false;
    tracks.forEach((track, index) => {
      while (
        indexes[index] + 1 < track.samples.length &&
        track.samples[indexes[index] + 1].observedAt <= at
      ) {
        const previous = track.samples[indexes[index]];
        const row = track.samples[++indexes[index]];
        if (previous && differentWindow(previous, row)) boundary = true;
        if (measurable(row)) {
          const reading = previousReadings[index];
          // Check every account reading before averaging, including rows between grid ticks.
          // Unknown polls do not erase the last comparable cumulative measurement.
          if (reading && measurable(reading) && row.usedPercent < reading.usedPercent)
            boundary = true;
          previousReadings[index] = row;
        }
      }
      const row = track.samples[indexes[index]];
      const expected = row && row.observedAt > at - 15 * 60_000;
      if (!expected) return;
      if (!measurable(row) || row.observedAt < boundaryAt(track, at)) {
        unknown = true;
      } else if (row.resetAt > at) {
        values.push(100 - row.usedPercent);
      }
    });
    result.push({
      at,
      remaining: !unknown && values.length ? mean(values) : null,
      ...(boundary ? { boundary: true } : {}),
    });
  }
  return result;
}
/** One provider per call. Every percentage is an equal-account mean within one limit/duration. */
export function buildBurnRate(
  samples: readonly QuotaHistorySample[],
  now: number,
  pollIntervalSeconds = 300,
  window: BurnWindow = 'long',
  forecastAllowed = true
): BurnGroup[] {
  const grouped = new Map<string, HistoryTrack[]>();
  for (const track of buildHistoryTracks(samples)) {
    if (track.periodSeconds === null || (window === 'long') !== track.periodSeconds >= 86400)
      continue;
    const key = JSON.stringify([track.limitId, track.periodSeconds]);
    grouped.set(key, [...(grouped.get(key) ?? []), track]);
  }
  const lexical = [...grouped.entries()].sort(
    ([, a], [, b]) =>
      a[0].limitId.localeCompare(b[0].limitId) || a[0].periodSeconds! - b[0].periodSeconds!
  );
  const pollSeconds = Number.isFinite(pollIntervalSeconds) ? pollIntervalSeconds : 300;
  const freshMs = Math.max(10 * 60_000, 3 * pollSeconds * 1000);
  const groups: BurnGroup[] = [];
  for (const [key, tracks] of grouped) {
    const accounts = tracks
      .map((track) => contributor(track, now, freshMs))
      .filter((a): a is Contributor => a !== null);
    if (!accounts.length) continue;
    const rated = accounts.filter((a) => a.rate !== null);
    const nextReset = Math.min(...accounts.map((a) => a.latest.resetAt));
    const history = pooledHistory(tracks, now);
    const endpoint = history[history.length - 1];
    const canProject = forecastAllowed && rated.length > 0 && endpoint.remaining !== null;
    const empties = accounts.flatMap((account) => {
      const { latest, rate } = account;
      const at =
        latest.usedPercent === 100
          ? latest.observedAt
          : rate !== null && rate > 0
            ? latest.observedAt + ((100 - latest.usedPercent) * DAY_MS) / rate
            : null;
      return at !== null && at >= latest.observedAt && at <= latest.resetAt ? [at] : [];
    });
    const drawnExhaustions = empties.filter(
      (at) => at <= Math.min(nextReset, now + BURN_FORWARD_MS)
    );
    const remaining = canProject
      ? mean(accounts.map((account) => valueAt(account, now)))
      : mean(accounts.map((account) => 100 - account.latest.usedPercent));
    // The live endpoint estimates every account at the same instant as the forecast.
    // Keep an unknown pooled cell a gap, even when other accounts can be rated.
    if (canProject) endpoint.remaining = remaining;
    const projectionTimes = [
      ...new Set([now, nextReset, ...empties.filter((at) => at > now && at < nextReset)]),
    ].sort((a, b) => a - b);
    const resetTimes = distinctResets(accounts.map((a) => a.latest.resetAt));
    groups.push({
      key,
      limitId: tracks[0].limitId,
      periodSeconds: tracks[0].periodSeconds!,
      color: lexical.findIndex(([id]) => id === key) % 4,
      remaining,
      contributing: accounts.length,
      rated: rated.length,
      ratePerDay: rated.length ? mean(accounts.map((a) => a.rate ?? 0)) : null,
      leftAtReset: canProject ? mean(accounts.map((a) => valueAt(a, a.latest.resetAt))) : null,
      nextReset,
      earliestExhaustion:
        forecastAllowed && drawnExhaustions.some((at) => canProject || at <= now)
          ? Math.min(...drawnExhaustions.filter((at) => canProject || at <= now))
          : null,
      credentialIdentity: tracks.some((track) => track.credentialIdentity),
      history,
      // The first refill ends the pooled usage line. Later known refills are isolated markers.
      projection: canProject
        ? projectionTimes.map((at) => ({
            at,
            remaining: mean(accounts.map((a) => valueAt(a, at))),
          }))
        : null,
      refills: canProject
        ? resetTimes.map((at) => ({
            at,
            remaining:
              at === nextReset
                ? mean(
                    accounts.map((a) =>
                      a.latest.resetAt <= at + RESET_DRIFT_TOLERANCE_MS ? 100 : valueAt(a, at)
                    )
                  )
                : null,
          }))
        : [],
      pastResets: distinctResets(
        tracks.flatMap((track) =>
          track.samples
            .filter(measurable)
            .map((s) => s.resetAt)
            .filter((at) => at >= now - BURN_HISTORY_MS && at <= now)
        )
      ),
    });
  }
  return groups.sort((a, b) => a.remaining - b.remaining || a.key.localeCompare(b.key)).slice(0, 4);
}
