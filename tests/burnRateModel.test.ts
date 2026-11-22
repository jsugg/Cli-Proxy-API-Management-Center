import { describe, expect, test } from 'bun:test';
import { buildBurnRate, DAY_MS } from '../src/features/quota/burnRate/model';
import type { QuotaHistorySample } from '../src/features/quota/history/types';

const now = Date.parse('2026-11-21T12:00:00Z');
const hour = 3600000;
export const sample = (
  ago = 0,
  used = 40,
  extra: Partial<QuotaHistorySample> = {}
): QuotaHistorySample => ({
  observedAt: now - ago * hour,
  provider: 'xai',
  accountId: 'a',
  authIndex: 'synthetic',
  identityQuality: 'provider',
  limitId: 'weekly',
  seriesId: 'current',
  periodSeconds: 7 * 86400,
  resetAt: now + DAY_MS,
  usedPercent: used,
  state: 'ok',
  reason: null,
  ...extra,
});
const readings = [sample(4, 20), sample(2, 30), sample(0, 40)];
const groups = (rows = readings, complete = true, window: 'long' | 'short' = 'long') =>
  buildBurnRate(rows, now, 300, window, complete);

describe('burn rate reset-window estimates', () => {
  test('uses cumulative current-window observations, tolerates unknown gaps and projects to reset', () => {
    const [group] = groups([...readings, sample(1, 0, { state: 'unknown', usedPercent: null })]);
    expect(group.ratePerDay).toBeCloseTo(120);
    expect(group.remaining).toBe(60);
    expect(group.leftAtReset).toBe(0);
    expect(group.earliestExhaustion).toBe(now + 12 * hour);
    expect(group.projection?.at(-1)?.at).toBe(now + DAY_MS);
    expect(group.projection?.every((p) => p.at <= group.nextReset)).toBeTrue();
    expect(group.refills[0]).toEqual({ at: now + DAY_MS, remaining: 100 });
  });
  test('never crosses series, reset, decreasing utilization or duration changes', () => {
    for (const changed of [
      { seriesId: 'old' },
      { resetAt: now + 2 * DAY_MS },
      { usedPercent: 90 },
      { periodSeconds: 86400 },
    ]) {
      const [group] = groups([sample(4, 20, changed), ...readings.slice(1)]);
      expect(group.ratePerDay).toBeNull();
      expect(group.projection).toBeNull();
    }
  });
  test('requires three samples, minimum span and fresh latest reading', () => {
    for (const rows of [
      readings.slice(1),
      [sample(0.1, 20), sample(0.05, 30), sample(0, 40)],
      readings.map((s) => ({ ...s, observedAt: s.observedAt - hour })),
      [...readings, sample(0, 0, { state: 'unknown', usedPercent: null })],
    ])
      expect(groups(rows)[0]?.projection ?? null).toBeNull();
  });
  test('pools accounts equally, holds unrated contributors flat and reports coverage', () => {
    const [group] = groups([
      ...readings,
      sample(0, 20, { accountId: 'b', resetAt: now + 2 * DAY_MS }),
    ]);
    expect(group.contributing).toBe(2);
    expect(group.rated).toBe(1);
    expect(group.remaining).toBe(70);
    expect(group.ratePerDay).toBe(60);
    expect(group.leftAtReset).toBe(40);
    expect(group.nextReset).toBe(now + DAY_MS);
    expect(group.refills[0].remaining).toBe(90);
    expect(group.projection?.at(-1)?.remaining).toBe(40);
  });
  test('five-minute pooling treats latest unknown and expired reset as gaps and deduplicates aliases', () => {
    const [group] = groups([
      ...readings,
      sample(0.25, 10),
      sample(1 / 6, 0, { state: 'unknown', usedPercent: null }),
      sample(0, 40, { authIndex: 'alias' }),
    ]);
    expect(group.contributing).toBe(1);
    expect(group.history.at(-1)?.remaining).toBe(60);
    expect(group.history.at(-2)?.remaining).toBeNull();
    expect(group.history[0].remaining).toBeNull();
    expect(group.history).toHaveLength(1153);
  });
  test('filters windows, selects scarcest four and assigns colors by lexical identity', () => {
    const rows = ['z', 'b', 'c', 'a', 'd'].flatMap((limitId, i) =>
      readings.map((s) => ({ ...s, limitId, usedPercent: (s.usedPercent ?? 0) + i }))
    );
    const result = groups(rows);
    expect(result).toHaveLength(4);
    expect(result[0].limitId).toBe('d');
    expect(result.find((g) => g.limitId === 'a')?.color).toBe(0);
    expect(groups(readings.map((s) => ({ ...s, periodSeconds: 18000 })))).toHaveLength(0);
    expect(
      groups(
        readings.map((s) => ({ ...s, periodSeconds: 18000 })),
        true,
        'short'
      )
    ).toHaveLength(1);
  });
  test('partial loads disable estimates and past resets deduplicate drift', () => {
    expect(groups(readings, false)[0].projection).toBeNull();
    const [group] = groups([
      ...readings,
      sample(48, 80, { resetAt: now - DAY_MS }),
      sample(47, 85, { resetAt: now - DAY_MS + 500 }),
    ]);
    expect(group.pastResets).toHaveLength(1);
  });
  test('excludes samples before the current window and beyond the 24h baseline', () => {
    expect(groups([sample(25, 0), ...readings.slice(1)])[0].ratePerDay).toBeNull();
    expect(
      groups(readings.map((s) => ({ ...s, resetAt: now + 6.95 * DAY_MS })))[0].ratePerDay
    ).toBeNull();
  });
});

