import { describe, expect, test } from 'bun:test';
import { QuotaHistorySession, HISTORY_MAX_PAGES } from '../src/features/quota/history/session';
import {
  UnsupportedQuotaHistory,
  parseHistoryCapabilities,
} from '../src/services/api/quotaHistory';
import { historyCapabilitiesPayload } from './fixtures/quotaHistory';
import type {
  QuotaHistoryClient,
  QuotaHistoryPage,
  QuotaHistoryQuery,
} from '../src/features/quota/history/types';

const caps = parseHistoryCapabilities(historyCapabilitiesPayload);
const now = Date.parse('2026-11-16T12:00:00Z');
const make = (client: QuotaHistoryClient, isCurrent = () => true) =>
  new QuotaHistorySession({
    client,
    provider: 'claude',
    rangeMs: 3600000,
    isCurrent,
    now: () => now,
  });

describe('history collection session', () => {
  test('requests capabilities before any page and shows collecting data immediately', async () => {
    const calls: string[] = [];
    const session = make({
      capabilities: async () => {
        calls.push('capabilities');
        return caps;
      },
      page: async () => {
        calls.push('page');
        return { samples: [], nextCursor: null };
      },
    });
    await session.refresh();
    expect(calls).toEqual(['capabilities', 'page']);
    expect(session.getSnapshot().status).toBe('ready');
    expect(session.getSnapshot().samples).toEqual([]);
    session.dispose();
  });

  test('absent capability prevents querying history; other errors stay visible', async () => {
    for (const error of [new UnsupportedQuotaHistory(), new Error('failed')]) {
      let queries = 0;
      const session = make({
        capabilities: async () => {
          throw error;
        },
        page: async () => {
          queries++;
          return { samples: [], nextCursor: null };
        },
      });
      await session.refresh();
      expect(session.getSnapshot().status).toBe(
        error instanceof UnsupportedQuotaHistory ? 'unsupported' : 'error'
      );
      expect(queries).toBe(0);
    }
  });

  test('pagination preserves frozen filters, bounds pages, and disables further loads at the cap', async () => {
    const queries: QuotaHistoryQuery[] = [];
    const session = make({
      capabilities: async () => caps,
      page: async (query) => {
        queries.push(query);
        return { samples: [], nextCursor: `cursor-${queries.length}` };
      },
    });
    await session.refresh();
    for (let i = 0; i < HISTORY_MAX_PAGES + 2; i++) await session.loadMore();
    expect(queries).toHaveLength(HISTORY_MAX_PAGES);
    for (const query of queries)
      expect({ ...query, cursor: undefined }).toEqual({ ...queries[0], cursor: undefined });
    expect(queries[1].cursor).toBe('cursor-1');
    expect(session.getSnapshot().capped).toBeTrue();
    expect(session.getSnapshot().complete).toBeFalse();
  });

  test('rejects repeated cursors instead of looping', async () => {
    const session = make({
      capabilities: async () => caps,
      page: async () => ({ samples: [], nextCursor: 'same' }),
    });
    await session.refresh();
    await session.loadMore();
    expect(session.getSnapshot().status).toBe('error');
  });

  test('failed background refresh preserves the query and cursor history for retained pages', async () => {
    let clock = now;
    let fail = false;
    const queries: QuotaHistoryQuery[] = [];
    const session = new QuotaHistorySession({
      client: {
        capabilities: async () => caps,
        page: async (query) => {
          queries.push(query);
          if (fail) throw new Error('offline');
          return { samples: [], nextCursor: 'original-cursor' };
        },
      },
      provider: 'claude',
      rangeMs: 3600000,
      isCurrent: () => true,
      now: () => clock,
    });
    await session.refresh();
    clock += 60_000;
    fail = true;
    await session.refresh();
    expect(session.getSnapshot()).toMatchObject({ status: 'ready', refreshFailed: true });
    fail = false;
    await session.loadMore();
    expect(queries[2]).toEqual({ ...queries[0], cursor: 'original-cursor' });
    // Retaining a page also retains its cursor-loop protection.
    expect(session.getSnapshot().status).toBe('error');
    session.dispose();
  });

  test.each(['logout', 'switch', 'unmount'] as const)(
    'ignores late success and failure after %s',
    async (change) => {
      for (const failed of [false, true]) {
        let current = true;
        let resolve!: (page: QuotaHistoryPage) => void;
        let reject!: (error: Error) => void;
        let signal: AbortSignal | undefined;
        const session = make(
          {
            capabilities: async () => caps,
            page: async (_query, provided) => {
              signal = provided;
              return new Promise<QuotaHistoryPage>((res, rej) => {
                resolve = res;
                reject = rej;
              });
            },
          },
          () => current
        );
        let writes = 0;
        session.subscribe(() => writes++);
        const pending = session.refresh();
        await Promise.resolve();
        if (change === 'unmount') session.dispose();
        else current = false;
        const before = writes;
        if (failed) reject(new Error('fixture failure'));
        else resolve({ samples: [], nextCursor: null });
        await pending;
        expect(writes).toBe(before);
        if (change === 'unmount') expect(signal?.aborted).toBeTrue();
      }
    }
  );

  test('refresh deduplicates in-flight requests and uses a new time range only on refresh', async () => {
    let calls = 0;
    let resolve!: (page: QuotaHistoryPage) => void;
    const session = make({
      capabilities: async () => caps,
      page: async () => {
        calls++;
        return new Promise((res) => {
          resolve = res;
        });
      },
    });
    const pending = session.refresh();
    await Promise.resolve();
    await session.refresh();
    expect(calls).toBe(1);
    resolve({ samples: [], nextCursor: null });
    await pending;
    session.dispose();
  });
});

