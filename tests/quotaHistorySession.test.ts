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