test('rate thresholds clamp short windows to fifteen minutes and long windows to two hours', () => {
  const short = [sample(0.25, 20), sample(0.125, 25), sample(0, 30)].map((s) => ({
    ...s,
    periodSeconds: 18000,
    resetAt: now + hour,
  }));
  expect(groups(short, true, 'short')[0].ratePerDay).toBeCloseTo(960);
  expect(groups([sample(1.5, 20), sample(0.75, 25), sample(0, 30)])[0].ratePerDay).toBeNull();
});

test('series colors follow identity when scarcity order changes', () => {
  const rows = ['a', 'b'].flatMap((limitId) => readings.map((s) => ({ ...s, limitId })));
  const first = groups(rows);
  const second = groups(
    rows.map((s) => ({ ...s, usedPercent: s.usedPercent! + (s.limitId === 'b' ? 20 : 0) }))
  );
  expect(second[0].limitId).toBe('b');
  expect(Object.fromEntries(first.map((g) => [g.key, g.color]))).toEqual(
    Object.fromEntries(second.map((g) => [g.key, g.color]))
  );
});

test('flat accounts are rated at zero and project their remaining allowance unchanged', () => {
  const [group] = groups(readings.map((s) => ({ ...s, usedPercent: 40 })));
  expect(group.rated).toBe(1);
  expect(group.ratePerDay).toBe(0);
  expect(group.leftAtReset).toBe(60);
  expect(group.projection?.map((p) => p.remaining)).toEqual([60, 60]);
});

test('already exhausted accounts use their latest observation even without a rate', () => {
  const latest = sample(0.1, 100);
  const [group] = groups([latest]);
  expect(group.earliestExhaustion).toBe(latest.observedAt);
});

test('pooled rate matches the projection slope with unrated accounts held flat', () => {
  const [group] = groups([...readings, sample(0, 20, { accountId: 'b' })]);
  const [a, b] = group.projection!;
  expect(group.ratePerDay).toBe(60);
  expect(((a.remaining! - b.remaining!) * DAY_MS) / (b.at - a.at)).toBeCloseTo(60);
});

test('exhaustion cannot appear beyond the pooled drawn reset or chart horizon', () => {
  const earlyReset = sample(0, 20, { accountId: 'b', resetAt: now + hour });
  expect(groups([...readings, earlyReset])[0].earliestExhaustion).toBeNull();
  const outsideChart = readings.map((s, i) => ({
    ...s,
    usedPercent: 10 + i,
    resetAt: now + 6 * DAY_MS,
  }));
  expect(groups(outsideChart)[0].earliestExhaustion).toBeNull();
});

test('failed expected accounts leave pooled gaps while absent accounts are not expected', () => {
  const [group] = groups([
    ...readings,
    sample(1 / 6, 10, { accountId: 'b' }),
    sample(1 / 12, 0, { accountId: 'b', state: 'unknown', usedPercent: null }),
    sample(1 / 12, 40),
  ]);
  expect(group.history.find((p) => p.at === now - 5 * 60000)?.remaining).toBeNull();
  expect(group.history.find((p) => p.at === now - 20 * 60000)?.remaining).toBeNull();
  expect(group.history.find((p) => p.at === now - 2 * hour)?.remaining).toBe(70);
});

test('history grid uses stable epoch boundaries across refreshes', () => {
  const first = buildBurnRate(readings, now + 60_000, 300)[0];
  const second = buildBurnRate(readings, now + 120_000, 300)[0];
  const grid = (group: typeof first) => group.history.filter((p) => p.at < now);
  expect(grid(first).every((p) => p.at % 300000 === 0)).toBeTrue();
  expect(grid(first)).toEqual(grid(second));
});

test('missing or NaN poll intervals use the 300-second freshness default', () => {
  const old = readings.map((s) => ({ ...s, observedAt: s.observedAt - hour }));
  for (const interval of [undefined, Number.NaN]) {
    expect(buildBurnRate(old, now, interval)).toHaveLength(0);
    expect(buildBurnRate(readings, now, interval)[0].rated).toBe(1);
  }
});

