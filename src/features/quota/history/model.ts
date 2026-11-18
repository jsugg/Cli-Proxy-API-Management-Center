import type { HistoryProvider, QuotaHistorySample } from './types';

const MINUTE_MS = 60_000;
export const HISTORY_LOOKBACK_MS = 60 * MINUTE_MS;
export const HISTORY_MAX_GAP_MS = 15 * MINUTE_MS;
export const HISTORY_MAX_AGE_MS = 10 * MINUTE_MS;
/**
 * Providers re-derive the same reset boundary on every poll: Claude jitters by
 * milliseconds and Codex by a second. Boundaries this close are one window; a real
 * renewal moves the boundary by a whole period.
 */
export const RESET_DRIFT_TOLERANCE_MS = MINUTE_MS;

/** Same reset boundary, allowing for provider-side jitter. Unknown never matches. */
export function sameResetWindow(a: number | null, b: number | null): boolean {
  return a !== null && b !== null && Math.abs(a - b) <= RESET_DRIFT_TOLERANCE_MS;
}

/**
 * The collector's series_id hashes plan, period and the exact reset instant. A new
 * id with a jittered reset is the same window; a new id with an identical reset is a
 * genuine change (such as the plan) and still breaks continuity.
 */
export function sameHistorySeries(
  a: Pick<QuotaHistorySample, 'seriesId' | 'resetAt'>,
  b: Pick<QuotaHistorySample, 'seriesId' | 'resetAt'>
): boolean {
  if (!sameResetWindow(a.resetAt, b.resetAt)) return false;
  return a.seriesId === b.seriesId || a.resetAt !== b.resetAt;
}

export interface HistoryTrack {
  key: string;
  provider: HistoryProvider;
  accountId: string;
  limitId: string;
  periodSeconds: number | null;
  credentialIdentity: boolean;
  periodBoundaries: number[];
  samples: QuotaHistorySample[];
}

export interface HistoryAnalysis {
  reason: 'ready' | 'partial' | 'unknown' | 'stale' | 'insufficient' | 'flat';
  burnPerHour: number | null;
  sampleCount: number;
  totalCount: number;
  usableCount: number;
  spanMs: number;
  ageMs: number | null;
  exhaustionAt: number | null;
  projection: {
    startAt: number;
    remainingAtStart: number;
    endAt: number;
    remainingAtEnd: number;
  } | null;
}

/** Sort without mutation; conflicting measurements at one instant are an explicit gap. */
export function orderHistorySamples(samples: readonly QuotaHistorySample[]): QuotaHistorySample[] {
  const byTime = new Map<number, QuotaHistorySample>();
  for (const sample of samples) {
    const previous = byTime.get(sample.observedAt);
    if (!previous) {
      byTime.set(sample.observedAt, sample);
      continue;
    }
    if (
      previous.state !== sample.state ||
      previous.usedPercent !== sample.usedPercent ||
      previous.seriesId !== sample.seriesId ||
      previous.resetAt !== sample.resetAt ||
      previous.periodSeconds !== sample.periodSeconds
    ) {
      byTime.set(sample.observedAt, {
        ...sample,
        usedPercent: null,
        state: 'unknown',
        reason: 'conflicting_duplicate',
      });
    }
  }
  return [...byTime.values()].sort((a, b) => a.observedAt - b.observedAt);
}

