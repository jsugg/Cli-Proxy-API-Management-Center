import { describe, expect, spyOn, test } from 'bun:test';
import { apiClient } from '../src/services/api/client';
import {
  createQuotaHistoryClient,
  parseHistoryCapabilities,
  parseHistoryPage,
  UnsupportedQuotaHistory,
} from '../src/services/api/quotaHistory';
import {
  historyCapabilitiesPayload as capabilities,
  historySamplePayload as sample,
} from './fixtures/quotaHistory';

const query = {
  from: Date.parse('2026-11-16T11:00:00Z'),
  to: Date.parse('2026-11-16T12:00:00Z'),
  provider: 'claude' as const,
  limit: 2000,
};
const page = { schema_version: 1, samples: [sample], next_cursor: null };

describe('quota history API boundary', () => {
  test.each([404, 501])(
    'maps missing capabilities %s to unsupported without guessing another endpoint',
    async (status) => {
      const client = apiClient.captureConnection();
      const get = spyOn(client, 'get').mockRejectedValue({ status });
      const capture = spyOn(apiClient, 'captureConnection').mockReturnValue(client);
      try {
        await expect(createQuotaHistoryClient(() => true).capabilities()).rejects.toBeInstanceOf(
          UnsupportedQuotaHistory
        );
        expect(get).toHaveBeenCalledTimes(1);
      } finally {
        get.mockRestore();
        capture.mockRestore();
      }
    }
  );

  test('normalizes capabilities and observations, never infers missing utilization', () => {
    expect(parseHistoryCapabilities(capabilities).maxPageSize).toBe(2000);
    expect(parseHistoryPage(page, query).samples[0].usedPercent).toBe(30);
    for (const used_percent of [null, -1, 101]) {
      const parsed = parseHistoryPage({ ...page, samples: [{ ...sample, used_percent }] }, query)
        .samples[0];
      expect(parsed.usedPercent).toBeNull();
      expect(parsed.state).toBe('unknown');
    }
  });

  test('rejects unsupported schema, malformed identities and oversized or out-of-range responses', () => {
    expect(() => parseHistoryCapabilities({ ...capabilities, schema_version: 2 })).toThrow();
    for (const payload of [
      { ...page, samples: Array.from({ length: 2001 }, () => sample) },
      { ...page, samples: [{ ...sample, account_id: '' }] },
      { ...page, samples: [{ ...sample, observed_at: '2026-11-16T13:00:00Z' }] },
      { ...page, samples: [{ ...sample, provider: 'codex' }] },
      { ...page, next_cursor: 'x'.repeat(4097) },
    ])
      expect(() => parseHistoryPage(payload, query)).toThrow();
  });

  test('pins auth to the original connection and uses only verified endpoints and cursor filters', async () => {
    const client = apiClient.captureConnection();
    const get = spyOn(client, 'get')
      .mockResolvedValueOnce(capabilities)
      .mockResolvedValueOnce(page);
    const capture = spyOn(apiClient, 'captureConnection').mockReturnValue(client);
    const current = () => true;
    try {
      const history = createQuotaHistoryClient(current);
      await history.capabilities();
      await history.page({ ...query, cursor: 'opaque-cursor' });
      expect(capture).toHaveBeenCalledWith(current);
      expect(get.mock.calls[0][0]).toBe('/quota-history/capabilities');
      expect(get.mock.calls[1][0]).toBe('/quota-history');
      expect(get.mock.calls[1][1]?.params).toEqual({
        provider: 'claude',
        from: new Date(query.from).toISOString(),
        to: new Date(query.to).toISOString(),
        limit: 2000,
        cursor: 'opaque-cursor',
      });
    } finally {
      get.mockRestore();
      capture.mockRestore();
    }
  });

  test('does not start or return requests for a stale connection', async () => {
    let current = true;
    const client = apiClient.captureConnection();
    let resolve!: (payload: unknown) => void;
    const get = spyOn(client, 'get').mockImplementation(
      () =>
        new Promise((r) => {
          resolve = r;
        })
    );
    const capture = spyOn(apiClient, 'captureConnection').mockReturnValue(client);
    try {
      const history = createQuotaHistoryClient(() => current);
      const pending = history.capabilities();
      current = false;
      resolve(capabilities);
      await expect(pending).rejects.toThrow();
      await expect(history.page(query)).rejects.toThrow();
      expect(get).toHaveBeenCalledTimes(1);
    } finally {
      get.mockRestore();
      capture.mockRestore();
    }
  });

  test('rejects unbounded or inverted queries before issuing a request', async () => {
    const client = apiClient.captureConnection();
    const get = spyOn(client, 'get').mockResolvedValue(page);
    const capture = spyOn(apiClient, 'captureConnection').mockReturnValue(client);
    try {
      const history = createQuotaHistoryClient(() => true);
      for (const patch of [
        { from: query.to + 1 },
        { from: query.to - 31 * 86400000 },
        { limit: 2001 },
        { limit: 0 },
      ]) {
        await expect(history.page({ ...query, ...patch })).rejects.toThrow();
      }
      expect(get).not.toHaveBeenCalled();
    } finally {
      get.mockRestore();
      capture.mockRestore();
    }
  });
});