test('colors include hidden and stale limit groups in the selected window family', () => {
  const rows = ['a', 'b', 'c', 'd', 'e'].flatMap((limitId, i) =>
    readings.map((s) => ({ ...s, limitId, usedPercent: s.usedPercent! + i }))
  );
  const first = groups(rows);
  const second = groups(
    rows.map((s) => ({
      ...s,
      usedPercent: s.usedPercent! + (s.limitId === 'a' ? 10 : s.limitId === 'e' ? -20 : 0),
    }))
  );
  for (const group of first.filter((g) => second.some((s) => s.key === g.key)))
    expect(second.find((s) => s.key === group.key)?.color).toBe(group.color);
  const staleA = rows.map((s) =>
    s.limitId === 'a' ? { ...s, observedAt: s.observedAt - hour } : s
  );
  expect(groups(staleA).find((g) => g.limitId === 'b')?.color).toBe(1);
});

test('only the earliest refill has a pooled value', () => {
  const [group] = groups([
    ...readings,
    sample(0, 20, { accountId: 'b', resetAt: now + 2 * DAY_MS }),
  ]);
  expect(group.refills).toEqual([
    { at: now + DAY_MS, remaining: 90 },
    { at: now + 2 * DAY_MS, remaining: null },
  ]);
});

test('unknown rows with a different window stop the rate baseline', () => {
  for (const change of [
    { seriesId: 'other' },
    { resetAt: now + 2 * DAY_MS },
    { periodSeconds: 86400 },
  ]) {
    const [group] = groups([
      ...readings,
      sample(1, 0, { state: 'unknown', usedPercent: null, ...change }),
    ]);
    expect(group.ratePerDay).toBeNull();
  }
});

test('pooled grid carries account window boundaries even when the mean stays unchanged', () => {
  const [group] = groups([
    ...readings.slice(0, -1),
    sample(1 / 6, 40),
    sample(1 / 12, 40, { seriesId: 'new' }),
    sample(0, 40, { seriesId: 'new' }),
  ]);
  expect(group.history.find((p) => p.at === now - 5 * 60000)?.boundary).toBeTrue();
});

test('forecast and now value join the solid endpoint using each accounts observation time', () => {
  const rows = [
    ...readings.map((s) => ({ ...s, observedAt: s.observedAt - 5 * 60000 })),
    sample(1 / 6, 20, { accountId: 'b' }),
  ];
  const [group] = buildBurnRate(rows, now + 60000, 300);
  const expected = (60 - (120 * 6 * 60000) / DAY_MS + 80) / 2;
  expect(group.remaining).toBeCloseTo(expected);
  expect(group.history.at(-1)).toEqual(group.projection?.[0]);
  expect(group.projection?.[0]).toEqual({ at: now + 60000, remaining: group.remaining });
});

test('future exhaustion stays hidden when an expected unknown account prevents drawing a forecast', () => {
  const [group] = groups([
    ...readings,
    sample(0, 0, { accountId: 'b', state: 'unknown', usedPercent: null }),
  ]);
  expect(group.projection).toBeNull();
  expect(group.earliestExhaustion).toBeNull();
});

test('recorded paths split on per-account usage reversals within the same reset window', () => {
  const [group] = groups([sample(1 / 6, 90), sample(1 / 12, 20), sample(0, 25)]);
  expect(group.history.slice(-3).map((point) => point.remaining)).toEqual([10, 80, 75]);
  expect(group.history.at(-2)?.boundary).toBeTrue();
  expect(group.history.at(-1)?.boundary).toBeUndefined();
  expect(group.ratePerDay).toBeNull();
});

test('per-account reversals split the pooled path even when other usage masks the refund', () => {
  const [group] = groups([
    sample(1 / 6, 90),
    sample(1 / 12, 20),
    sample(0, 25),
    sample(1 / 6, 0, { accountId: 'b' }),
    sample(1 / 12, 80, { accountId: 'b' }),
    sample(0, 85, { accountId: 'b' }),
  ]);
  expect(group.history.slice(-3).map((point) => point.remaining)).toEqual([55, 50, 45]);
  expect(group.history.at(-2)?.boundary).toBeTrue();
});

test('reversals between grid ticks and across unknown polls still split the recorded path', () => {
  for (const middle of [
    [sample(4 / 60, 20), sample(3 / 60, 95)],
    [sample(7 / 60, 0, { state: 'unknown', usedPercent: null }), sample(4 / 60, 20)],
  ]) {
    const [group] = groups([sample(1 / 6, 90), ...middle, sample(0, 96)]);
    expect(group.history.at(-1)?.boundary).toBeTrue();
  }
});
