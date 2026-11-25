import { describe, expect, test } from 'bun:test';
import { buildQuotaPools, maskQuotaIdentity } from '../src/features/quota/pool';
import type { TFunction } from 'i18next';
import { buildClaudeQuotaWindows } from '../src/features/quota/providers/claude/data';
import { buildCodexQuotaWindows } from '../src/features/quota/providers/codex/data';
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
  test.each(['claude', 'codex'] as const)(
    '%s omits null provider slots after successful loads',
    (provider) => {
      const t = ((key: string) => key) as TFunction;
      const windows =
        provider === 'claude'
          ? buildClaudeQuotaWindows(
              {
                five_hour: null,
                seven_day: { utilization: 20, resets_at: new Date(now + 1000).toISOString() },
              },
              t
            )
          : buildCodexQuotaWindows(
              {
                rate_limit: {
                  primary_window: null,
                  secondary_window: {
                    used_percent: 20,
                    limit_window_seconds: 604800,
                    reset_at: (now + 1000) / 1000,
                  },
                },
              },
              t
            );
      const entries = ['a', 'b', 'c'].map((name) => ({
        type: provider,
        file: { name, type: provider },
      }));
      const pool = buildQuotaPools(entries, () => quota(20, { windows }), now)[0];
      expect(pool.total).toBe(3);
      expect(pool.windows.map((window) => window.id)).toEqual([
        provider === 'claude' ? 'seven-day' : 'weekly',
      ]);
    }
  );

  test.each(['claude', 'codex'] as const)(
    '%s retains only remembered reported limits as unknown during refresh',
    (provider) => {
      const entries = [{ type: provider, file: { name: 'a', type: provider } }];
      const windows = [{ ...quota(20).windows[0], id: 'weekly-only' }];
      const previous = buildQuotaPools(entries, () => quota(20, { windows }), now)[0];
      const remembered = { [provider]: previous.windows };
      const snapshot = JSON.stringify(remembered);
      const loading = () => quota(null, { status: 'loading', windows: [] });
      const pool = buildQuotaPools(entries, loading, now, remembered)[0];
      expect(pool.total).toBe(1);
      expect(pool.windows).toEqual([
        { ...previous.windows[0], known: 0, remainingPercent: null, nextResetAtMs: null },
      ]);
      expect(JSON.stringify(remembered)).toBe(snapshot);
      expect(buildQuotaPools(entries, loading, now, { [provider]: [] })[0].windows).toEqual([]);
      expect(buildQuotaPools(entries, loading, now)[0].windows).toHaveLength(2);
      expect(
        buildQuotaPools(entries, () => quota(20, { windows: [] }), now, remembered)[0].windows
      ).toEqual([]);
    }
  );

  test('one reported short window retains coverage of all three enabled credentials', () => {
    const short = { ...quota(20).windows[0], id: 'five-hour', periodHours: 5 };
    const pool = buildQuotaPools(
      [entry('a'), entry('b'), entry('c')],
      (item) => quota(20, item.file.name === 'a' ? { windows: [short] } : {}),
      now
    )[0];
    expect(pool.total).toBe(3);
    expect(pool.windows.find((window) => window.id === 'five-hour')).toMatchObject({
      known: 1,
      remainingPercent: 80,
    });
  });

  test('a reported stale short window remains unknown', () => {
    const short = { ...quota(20).windows[0], id: 'five-hour', periodHours: 5 };
    const pool = buildQuotaPools(
      [entry('a'), entry('b'), entry('c')],
      (item) => quota(20, item.file.name === 'a' ? { windows: [short], stale: true } : {}),
      now
    )[0];
    expect(pool.total).toBe(3);
    expect(pool.windows.find((window) => window.id === 'five-hour')).toMatchObject({
      known: 0,
      remainingPercent: null,
      nextResetAtMs: null,
    });
  });

  test.each(['claude', 'codex'] as const)(
    '%s keeps unknown placeholders until any account succeeds',
    (provider) => {
      const entries = ['a', 'b', 'c'].map((name) => ({
        type: provider,
        file: { name, type: provider },
      }));
      const pool = buildQuotaPools(
        entries,
        (item) =>
          item.file.name === 'a' ? undefined : quota(20, { status: 'loading', windows: [] }),
        now
      )[0];
      expect(pool.total).toBe(3);
      expect(pool.windows.map((window) => window.id)).toEqual([
        'five-hour',
        provider === 'claude' ? 'seven-day' : 'weekly',
      ]);
      expect(
        pool.windows.every((window) => window.known === 0 && window.remainingPercent === null)
      ).toBeTrue();
    }
  );

  test('successful empty windows remove placeholders and failed states cannot add limits', () => {
    const pool = buildQuotaPools(
      [entry('a'), entry('b')],
      (item) =>
        item.file.name === 'a' ? quota(20, { windows: [] }) : quota(20, { status: 'error' }),
      now
    )[0];
    expect(pool.total).toBe(2);
    expect(pool.windows).toEqual([]);
  });

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
  test('masks local email text in generic labels without changing ordinary names', () => {
    expect(maskQuotaIdentity('alice@example.com')).toBe('al…e@example.com');
    expect(maskQuotaIdentity('account.json · Alice@Example.com')).toBe(
      'account.json · Al…e@Example.com'
    );
    expect(maskQuotaIdentity('personal-account.json')).toBe('personal-account.json');
    expect(maskQuotaIdentity('josé@exämple.com')).toBe('j…é@exämple.com');
  });

  test('copilot pool counts unlimited seats and averages only limited buckets', () => {
    const copilot = (name: string, disabled = false) => ({
      type: 'copilot' as const,
      file: { name, type: 'copilot', disabled },
    });
    const reset = now + 5 * 86_400_000;
    const bucket = (id: string, unlimited: boolean, percent: number | null = null) => ({
      id: id as 'premium_interactions' | 'chat' | 'completions',
      unlimited,
      percentRemaining: percent,
      remaining: percent === null ? null : percent * 3,
      entitlement: percent === null ? null : 300,
    });
    const states: Record<string, unknown> = {
      business: {
        status: 'success',
        observedAt: new Date(now).toISOString(),
        data: {
          buckets: ['premium_interactions', 'chat', 'completions'].map((id) => bucket(id, true)),
          resetAtMs: reset,
          plan: 'business',
          login: 'a',
          creditsUsed: 1,
        },
      },
      pro: {
        status: 'success',
        observedAt: new Date(now).toISOString(),
        data: {
          buckets: [bucket('premium_interactions', false, 40), bucket('chat', true)],
          resetAtMs: reset + 1000,
          plan: 'individual',
          login: 'b',
          creditsUsed: null,
        },
      },
      stale: {
        status: 'success',
        observedAt: new Date(now - 60 * 60_000).toISOString(),
        data: {
          buckets: [bucket('premium_interactions', false, 0)],
          resetAtMs: reset,
          plan: null,
          login: null,
          creditsUsed: null,
        },
      },
    };
    const entries = [copilot('business'), copilot('pro'), copilot('stale'), copilot('off', true)];
    const [pool] = buildQuotaPools(entries, (item) => states[item.file.name] as never, now);
    expect(pool.provider).toBe('copilot');
    expect(pool.total).toBe(3);
    expect(pool.windows.map((w) => w.id)).toEqual(['premium_interactions', 'chat', 'completions']);
    expect(pool.windows[0]).toMatchObject({
      periodHours: null,
      periodKey: 'quota_pool.monthly',
      labelKey: 'copilot_quota.bucket_premium_interactions',
      known: 2,
      unlimited: 1,
      remainingPercent: 40,
      used: 180,
      entitlement: 300,
      nextResetAtMs: reset,
    });
    expect(pool.windows[1]).toMatchObject({ known: 2, unlimited: 2, remainingPercent: null });
    expect(pool.windows[2]).toMatchObject({ known: 1, unlimited: 1 });

    const [empty] = buildQuotaPools([copilot('new')], () => undefined, now);
    expect(empty.windows.map((w) => [w.id, w.known])).toEqual([['premium_interactions', 0]]);
  });
});
