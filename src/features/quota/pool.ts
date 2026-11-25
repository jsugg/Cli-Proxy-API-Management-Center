import type { ClaudeQuotaState, CodexQuotaState, CopilotQuotaState } from '@/types';
import { getQuotaCacheKey } from '@/utils/quota/identity';
import type { QuotaFileEntry } from './logic';
import type { QuotaCardState } from './providers';

export const QUOTA_POOL_MAX_AGE_MS = 15 * 60_000;

export interface QuotaPoolWindow {
  id: string;
  label: string;
  labelKey?: string;
  labelParams?: Record<string, string | number>;
  periodHours: number | null;
  /** Calendar-period windows (Copilot's monthly buckets) have no fixed hour length. */
  periodKey?: string;
  known: number;
  /** Known accounts whose bucket is unlimited; they are excluded from remainingPercent. */
  unlimited?: number;
  /** Known limited accounts with nothing left in the window. */
  exhausted?: number;
  /** Summed request counts across known limited accounts that report an entitlement. */
  used?: number;
  entitlement?: number;
  remainingPercent: number | null;
  nextResetAtMs: number | null;
}

export interface QuotaPool {
  provider: 'claude' | 'codex' | 'copilot';
  total: number;
  windows: QuotaPoolWindow[];
}

export type QuotaPoolWindowIdentity = Pick<
  QuotaPoolWindow,
  'id' | 'label' | 'labelKey' | 'labelParams' | 'periodKey'
> & {
  periodHours?: number | null;
};
export type QuotaPoolWindowMemory = Partial<
  Record<QuotaPool['provider'], readonly QuotaPoolWindowIdentity[]>
>;

/** Compare independent limits using unweighted percentages, never token capacity. */
export function buildQuotaPools(
  entries: readonly QuotaFileEntry[],
  quotaFor: (entry: QuotaFileEntry) => QuotaCardState | undefined,
  now: number,
  rememberedWindows: QuotaPoolWindowMemory = {}
): QuotaPool[] {
  return (['claude', 'codex', 'copilot'] as const).flatMap((provider) => {
    const accounts = enabledAccounts(entries, provider);
    if (!accounts.length) return [];
    if (provider === 'copilot')
      return [buildCopilotPool(accounts, quotaFor, now, rememberedWindows.copilot)];
    const groups = new Map<string, QuotaPoolWindow>();
    const ensureWindow = (window: QuotaPoolWindowIdentity): QuotaPoolWindow => {
      const periodHours =
        typeof window.periodHours === 'number' &&
        Number.isFinite(window.periodHours) &&
        window.periodHours > 0
          ? window.periodHours
          : null;
      const key = JSON.stringify([window.id, periodHours]);
      let group = groups.get(key);
      if (!group) {
        group = {
          id: window.id,
          label: window.label,
          labelKey: window.labelKey,
          labelParams: window.labelParams,
          periodHours,
          known: 0,
          remainingPercent: null,
          nextResetAtMs: null,
        };
        groups.set(key, group);
      }
      return group;
    };
    const states = accounts.map(
      (account) => quotaFor(account) as ClaudeQuotaState | CodexQuotaState | undefined
    );
    const loadedStates = states.filter(
      (state): state is ClaudeQuotaState | CodexQuotaState => state?.status === 'success'
    );
    // Until the first successful load, retain the usual unknown rows. After that,
    // only provider-reported windows define which limits exist.
    const remembered = rememberedWindows[provider];
    if (!loadedStates.length && states.some((state) => state?.status === 'loading') && remembered) {
      remembered.forEach(ensureWindow);
    } else if (!loadedStates.length) {
      for (const [id, periodHours, labelKey] of [
        [
          'five-hour',
          5,
          provider === 'claude' ? 'claude_quota.five_hour' : 'codex_quota.primary_window',
        ],
        [
          provider === 'claude' ? 'seven-day' : 'weekly',
          168,
          provider === 'claude' ? 'claude_quota.seven_day' : 'codex_quota.secondary_window',
        ],
      ] as const) {
        ensureWindow({ id, periodHours, label: '', labelKey });
      }
    }
    for (const state of loadedStates) {
      const observedAt = Date.parse(state.observedAt ?? '');
      const fresh =
        state.status === 'success' &&
        !('stale' in state && state.stale) &&
        Number.isFinite(observedAt) &&
        observedAt <= now &&
        now - observedAt <= QUOTA_POOL_MAX_AGE_MS;
      const accountGroups = new Set<QuotaPoolWindow>();
      for (const window of state.windows ?? []) {
        const group = ensureWindow(window);
        if (accountGroups.has(group)) continue;
        accountGroups.add(group);
        const used = window.usedPercent;
        const reset = window.resetAtMs;
        if (
          !fresh ||
          typeof used !== 'number' ||
          !Number.isFinite(used) ||
          used < 0 ||
          used > 100 ||
          typeof reset !== 'number' ||
          !Number.isFinite(reset) ||
          reset <= now ||
          typeof window.periodHours !== 'number' ||
          !Number.isFinite(window.periodHours) ||
          window.periodHours <= 0
        )
          continue;
        group.remainingPercent =
          ((group.remainingPercent ?? 0) * group.known + 100 - used) / (group.known + 1);
        group.known += 1;
        group.nextResetAtMs = Math.min(group.nextResetAtMs ?? reset, reset);
      }
    }
    return [{ provider, total: accounts.length, windows: [...groups.values()] }];
  });
}

