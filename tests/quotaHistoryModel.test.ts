import { describe, expect, test } from 'bun:test';
import { analyzeQuotaHistory, buildHistoryTracks } from '../src/features/quota/history/model';
import type { QuotaHistorySample } from '../src/features/quota/history/types';

const now = Date.parse('2026-11-16T12:00:00Z');
const minute = 60_000;
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
  seriesId: 'series-a',
  periodSeconds: 604800,
  resetAt: now + 2 * 60 * minute,
  usedPercent: used,
  state: used === null ? 'unknown' : 'ok',
  reason: null,
  ...patch,
});

describe('quota history analysis', () => {
  test('estimates percentage points per hour from distinct recent observations', () => {
    const result = analyzeQuotaHistory([sample(20, 10), sample(10, 20), sample(0, 30)], now);
    expect(result.burnPerHour).toBeCloseTo(60);
    expect(result.sampleCount).toBe(3);
    expect(result.spanMs).toBe(20 * minute);
    expect(result.ageMs).toBe(0);
    expect(result.projection?.endAt).toBe(now + 60 * minute);
    expect(result.projection?.remainingAtEnd).toBe(10);
    expect(result.exhaustionAt).toBeNull();
  });

  test('stops projections at reported reset, never assumes refills or pool exhaustion', () => {
    const samples = [sample(20, 10), sample(10, 20), sample(0, 30)].map((s) => ({
      ...s,
      resetAt: now + 15 * minute,
    }));
    const result = analyzeQuotaHistory(samples, now);
    expect(result.projection?.endAt).toBe(now + 15 * minute);
    expect(result.projection?.remainingAtEnd).toBe(55);
    expect(result.exhaustionAt).toBeNull();
  });

  test('reports exhaustion only inside the bounded current-window projection', () => {
    const result = analyzeQuotaHistory([sample(20, 70), sample(10, 80), sample(0, 90)], now);
    expect(result.exhaustionAt).toBe(now + 10 * minute);
    expect(result.projection?.remainingAtEnd).toBe(0);
  });

  test('flat observed use is no measurable rate, not infinite capacity', () => {
    const result = analyzeQuotaHistory([sample(20, 30), sample(10, 30), sample(0, 30)], now);
    expect(result.reason).toBe('flat');
    expect(result.burnPerHour).toBeNull();
    expect(result.exhaustionAt).toBeNull();
    expect(result.projection).toBeNull();
  });

  test.each([
    ['insufficient', [sample(10, 10), sample(0, 20)]],
    ['insufficient', [sample(10, 10), sample(5, 15), sample(0, 20)]],
    ['stale', [sample(35, 10), sample(25, 15), sample(11, 20)]],
    ['insufficient', [sample(30, 10), sample(25, 15), sample(0, 20)]],
    ['insufficient', [sample(20, 30), sample(10, 25), sample(0, 40)]],
    ['insufficient', [sample(20, 10), sample(10, null), sample(0, 40)]],
    ['insufficient', [sample(20, 10), sample(10, 20), sample(0, 30, { seriesId: 'changed-plan' })]],
    ['insufficient', [sample(20, 10), sample(10, 20), sample(0, 30, { resetAt: now + minute })]],
    ['insufficient', [sample(20, 10), sample(10, 20), sample(0, 30, { periodSeconds: 18000 })]],
    ['unknown', [sample(20, 10), sample(10, 20), sample(0, null)]],
    ['unknown', [sample(20, 10), sample(10, 20), sample(0, 30, { resetAt: null })]],
    ['unknown', [sample(20, 10), sample(10, 20), sample(0, 30, { resetAt: now })]],
    ['unknown', [sample(20, 10), sample(10, 20), sample(0, 30, { periodSeconds: null })]],
    ['insufficient', [sample(80, 1), sample(70, 3), sample(0, 30)]],
  ] as const)('does not forecast across %s boundary', (reason, samples) => {
    const result = analyzeQuotaHistory([...samples], now);
    expect(result.reason).toBe(reason);
    expect(result.projection).toBeNull();
  });

  test('ordering and identical duplicates do not change estimates; conflicting duplicates form gaps', () => {
    const samples = [sample(0, 30), sample(20, 10), sample(10, 20), sample(10, 20)];
    expect(analyzeQuotaHistory(samples, now).burnPerHour).toBe(60);
    expect(analyzeQuotaHistory([...samples, sample(10, 50)], now).projection).toBeNull();
    expect(samples[0].observedAt).toBe(now);
  });

  test('partial pages suppress forecasting even when the visible prefix looks sufficient', () => {
    expect(
      analyzeQuotaHistory([sample(20, 10), sample(10, 20), sample(0, 30)], now, false).reason
    ).toBe('partial');
  });

  test('coverage counts usable observations, not unknown values as zeros', () => {
    const result = analyzeQuotaHistory(
      [sample(30, null), sample(20, 10), sample(10, 20), sample(0, 30)],
      now
    );
    expect(result.usableCount).toBe(3);
    expect(result.totalCount).toBe(4);
  });

  test('history older than the estimation lookback is still explicitly stale', () => {
    const result = analyzeQuotaHistory([sample(90, 10), sample(80, 20), sample(70, 30)], now);
    expect(result.reason).toBe('stale');
    expect(result.ageMs).toBe(70 * minute);
    expect(result.projection).toBeNull();
  });

  test('permutations and alias duplicates preserve a monotone constant-rate series', () => {
    for (let count = 9; count <= 30; count++) {
      const values = Array.from({ length: count }, (_, i) => sample((count - 1 - i) * 2, i / 2));
      const expected = analyzeQuotaHistory(values, now);
      const reversed = [...values].reverse();
      expect(analyzeQuotaHistory([...reversed, ...values], now).burnPerHour).toBeCloseTo(15);
      expect(analyzeQuotaHistory(reversed, now)).toEqual(expected);
    }
  });
});