/** Opaque provider account IDs deduplicate aliases; periods and limits remain independent. */
export function buildHistoryTracks(samples: readonly QuotaHistorySample[]): HistoryTrack[] {
  const tracks = new Map<string, HistoryTrack>();
  const gaps = new Map<string, QuotaHistorySample[]>();
  const limitGaps = new Map<string, QuotaHistorySample[]>();
  const accountTracks = new Map<string, HistoryTrack[]>();
  const limitTracks = new Map<string, HistoryTrack[]>();
  const limitRows = new Map<string, QuotaHistorySample[]>();
  const ensureTrack = (sample: QuotaHistorySample): HistoryTrack => {
    const account = JSON.stringify([sample.provider, sample.accountId]);
    const limit = JSON.stringify([sample.provider, sample.accountId, sample.limitId]);
    const key = JSON.stringify([
      sample.provider,
      sample.accountId,
      sample.limitId,
      sample.periodSeconds,
    ]);
    let track = tracks.get(key);
    if (!track) {
      track = {
        key,
        provider: sample.provider,
        accountId: sample.accountId,
        limitId: sample.limitId,
        periodSeconds: sample.periodSeconds,
        credentialIdentity: false,
        periodBoundaries: [],
        samples: [],
      };
      tracks.set(key, track);
      const matching = accountTracks.get(account) ?? [];
      matching.push(track);
      accountTracks.set(account, matching);
      const matchingLimits = limitTracks.get(limit) ?? [];
      matchingLimits.push(track);
      limitTracks.set(limit, matchingLimits);
    }
    return track;
  };
  for (const sample of samples) {
    if (
      sample.limitId === 'unknown' ||
      (sample.state === 'unknown' && sample.periodSeconds === null)
    ) {
      const destination = sample.limitId === 'unknown' ? gaps : limitGaps;
      const key = JSON.stringify(
        sample.limitId === 'unknown'
          ? [sample.provider, sample.accountId]
          : [sample.provider, sample.accountId, sample.limitId]
      );
      const values = destination.get(key) ?? [];
      values.push({ ...sample, state: 'unknown', usedPercent: null });
      destination.set(key, values);
      continue;
    }
    const track = ensureTrack(sample);
    track.credentialIdentity ||= sample.identityQuality === 'credential';
    track.samples.push(sample);
    const scope = JSON.stringify([sample.provider, sample.accountId, sample.limitId]);
    const scopeRows = limitRows.get(scope) ?? [];
    scopeRows.push(sample);
    limitRows.set(scope, scopeRows);
  }
  for (const [limit, rows] of limitGaps) {
    const matching = limitTracks.get(limit) ?? [ensureTrack(rows[0])];
    matching.forEach((track) => track.samples.push(...rows));
  }
  for (const [account, rows] of gaps) {
    const matching = accountTracks.get(account) ?? [];
    if (matching.length) matching.forEach((track) => track.samples.push(...rows));
    else {
      ensureTrack(rows[0]).samples.push(...rows);
    }
  }
  for (const [limit, rows] of limitRows) {
    const ordered = [...rows].sort((a, b) => a.observedAt - b.observedAt);
    const boundaries = ordered
      .slice(1)
      .filter((row, index) => row.periodSeconds !== ordered[index].periodSeconds)
      .map((row) => row.observedAt);
    (limitTracks.get(limit) ?? []).forEach((track) => {
      track.periodBoundaries = boundaries;
    });
  }
  return [...tracks.values()]
    .map((track) => ({
      ...track,
      credentialIdentity: track.samples.some((sample) => sample.identityQuality === 'credential'),
      samples: orderHistorySamples(track.samples),
    }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

function measurable(
  sample: QuotaHistorySample
): sample is QuotaHistorySample & { usedPercent: number; resetAt: number; periodSeconds: number } {
  return (
    sample.state === 'ok' &&
    typeof sample.usedPercent === 'number' &&
    Number.isFinite(sample.usedPercent) &&
    sample.usedPercent >= 0 &&
    sample.usedPercent <= 100 &&
    typeof sample.periodSeconds === 'number' &&
    Number.isFinite(sample.periodSeconds) &&
    sample.periodSeconds > 0 &&
    typeof sample.resetAt === 'number' &&
    Number.isFinite(sample.resetAt) &&
    sample.resetAt > sample.observedAt
  );
}

/** Estimate only a contiguous, fresh, same-window suffix. Percentages are not token capacity. */
export function analyzeQuotaHistory(
  samples: readonly QuotaHistorySample[],
  now: number,
  complete = true,
  periodBoundaries: readonly number[] = []
): HistoryAnalysis {
  const all = orderHistorySamples(samples).filter((sample) => sample.observedAt <= now);
  const ordered = all.filter((sample) => sample.observedAt >= now - HISTORY_LOOKBACK_MS);
  const latest = all[all.length - 1];
  const result: HistoryAnalysis = {
    reason: 'insufficient',
    burnPerHour: null,
    sampleCount: 0,
    totalCount: ordered.length,
    usableCount: ordered.filter(measurable).length,
    spanMs: 0,
    ageMs: latest ? now - latest.observedAt : null,
    exhaustionAt: null,
    projection: null,
  };
  if (!complete) return { ...result, reason: 'partial' };
  if (!latest) return result;
  const boundary = periodBoundaries.reduce(
    (latestBoundary, time) => (time <= now ? Math.max(time, latestBoundary) : latestBoundary),
    -Infinity
  );
  if (latest.observedAt < boundary) return { ...result, reason: 'unknown' };
  if (!measurable(latest) || latest.resetAt <= now) return { ...result, reason: 'unknown' };
  if (now - latest.observedAt > HISTORY_MAX_AGE_MS) return { ...result, reason: 'stale' };
  let first = latest;
  let sampleCount = 1;
  for (let index = ordered.length - 2; index >= 0; index--) {
    const previous = ordered[index];
    const next = first;
    if (
      !measurable(previous) ||
      previous.observedAt < boundary ||
      previous.periodSeconds !== latest.periodSeconds ||
      previous.provider !== latest.provider ||
      previous.accountId !== latest.accountId ||
      previous.limitId !== latest.limitId ||
      !sameHistorySeries(previous, latest) ||
      next.observedAt - previous.observedAt > HISTORY_MAX_GAP_MS ||
      next.usedPercent < previous.usedPercent
    )
      break;
    first = previous;
    sampleCount++;
  }
  result.sampleCount = sampleCount;
  result.spanMs = latest.observedAt - first.observedAt;
  if (sampleCount < 3 || result.spanMs < 15 * MINUTE_MS) return result;
  const rate = ((latest.usedPercent - first.usedPercent) * 3_600_000) / result.spanMs;
  if (rate <= 0) return { ...result, reason: 'flat' };
  const remaining = 100 - latest.usedPercent;
  const horizon = Math.min(latest.resetAt, now + HISTORY_LOOKBACK_MS);
  const emptyAt = latest.observedAt + (remaining * 3_600_000) / rate;
  const endAt = Math.min(horizon, Math.max(latest.observedAt, emptyAt));
  return {
    ...result,
    reason: 'ready',
    burnPerHour: rate,
    exhaustionAt: emptyAt <= horizon ? emptyAt : null,
    projection: {
      startAt: latest.observedAt,
      remainingAtStart: remaining,
      endAt,
      remainingAtEnd: Math.max(0, remaining - (rate * (endAt - latest.observedAt)) / 3_600_000),
    },
  };
}

export interface TrackOverview {
  track: HistoryTrack;
  /** Readings with a usable percentage in the loaded range. */
  measurableCount: number;
  latestRemaining: number | null;
  latestObservedAt: number | null;
  minRemaining: number | null;
  maxRemaining: number | null;
  /** Latest reading is recent enough to describe the present. */
  fresh: boolean;
}

function remainingOf(sample: QuotaHistorySample): number | null {
  return sample.state === 'ok' &&
    typeof sample.usedPercent === 'number' &&
    Number.isFinite(sample.usedPercent) &&
    sample.usedPercent >= 0 &&
    sample.usedPercent <= 100
    ? 100 - sample.usedPercent
    : null;
}

export function overviewTrack(track: HistoryTrack, now: number): TrackOverview {
  let measurableCount = 0;
  let minRemaining: number | null = null;
  let maxRemaining: number | null = null;
  let latest: QuotaHistorySample | null = null;
  for (const sample of track.samples) {
    const remaining = remainingOf(sample);
    if (remaining === null || sample.observedAt > now) continue;
    measurableCount += 1;
    latest = sample;
    minRemaining = minRemaining === null ? remaining : Math.min(minRemaining, remaining);
    maxRemaining = maxRemaining === null ? remaining : Math.max(maxRemaining, remaining);
  }
  return {
    track,
    measurableCount,
    latestRemaining: latest ? remainingOf(latest) : null,
    latestObservedAt: latest?.observedAt ?? null,
    minRemaining,
    maxRemaining,
    fresh: latest !== null && now - latest.observedAt <= HISTORY_MAX_AGE_MS,
  };
}

/**
 * Tracks worth charting first: fresh ones that actually moved in the range, then
 * the scarcest remaining allowance. Tracks with no usable reading are left out.
 */
export function rankHistoryTracks(tracks: readonly HistoryTrack[], now: number): TrackOverview[] {
  const moved = (item: TrackOverview) =>
    item.minRemaining !== null &&
    item.maxRemaining !== null &&
    item.maxRemaining > item.minRemaining;
  return tracks
    .map((track) => overviewTrack(track, now))
    .filter((item) => item.measurableCount > 0)
    .sort(
      (a, b) =>
        Number(b.fresh) - Number(a.fresh) ||
        Number(moved(b)) - Number(moved(a)) ||
        (a.latestRemaining ?? 101) - (b.latestRemaining ?? 101) ||
        a.track.key.localeCompare(b.track.key)
    );
}

/** Explicit choice when it still has readings, otherwise the highest-ranked track. */
export function selectHistoryTrack(
  ranked: readonly TrackOverview[],
  selectedKey: string
): TrackOverview | undefined {
  return ranked.find((item) => item.track.key === selectedKey) ?? ranked[0];
}
