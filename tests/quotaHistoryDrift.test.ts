import { describe, expect, test } from 'bun:test';
import {
  analyzeQuotaHistory,
  buildHistoryTracks,
  rankHistoryTracks,
  sameHistorySeries,
} from '../src/features/quota/history/model';
import { buildHistoryPlot } from '../src/features/quota/history/plot';
import { QuotaHistorySession } from '../src/features/quota/history/session';
import { parseHistoryCapabilities } from '../src/services/api/quotaHistory';
import type { QuotaHistorySample } from '../src/features/quota/history/types';
import { historyCapabilitiesPayload } from './fixtures/quotaHistory';

const now = Date.parse('2026-11-17T12:00:00Z');
const minute = 60_000;
const weeklyReset = Date.parse('2026-11-20T02:59:59.509Z');
const sample = (
  ago: number,
  used: number | null,
  patch: Partial<QuotaHistorySample> = {}
): QuotaHistorySample => ({
  observedAt: now - ago * minute,
  provider: 'claude',
  accountId: 'opaque-a',
  authIndex: 'fixture',
  identityQuality: 'provider',
  limitId: 'seven-day',
  seriesId: `series-${ago}`,
  periodSeconds: 604800,
  resetAt: weeklyReset + (ago % 7),
  usedPercent: used,
  state: used === null ? 'unknown' : 'ok',
  reason: null,
  ...patch,
});

// Shape seen in the live collector: Claude re-derives the weekly reset every poll,
// a few milliseconds apart, so every observation carries a new series id.
const drifting = [25, 20, 15, 10, 5, 0].map((ago, index) => sample(ago, 50 + index * 2));

describe('quota history across provider reset jitter', () => {
  test('jittered resets remain one recorded window: one line, no change markers', () => {
    const plot = buildHistoryPlot(drifting);
    expect(plot.segments).toHaveLength(1);
    expect(plot.segments[0]).toHaveLength(6);
    expect(plot.changes).toEqual([]);
  });

  test('jittered resets still support a burn estimate from genuine readings', () => {
    const result = analyzeQuotaHistory(drifting, now);
    expect(result.reason).toBe('ready');
    expect(result.sampleCount).toBe(6);
    expect(result.burnPerHour).toBeCloseTo(24);
  });

  test('a real renewal or a plan change with an identical reset still breaks the series', () => {
    const renewed = [...drifting.slice(0, 3), sample(10, 1, { resetAt: weeklyReset + 604800_000 })];
    expect(buildHistoryPlot(renewed).segments).toHaveLength(2);
    const a = sample(5, 10, { seriesId: 'plan-a', resetAt: weeklyReset });
    expect(sameHistorySeries(a, { seriesId: 'plan-b', resetAt: weeklyReset })).toBe(false);
    expect(sameHistorySeries(a, { seriesId: 'plan-a', resetAt: weeklyReset })).toBe(true);
    expect(sameHistorySeries(a, { seriesId: 'jitter', resetAt: weeklyReset + 2 })).toBe(true);
    expect(sameHistorySeries(a, { seriesId: 'jitter', resetAt: weeklyReset + 2 * minute })).toBe(
      false
    );
  });

  test('ranking charts fresh, moving limits first and hides limits with no reading at all', () => {
    const flat = [10, 5, 0].map((ago) => sample(ago, 0, { limitId: 'seven-day-fable' }));
    const missing = [sample(0, null, { limitId: 'five-hour', periodSeconds: 18000 })];
    const tracks = buildHistoryTracks([...flat, ...drifting, ...missing]);
    const ranked = rankHistoryTracks(tracks, now);
    expect(ranked.map((item) => item.track.limitId)).toEqual(['seven-day', 'seven-day-fable']);
    expect(ranked[0]).toMatchObject({ minRemaining: 40, maxRemaining: 50, fresh: true });
    expect(ranked[1]).toMatchObject({ minRemaining: 100, maxRemaining: 100 });
    expect(tracks).toHaveLength(3);
  });
});

describe('quota history refresh keeps evidence on screen', () => {
  const caps = parseHistoryCapabilities(historyCapabilitiesPayload);

  test('a failed revalidation keeps the last successful samples and says so', async () => {
    let fail = false;
    const session = new QuotaHistorySession({
      client: {
        capabilities: async () => {
          if (fail) throw new Error('offline');
          return caps;
        },
        page: async () => ({ samples: drifting, nextCursor: null }),
      },
      rangeMs: 86_400_000,
      isCurrent: () => true,
      now: () => now,
    });
    await session.refresh();
    const states: string[] = [];
    session.subscribe(() =>
      states.push(`${session.getSnapshot().status}:${session.getSnapshot().samples.length}`)
    );
    fail = true;
    await session.refresh();
    // Never flashes an empty loading state between the two.
    expect(states).toEqual(['ready:6', 'ready:6']);
    expect(session.getSnapshot()).toMatchObject({ status: 'ready', refreshFailed: true });
    session.dispose();
  });

  test('ranges up to seven days are accepted; longer ones are rejected', () => {
    const client = {
      capabilities: async () => caps,
      page: async () => ({ samples: [], nextCursor: null }),
    };
    const make = (rangeMs: number) =>
      new QuotaHistorySession({ client, rangeMs, isCurrent: () => true });
    expect(() => make(7 * 86_400_000)).not.toThrow();
    expect(() => make(7 * 86_400_000 + 1)).toThrow();
  });
});
