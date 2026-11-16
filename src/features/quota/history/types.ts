export type HistoryProvider = 'claude' | 'codex';

export interface QuotaHistorySample {
  observedAt: number;
  provider: HistoryProvider;
  accountId: string;
  authIndex: string;
  identityQuality: 'provider' | 'credential';
  limitId: string;
  seriesId: string;
  periodSeconds: number | null;
  resetAt: number | null;
  usedPercent: number | null;
  state: 'ok' | 'unknown';
  reason: string | null;
}

export interface QuotaHistoryCapabilities {
  pollIntervalSeconds: number;
  retentionDays: number;
  providers: HistoryProvider[];
  maxQueryDays: number;
  maxPageSize: number;
  status: {
    startedAt: number;
    lastPollAt: number | null;
    lastSuccessAt: number | null;
    lastSampleAt: number | null;
    consecutiveFailures: number;
    lastError: string | null;
    stale: boolean;
  };
}

export interface QuotaHistoryQuery {
  provider?: HistoryProvider;
  from: number;
  to: number;
  limit: number;
  cursor?: string;
}

export interface QuotaHistoryPage {
  samples: QuotaHistorySample[];
  nextCursor: string | null;
}

export interface QuotaHistoryClient {
  capabilities: (signal?: AbortSignal) => Promise<QuotaHistoryCapabilities>;
  page: (query: QuotaHistoryQuery, signal?: AbortSignal) => Promise<QuotaHistoryPage>;
}
