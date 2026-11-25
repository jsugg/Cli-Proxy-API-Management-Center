import { captureApiCallApi, type ApiCallResult } from '@/services/api/apiCall';
import { authFilesApi } from '@/services/api/authFiles';
import { apiClient } from '@/services/api/client';
import { captureQuotaCacheGeneration, commitIfQuotaCacheCurrent } from '@/stores/useQuotaStore';
import type {
  CopilotQuotaBucket,
  CopilotQuotaBucketId,
  CopilotQuotaData,
  CopilotQuotaState,
} from '@/types';
import { normalizeAuthIndex } from '@/utils/authIndex';
import { isRecord } from '@/utils/helpers';
import {
  isDisabledAuthFile,
  isPluginQuotaFile,
  normalizeNumberValue,
  resolveAuthProvider,
} from '@/utils/quota';
import type { QuotaProviderData } from '../types';

function parseAmount(value: unknown): number | null {
  const amount = normalizeNumberValue(value);
  return amount !== null && amount >= 0 ? amount : null;
}

const COPILOT_BUCKET_IDS: readonly CopilotQuotaBucketId[] = [
  'premium_interactions',
  'chat',
  'completions',
];
const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9_-]{0,98}[A-Za-z0-9])?$/;
const PLAN = /^[a-z0-9_-]{1,40}$/i;

function parseBucket(id: CopilotQuotaBucketId, raw: unknown): CopilotQuotaBucket | null {
  if (!isRecord(raw)) return null;
  if (raw.unlimited === true)
    return { id, unlimited: true, percentRemaining: null, remaining: null, entitlement: null };
  const percentRemaining = parseAmount(raw.percent_remaining);
  if (percentRemaining === null || percentRemaining > 100) return null;
  return {
    id,
    unlimited: false,
    percentRemaining,
    remaining: parseAmount(raw.quota_remaining ?? raw.remaining),
    entitlement: parseAmount(raw.entitlement),
  };
}

function parseResetAt(body: Record<string, unknown>): number | null {
  for (const value of [body.quota_reset_date_utc, body.quota_reset_date]) {
    if (typeof value !== 'string' || !value.trim()) continue;
    const text = value.trim();
    const ms = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(text) ? `${text}T00:00:00Z` : text);
    if (Number.isFinite(ms)) return ms;
  }
  return null;
}

/** Keep only quota/display fields from GitHub's `copilot_internal/user` response. */
export function parseCopilotQuota(body: unknown): CopilotQuotaData | null {
  if (!isRecord(body) || !isRecord(body.quota_snapshots)) return null;
  const snapshots = body.quota_snapshots;
  const buckets = COPILOT_BUCKET_IDS.map((id) => parseBucket(id, snapshots[id])).filter(
    (bucket): bucket is CopilotQuotaBucket => bucket !== null
  );
  if (!buckets.length) return null;
  const premium = snapshots.premium_interactions;
  const login = typeof body.login === 'string' ? body.login.trim() : '';
  const plan = typeof body.copilot_plan === 'string' ? body.copilot_plan.trim() : '';
  return {
    buckets,
    resetAtMs: parseResetAt(body),
    plan: PLAN.test(plan) ? plan : null,
    login: GITHUB_LOGIN.test(login) ? login : null,
    creditsUsed: isRecord(premium) ? parseAmount(premium.credits_used) : null,
  };
}

export const COPILOT_CONFIG: QuotaProviderData<CopilotQuotaState, CopilotQuotaData> = {
  type: 'copilot',
  i18nPrefix: 'copilot_quota',
  filterFn: (file) =>
    resolveAuthProvider(file) === 'copilot' &&
    !isDisabledAuthFile(file) &&
    !isPluginQuotaFile(file),
  fetchQuota: async (file, t) => {
    // Messages never include transport errors or bodies: they can carry the token or account data.
    const fail = (key: string, params?: Record<string, unknown>) =>
      new Error(t(`copilot_quota.${key}`, params));
    const authIndex = normalizeAuthIndex(file.authIndex ?? file.auth_index);
    if (
      isPluginQuotaFile(file) ||
      !authIndex ||
      !file.name?.trim() ||
      String(file.runtimeOnly ?? file.runtime_only) === 'true'
    ) {
      throw fail('unavailable');
    }
    const revision = apiClient.getConnectionRevision();
    const generation = captureQuotaCacheGeneration(file.name);
    const isCurrent = () =>
      revision === apiClient.getConnectionRevision() &&
      commitIfQuotaCacheCurrent(generation, () => {});
    const client = captureApiCallApi(isCurrent);
    let credential: unknown;
    try {
      credential = JSON.parse(await authFilesApi.downloadText(file.name));
    } catch {
      throw fail('credential_unreadable');
    }
    if (!isCurrent()) throw fail('unavailable');
    if (!isRecord(credential) || credential.type !== 'copilot') throw fail('credential_unreadable');
    // Copilot access_token is for inference; only refresh_token holds the GitHub OAuth token.
    const token = credential.refresh_token;
    if (typeof token !== 'string' || !/^[A-Za-z0-9._~-]+$/.test(token)) throw fail('no_token');
    let result: ApiCallResult;
    try {
      result = await client.request({
        authIndex,
        method: 'GET',
        url: 'https://api.github.com/copilot_internal/user',
        header: {
          Authorization: `Bearer ${token}`,
          'User-Agent': 'copilot/1.0.114',
          Accept: 'application/json',
        },
      });
    } catch {
      throw fail('request_failed');
    }
    if (!isCurrent()) throw fail('unavailable');
    const status = result.statusCode;
    if (status === 401 || status === 403) throw fail('token_rejected', { status });
    if (status < 200 || status >= 300) throw fail('http_error', { status });
    const data = parseCopilotQuota(result.body);
    if (!data) throw fail('no_data');
    return data;
  },
  storeSelector: (state) => state.copilotQuota,
  storeSetter: 'setCopilotQuota',
  buildLoadingState: () => ({ status: 'loading' }),
  buildSuccessState: (data) => ({ status: 'success', data, observedAt: new Date().toISOString() }),
  buildErrorState: (error, errorStatus) => ({ status: 'error', error, errorStatus }),
};
