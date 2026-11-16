import { describe, expect, test } from 'bun:test';
import { buildQuotaPools, maskQuotaIdentity } from '../src/features/quota/pool';
import type { ClaudeQuotaState } from '../src/types';

const now = Date.parse('2026-11-16T12:00:00Z');
const entry = (name: string) => ({ type: 'claude' as const, file: { name, type: 'claude' } });
const quota = (
  usedPercent: number | null,
  extra: Partial<ClaudeQuotaState> = {}
): ClaudeQuotaState => ({
  status: 'success',
  observedAt: new Date(now).toISOString(),
  windows: [
    {
      id: 'seven-day',
      label: 'Weekly',
      usedPercent,
      periodHours: 168,
      resetLabel: '',
      resetAtMs: now + 1000,
    },
  ],
  ...extra,
});

describe('quota pool summaries', () => {
  test.each([0, 100])('keeps a measured endpoint distinct from unknown: %s used', (used) => {
    const weekly = buildQuotaPools([entry('a')], () => quota(used), now)[0].windows.find(
      (window) => window.id === 'seven-day'
    );
    expect(weekly?.known).toBe(1);
    expect(weekly?.remainingPercent).toBe(100 - used);
  });

  test('invalid durations are unknown rather than displayed as real window lengths', () => {
    const state = quota(20, { windows: [{ ...quota(20).windows[0], periodHours: Infinity }] });
    const pool = buildQuotaPools([entry('a')], () => state, now)[0];
    expect(
      pool.windows.every(
        (window) => window.periodHours === null || Number.isFinite(window.periodHours)
      )
    ).toBeTrue();
    expect(pool.windows.every((window) => window.remainingPercent === null)).toBeTrue();
  });
  test('reports an unweighted mean, coverage and nearest reset without summing capacity', () => {
    const entries = [entry('a'), entry('b'), entry('unloaded')];
    const states = { a: quota(20), b: quota(60) };
    const pool = buildQuotaPools(
      entries,
      (item) => states[item.file.name as keyof typeof states],
      now
    )[0];
    const weekly = pool.windows.find((window) => window.id === 'seven-day');
    expect(pool.total).toBe(3);
    expect(weekly?.known).toBe(2);
    expect(weekly?.remainingPercent).toBe(60);
    expect(weekly?.nextResetAtMs).toBe(now + 1000);
  });

  test.each([
    quota(null),
    quota(Number.NaN),
    quota(-1),
    quota(101),
    quota(30, { stale: true }),
    quota(30, { status: 'loading' }),
    quota(30, { status: 'error' }),
    quota(30, { observedAt: null }),
    quota(30, { observedAt: new Date(now - 16 * 60_000).toISOString() }),
    quota(30, { observedAt: new Date(now + 1000).toISOString() }),
    quota(30, { windows: [{ ...quota(30).windows[0], resetAtMs: now }] }),
  ])('never treats invalid, stale, failed or expired observations as full/zero', (state) => {
    const weekly = buildQuotaPools([entry('a')], () => state, now)[0].windows.find(
      (window) => window.id === 'seven-day'
    );
    expect(weekly?.known).toBe(0);
    expect(weekly?.remainingPercent).toBeNull();
    expect(weekly?.nextResetAtMs).toBeNull();
  });

  test('keeps model limits and unequal periods separate, deduplicates credentials', () => {
    const model = { ...quota(20).windows[0], id: 'seven-day-opus', label: 'Opus' };
    const pools = buildQuotaPools(
      [entry('a'), entry('a'), entry('b')],
      (item) =>
        item.file.name === 'a'
          ? quota(20, { windows: [...quota(20).windows, model] })
          : quota(40, { windows: [{ ...quota(40).windows[0], periodHours: 24 }] }),
      now
    );
    expect(pools[0].total).toBe(2);
    expect(pools[0].windows.filter((window) => window.known > 0)).toHaveLength(3);
  });

  test('disabled credentials are excluded even when supplied directly', () => {
    expect(
      buildQuotaPools(
        [{ ...entry('a'), file: { ...entry('a').file, disabled: true } }],
        () => quota(0),
        now
      )
    ).toEqual([]);
  });
});

describe('quota identity masking', () => {
  test('masks emails embedded in filenames and display labels without changing ordinary names', () => {
    expect(maskQuotaIdentity('claude-alice@example.com.json')).toBe('claude-a•••@e•••.json');
    expect(maskQuotaIdentity('account.json · Alice@Example.com')).toBe('account.json · A•••@E•••');
    expect(maskQuotaIdentity('personal-account.json')).toBe('personal-account.json');
    expect(maskQuotaIdentity('josé@exämple.com.json')).toBe('j•••@e•••.json');
  });
});