describe('independent history tracks', () => {
  test('new periods invalidate the old duration track without merging its recorded values', () => {
    const tracks = buildHistoryTracks([
      sample(20, 10),
      sample(10, 20),
      sample(5, 25),
      sample(0, 30, { periodSeconds: 18000, seriesId: 'new-duration' }),
    ]);
    const old = tracks.find((item) => item.periodSeconds === 604800);
    expect(old?.samples).toHaveLength(3);
    expect(
      analyzeQuotaHistory(old?.samples ?? [], now, true, old?.periodBoundaries).projection
    ).toBeNull();
    const restored = buildHistoryTracks([
      sample(20, 10),
      sample(15, 15),
      sample(10, 25, { periodSeconds: 18000, seriesId: 'new-duration' }),
      sample(5, 30),
      sample(0, 35),
    ]);
    const original = restored.find((item) => item.periodSeconds === 604800);
    expect(
      analyzeQuotaHistory(original?.samples ?? [], now, true, original?.periodBoundaries)
        .sampleCount
    ).toBe(2);
    expect(
      analyzeQuotaHistory(original?.samples ?? [], now, true, original?.periodBoundaries).projection
    ).toBeNull();
  });

  test('unknown-only credential identities retain the alias caveat', () => {
    expect(
      buildHistoryTracks([
        sample(0, null, { limitId: 'unknown', identityQuality: 'credential' }),
      ])[0].credentialIdentity
    ).toBeTrue();
  });

  test('clean recovery cannot erase a null-period missing-window gap in the same series', () => {
    const history = [
      sample(20, 10, { periodSeconds: 18000 }),
      sample(15, 15, { periodSeconds: 18000 }),
      sample(10, null, { periodSeconds: null, resetAt: null, reason: 'missing_window' }),
      sample(5, 20, { periodSeconds: 18000 }),
      sample(0, 25, { periodSeconds: 18000 }),
    ];
    const track = buildHistoryTracks(history).find((item) => item.periodSeconds === 18000);
    const result = analyzeQuotaHistory(track?.samples ?? [], now);
    expect(result.reason).toBe('insufficient');
    expect(result.sampleCount).toBe(2);
    expect(result.projection).toBeNull();
  });

  test('missing-window rows with null duration invalidate the matching known limit until recovery spans 15 minutes', () => {
    const history = [
      sample(20, 10),
      sample(10, 20),
      sample(5, 25),
      sample(0, null, { periodSeconds: null, resetAt: null, reason: 'missing_window' }),
    ];
    const track = buildHistoryTracks(history).find((item) => item.periodSeconds === 604800);
    expect(analyzeQuotaHistory(track?.samples ?? [], now).projection).toBeNull();
    expect(track?.samples[track.samples.length - 1].state).toBe('unknown');
    const recovery = buildHistoryTracks([
      ...history,
      sample(-5, 30),
      sample(-10, 35),
      sample(-15, 40),
    ]).find((item) => item.periodSeconds === 604800);
    expect(analyzeQuotaHistory(recovery?.samples ?? [], now + 15 * minute).projection).toBeNull();
    const restored = buildHistoryTracks([
      ...history,
      sample(-5, 30),
      sample(-10, 35),
      sample(-15, 40),
      sample(-20, 45),
    ]).find((item) => item.periodSeconds === 604800);
    expect(analyzeQuotaHistory(restored?.samples ?? [], now + 20 * minute).reason).toBe('ready');
  });

  test('deduplicates provider-account aliases but separates providers, limits and periods', () => {
    const tracks = buildHistoryTracks([
      sample(20, 10),
      sample(10, 20, { authIndex: 'other-alias' }),
      sample(0, 30, { provider: 'codex' }),
      sample(0, 30, { limitId: 'seven-day-opus' }),
      sample(0, 30, { periodSeconds: 18000 }),
    ]);
    expect(tracks).toHaveLength(4);
    expect(
      tracks.find(
        (track) =>
          track.provider === 'claude' &&
          track.limitId === 'seven-day' &&
          track.periodSeconds === 604800
      )?.samples
    ).toHaveLength(2);
  });

  test('whole-probe unknown rows invalidate each existing limit for that account only', () => {
    const tracks = buildHistoryTracks([
      sample(20, 10),
      sample(10, 20),
      sample(0, 30),
      sample(0, null, { limitId: 'unknown', periodSeconds: null }),
      sample(0, 30, { accountId: 'opaque-b' }),
    ]);
    const a = tracks.find((track) => track.accountId === 'opaque-a');
    expect(a?.samples.some((s) => s.state === 'unknown')).toBeTrue();
    expect(analyzeQuotaHistory(a?.samples ?? [], now).projection).toBeNull();
    expect(tracks.find((track) => track.accountId === 'opaque-b')?.samples).toHaveLength(1);
  });
});

export { now, sample };
