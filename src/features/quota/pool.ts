import type { ClaudeQuotaState, CodexQuotaState } from '@/types';
import { getQuotaCacheKey } from '@/utils/quota/identity';
import type { QuotaFileEntry } from './logic';
import type { QuotaCardState } from './providers';

export const QUOTA_POOL_MAX_AGE_MS = 15 * 60_000;

export interface QuotaPoolWindow {
  id: string;
  label: string;
  labelKey?: string;
  periodHours: number | null;
  known: number;
  remainingPercent: number | null;
  nextResetAtMs: number | null;
}

export interface QuotaPool {
  provider: 'claude' | 'codex';
  total: number;
  windows: QuotaPoolWindow[];
}

export type QuotaPoolWindowIdentity = Pick<QuotaPoolWindow, 'id' | 'label' | 'labelKey'> & {
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
  return (['claude', 'codex'] as const).flatMap((provider) => {
    const seen = new Set<string>();
    const accounts = entries.filter((entry) => {
      const key = getQuotaCacheKey(entry.file);
      if (entry.type !== provider || entry.file.disabled || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    if (!accounts.length) return [];
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

export { maskQuotaIdentity } from '@/utils/quota/identity';