describe('burn rate bounded history reads', () => {
  test('loadAll follows exact cursors through a frozen range up to its page budget', async () => {
    const queries: QuotaHistoryQuery[] = [];
    const session = new QuotaHistorySession({
      client: {
        capabilities: async () => caps,
        page: async (query) => {
          queries.push(query);
          return { samples: [], nextCursor: `next-${queries.length}` };
        },
      },
      isCurrent: () => true,
      rangeMs: 4 * 86400000,
      maxPages: 3,
      loadAll: true,
      now: () => now,
    });
    await session.refresh();
    expect(queries).toHaveLength(3);
    expect(queries.map((q) => q.cursor)).toEqual([undefined, 'next-1', 'next-2']);
    expect(
      queries.every((q) => q.from === queries[0].from && q.to === now && q.limit === 2000)
    ).toBeTrue();
    expect(session.getSnapshot()).toMatchObject({ complete: false, capped: true });
    session.dispose();
  });
  test('incremental refresh merges overlap, drops expired rows and deduplicates identical observations', async () => {
    const { parseHistoryPage } = await import('../src/services/api/quotaHistory');
    const { historySamplePayload } = await import('./fixtures/quotaHistory');
    const row = parseHistoryPage(
      { schema_version: 1, samples: [historySamplePayload], next_cursor: null },
      { from: now, to: now, limit: 1 }
    ).samples[0];
    let clock = now;
    const queries: QuotaHistoryQuery[] = [];
    const session = new QuotaHistorySession({
      client: {
        capabilities: async () => caps,
        page: async (query) => {
          queries.push(query);
          return {
            samples:
              queries.length === 1
                ? [{ ...row, observedAt: now - 3500000 }, row]
                : [row, { ...row, observedAt: clock }],
            nextCursor: null,
          };
        },
      },
      isCurrent: () => true,
      rangeMs: 3600000,
      incremental: true,
      now: () => clock,
    });
    await session.refresh();
    clock += 300000;
    await session.refresh();
    expect(queries[1].from).toBe(now - 15 * 60000);
    expect(session.getSnapshot().samples.map((s) => s.observedAt)).toEqual([now, clock]);
    expect(session.getSnapshot()).toMatchObject({
      complete: true,
      to: clock,
      refreshFailed: false,
    });
    session.dispose();
  });
  test('incomplete delta falls back to a full bounded load', async () => {
    const queries: QuotaHistoryQuery[] = [];
    const session = new QuotaHistorySession({
      client: {
        capabilities: async () => caps,
        page: async (query) => {
          queries.push(query);
          return { samples: [], nextCursor: queries.length === 2 ? 'delta-too-big' : null };
        },
      },
      isCurrent: () => true,
      rangeMs: 3600000,
      incremental: true,
      maxPages: 1,
      now: () => now,
    });
    await session.refresh();
    await session.refresh();
    expect(queries).toHaveLength(3);
    expect(queries[1].from).toBe(now - 15 * 60000);
    expect(queries[2].from).toBe(now - 3600000);
    expect(queries[2].cursor).toBeUndefined();
    expect(session.getSnapshot().complete).toBeTrue();
  });
  test('merge retains conflicting overlapping observations so downstream analysis fails closed', async () => {
    const { mergeHistorySamples } = await import('../src/features/quota/history/session');
    const { parseHistoryPage } = await import('../src/services/api/quotaHistory');
    const { orderHistorySamples } = await import('../src/features/quota/history/model');
    const { historySamplePayload } = await import('./fixtures/quotaHistory');
    const row = parseHistoryPage(
      { schema_version: 1, samples: [historySamplePayload], next_cursor: null },
      { from: now, to: now, limit: 1 }
    ).samples[0];
    const merged = mergeHistorySamples([row], [row, { ...row, usedPercent: 31 }], now);
    expect(merged).toHaveLength(2);
    expect(orderHistorySamples(merged)[0].state).toBe('unknown');
  });
});

test('incremental merges stay within the configured snapshot sample budget', async () => {
  const { parseHistoryPage } = await import('../src/services/api/quotaHistory');
  const { historySamplePayload } = await import('./fixtures/quotaHistory');
  const row = parseHistoryPage(
    { schema_version: 1, samples: [historySamplePayload], next_cursor: null },
    { from: now, to: now, limit: 1 }
  ).samples[0];
  let calls = 0;
  const session = new QuotaHistorySession({
    client: {
      capabilities: async () => ({ ...caps, maxPageSize: 2 }),
      page: async () => {
        calls++;
        return {
          samples: calls === 1 ? [row, { ...row, accountId: 'b' }] : [{ ...row, accountId: 'c' }],
          nextCursor: null,
        };
      },
    },
    isCurrent: () => true,
    rangeMs: 3600000,
    maxPages: 1,
    incremental: true,
    now: () => now,
  });
  await session.refresh();
  await session.refresh();
  expect(calls).toBe(3);
  expect(session.getSnapshot().samples).toHaveLength(1);
});

test('incremental refresh fully reloads when the requested range grows backwards', async () => {
  const queries: QuotaHistoryQuery[] = [];
  let maxQueryDays = 1;
  const session = new QuotaHistorySession({
    client: {
      capabilities: async () => ({ ...caps, maxQueryDays }),
      page: async (query) => {
        queries.push(query);
        return { samples: [], nextCursor: null };
      },
    },
    isCurrent: () => true,
    rangeMs: 4 * 86400000,
    incremental: true,
    now: () => now,
  });
  await session.refresh();
  maxQueryDays = 4;
  await session.refresh();
  expect(queries[1].from).toBe(now - 4 * 86400000);
  expect(session.getSnapshot()).toMatchObject({ from: queries[1].from, complete: true });
  session.dispose();
});
