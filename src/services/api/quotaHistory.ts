import { apiClient } from './client';
import { isRecord } from '@/utils/helpers';
import type {
  HistoryProvider,
  QuotaHistoryCapabilities,
  QuotaHistoryClient,
  QuotaHistoryPage,
  QuotaHistoryQuery,
  QuotaHistorySample,
} from '@/features/quota/history/types';

const DAY_MS = 86_400_000;
export const HISTORY_PAGE_LIMIT = 2000;

export class UnsupportedQuotaHistory extends Error {}

function invalid(): never {
  throw new Error('Invalid quota history response');
}
function object(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : invalid();
}
function text(value: unknown, max = 256): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) invalid();
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code < 32 || code === 127) invalid();
  }
  return value;
}
function integer(value: unknown, min: number, max: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max
    ? value
    : invalid();
}
function instant(value: unknown): number {
  const raw = text(value, 40);
  const time = Date.parse(raw);
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(raw) &&
    Number.isFinite(time)
    ? time
    : invalid();
}
function nullableInstant(value: unknown): number | null {
  return value === null ? null : instant(value);
}
export const HISTORY_MAX_PROVIDERS = 32;
const PROVIDER_SLUG = /^[a-z][a-z0-9_-]{0,31}$/;
function provider(value: unknown): HistoryProvider {
  return typeof value === 'string' && PROVIDER_SLUG.test(value) ? value : invalid();
}

/** Validate the versioned companion capability response without exposing diagnostic bodies. */
export function parseHistoryCapabilities(value: unknown): QuotaHistoryCapabilities {
  const data = object(value);
  if (data.schema_version !== 1)
    throw new UnsupportedQuotaHistory('Unsupported quota history schema');
  const status = object(data.status);
  if (
    !Array.isArray(data.providers) ||
    data.providers.length > HISTORY_MAX_PROVIDERS ||
    typeof status.stale !== 'boolean'
  )
    invalid();
  integer(data.max_accounts, 1, 128);
  integer(data.max_samples, 1, 500000);
  if (status.last_error !== null) text(status.last_error, 128);
  return {
    pollIntervalSeconds: integer(data.poll_interval_seconds, 1, 86400),
    retentionDays: integer(data.retention_days, 1, 365),
    providers: [...new Set(data.providers.map(provider))],
    maxQueryDays: integer(data.max_query_days, 1, 30),
    maxPageSize: integer(data.max_page_size, 1, HISTORY_PAGE_LIMIT),
    status: {
      startedAt: instant(status.started_at),
      lastPollAt: nullableInstant(status.last_poll_at),
      lastSuccessAt: nullableInstant(status.last_success_at),
      lastSampleAt: nullableInstant(status.last_sample_at),
      consecutiveFailures: integer(status.consecutive_failures, 0, Number.MAX_SAFE_INTEGER),
      stale: status.stale,
      lastError: status.last_error === null ? null : text(status.last_error, 128),
    },
  };
}

function validateQuery(query: QuotaHistoryQuery): void {
  if (
    !Number.isFinite(query.from) ||
    !Number.isFinite(query.to) ||
    query.to < query.from ||
    query.to - query.from > 30 * DAY_MS
  )
    throw new Error('Invalid quota history range');
  integer(query.limit, 1, HISTORY_PAGE_LIMIT);
  if (query.provider !== undefined) provider(query.provider);
  if (query.cursor !== undefined) text(query.cursor, 4096);
}

/** Normalize a bounded page. Invalid measurements become gaps, never fabricated percentages. */
export function parseHistoryPage(value: unknown, query: QuotaHistoryQuery): QuotaHistoryPage {
  validateQuery(query);
  const data = object(value);
  if (
    data.schema_version !== 1 ||
    !Array.isArray(data.samples) ||
    data.samples.length > query.limit
  )
    invalid();
  const samples = data.samples.map((raw): QuotaHistorySample => {
    const row = object(raw);
    const observedAt = instant(row.observed_at);
    const sampleProvider = provider(row.provider);
    if (
      observedAt < query.from ||
      observedAt > query.to ||
      (query.provider && query.provider !== sampleProvider)
    )
      invalid();
    if (row.identity_quality !== 'provider' && row.identity_quality !== 'credential') invalid();
    if (row.state !== 'ok' && row.state !== 'unknown') invalid();
    if (row.source !== 'management-api') invalid();
    const used = row.used_percent;
    const usedPercent =
      typeof used === 'number' && Number.isFinite(used) && used >= 0 && used <= 100 ? used : null;
    const period = row.period_seconds;
    const periodSeconds =
      typeof period === 'number' && Number.isFinite(period) && period > 0 ? period : null;
    return {
      observedAt,
      provider: sampleProvider,
      accountId: text(row.account_id),
      authIndex: text(row.auth_index),
      identityQuality: row.identity_quality,
      limitId: text(row.limit_id),
      seriesId: text(row.series_id),
      periodSeconds,
      resetAt: nullableInstant(row.reset_at),
      usedPercent,
      state: row.state === 'ok' && usedPercent !== null ? 'ok' : 'unknown',
      reason: row.reason === null ? null : text(row.reason, 128),
    };
  });
  return { samples, nextCursor: data.next_cursor === null ? null : text(data.next_cursor, 4096) };
}

/** Pin authentication and suppress stale response effects after logout or a connection switch. */
export function createQuotaHistoryClient(isCurrent: () => boolean): QuotaHistoryClient {
  const revision = apiClient.getConnectionRevision();
  const current = () => isCurrent() && apiClient.getConnectionRevision() === revision;
  const client = apiClient.captureConnection(isCurrent);
  const assertCurrent = () => {
    if (!current()) throw new DOMException('Stale quota history request', 'AbortError');
  };
  return {
    async capabilities(signal) {
      assertCurrent();
      try {
        const result = await client.get<unknown>('/quota-history/capabilities', {
          signal,
          timeout: 15000,
        });
        assertCurrent();
        return parseHistoryCapabilities(result);
      } catch (error) {
        assertCurrent();
        if (isRecord(error) && (error.status === 404 || error.status === 501)) {
          throw new UnsupportedQuotaHistory('Quota history is not installed');
        }
        throw error;
      }
    },
    async page(query, signal) {
      assertCurrent();
      validateQuery(query);
      const result = await client.get<unknown>('/quota-history', {
        signal,
        timeout: 15000,
        params: {
          provider: query.provider,
          from: new Date(query.from).toISOString(),
          to: new Date(query.to).toISOString(),
          limit: query.limit,
          ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
        },
      });
      assertCurrent();
      return parseHistoryPage(result, query);
    },
  };
}