function enabledAccounts(
  entries: readonly QuotaFileEntry[],
  provider: QuotaPool['provider']
): QuotaFileEntry[] {
  const seen = new Set<string>();
  return entries.filter((entry) => {
    const key = getQuotaCacheKey(entry.file);
    if (entry.type !== provider || entry.file.disabled || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const isFreshObservation = (observedAtText: string | undefined, now: number): boolean => {
  const observedAt = Date.parse(observedAtText ?? '');
  return (
    Number.isFinite(observedAt) && observedAt <= now && now - observedAt <= QUOTA_POOL_MAX_AGE_MS
  );
};

const COPILOT_POOL_WINDOWS = {
  premium_interactions: 'copilot_quota.bucket_premium_interactions',
  chat: 'copilot_quota.bucket_chat',
  completions: 'copilot_quota.bucket_completions',
} as const;

/**
 * Copilot buckets are monthly request allowances. Unlimited seats are counted,
 * not averaged in. Limited seats pool their request counts when every one
 * reports them, else fall back to the mean of their remaining percentages.
 */
function buildCopilotPool(
  accounts: readonly QuotaFileEntry[],
  quotaFor: (entry: QuotaFileEntry) => QuotaCardState | undefined,
  now: number,
  remembered: readonly QuotaPoolWindowIdentity[] | undefined
): QuotaPool {
  const groups = new Map<string, QuotaPoolWindow>();
  const ensureWindow = (id: string): QuotaPoolWindow => {
    let group = groups.get(id);
    if (!group) {
      group = {
        id,
        label: '',
        labelKey: COPILOT_POOL_WINDOWS[id as keyof typeof COPILOT_POOL_WINDOWS],
        periodHours: null,
        periodKey: 'quota_pool.monthly',
        known: 0,
        unlimited: 0,
        exhausted: 0,
        used: 0,
        entitlement: 0,
        remainingPercent: null,
        nextResetAtMs: null,
      };
      groups.set(id, group);
    }
    return group;
  };
  const percentTotals = new Map<QuotaPoolWindow, { sum: number; count: number; counted: number }>();
  const states = accounts.map((account) => quotaFor(account) as CopilotQuotaState | undefined);
  const loaded = states.filter(
    (state): state is CopilotQuotaState =>
      state?.status === 'success' && Boolean(state.data?.buckets?.length)
  );
  if (!loaded.length) {
    const ids =
      states.some((state) => state?.status === 'loading') && remembered?.length
        ? remembered.map((window) => window.id)
        : ['premium_interactions'];
    ids.forEach(ensureWindow);
  }
  for (const state of loaded) {
    const data = state.data!;
    const fresh = isFreshObservation(state.observedAt, now);
    const reset = data.resetAtMs;
    for (const bucket of data.buckets) {
      if (!(bucket.id in COPILOT_POOL_WINDOWS)) continue;
      const group = ensureWindow(bucket.id);
      if (!fresh) continue;
      if (bucket.unlimited) {
        group.unlimited = (group.unlimited ?? 0) + 1;
      } else {
        const percent = bucket.percentRemaining;
        if (
          typeof percent !== 'number' ||
          !Number.isFinite(percent) ||
          percent < 0 ||
          percent > 100
        )
          continue;
        const totals = percentTotals.get(group) ?? { sum: 0, count: 0, counted: 0 };
        totals.sum += percent;
        totals.count += 1;
        if (percent <= 0) group.exhausted = (group.exhausted ?? 0) + 1;
        if (bucket.entitlement !== null && bucket.entitlement > 0 && bucket.remaining !== null) {
          group.entitlement = (group.entitlement ?? 0) + bucket.entitlement;
          group.used = (group.used ?? 0) + Math.max(0, bucket.entitlement - bucket.remaining);
          totals.counted += 1;
        }
        percentTotals.set(group, totals);
      }
      group.known += 1;
      if (typeof reset === 'number' && Number.isFinite(reset) && reset > now)
        group.nextResetAtMs = Math.min(group.nextResetAtMs ?? reset, reset);
    }
  }
  for (const [group, { sum, count, counted }] of percentTotals) {
    const entitlement = group.entitlement ?? 0;
    group.remainingPercent =
      counted === count && entitlement > 0
        ? Math.min(100, Math.max(0, (100 * (entitlement - (group.used ?? 0))) / entitlement))
        : sum / count;
  }
  const order = Object.keys(COPILOT_POOL_WINDOWS);
  const windows = [...groups.values()].sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  return { provider: 'copilot', total: accounts.length, windows };
}

export { maskQuotaIdentity } from '@/utils/quota/identity';
