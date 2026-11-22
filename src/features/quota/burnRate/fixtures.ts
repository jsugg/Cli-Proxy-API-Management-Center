import { initialHistoryState, type QuotaHistoryState } from '../history/session';
import type { QuotaHistorySample } from '../history/types';
import { BURN_HISTORY_MS, DAY_MS } from './model';

export const BURN_PREVIEW_NOW = Date.parse('2026-11-21T12:00:00Z');
export const BURN_PREVIEW_MODES = [
  'ready',
  'collecting',
  'stale',
  'partial',
  'failure',
  'error',
  'unsupported',
  'loading',
] as const;
export type BurnPreviewMode = (typeof BURN_PREVIEW_MODES)[number];
/** Synthetic percentages and opaque identities only. Never mounts a network loader. */
export function burnRateFixture(mode: BurnPreviewMode): QuotaHistoryState {
  const now = BURN_PREVIEW_NOW;
  const samples: QuotaHistorySample[] = [];
  for (const [provider, count] of [
    ['claude', 4],
    ['codex', 3],
    ['xai', 1],
  ] as const) {
    for (let account = 0; account < count; account++) {
      for (const limitId of provider === 'claude' ? ['seven-day', 'seven-day-fable'] : ['weekly']) {
        for (let ago = BURN_HISTORY_MS; ago >= 0; ago -= 5 * 60000) {
          const at = now - ago;
          const pastReset =
            now - (provider === 'claude' && account < 2 ? 2.4 : 5.2) * DAY_MS + account * 3600000;
          const reset = at < pastReset ? pastReset : pastReset + 7 * DAY_MS;
          const used = Math.max(
            0,
            Math.min(
              100,
              ((at - (reset - 7 * DAY_MS)) / DAY_MS) *
                (limitId.includes('fable') ? 17 : provider === 'xai' ? 14 : 9) +
                account * 2
            )
          );
          // One unrated subscription exercises honest partial coverage.
          if (provider === 'codex' && account === 2 && ago > 0) continue;
          samples.push({
            observedAt: at,
            provider,
            accountId: `synthetic-${provider}-${account}`,
            authIndex: `synthetic-${account}`,
            identityQuality: provider === 'codex' ? 'credential' : 'provider',
            limitId,
            seriesId: `${limitId}-${reset}`,
            periodSeconds: 7 * 86400,
            resetAt: reset,
            usedPercent: used,
            state: 'ok',
            reason: null,
          });
        }
      }
    }
  }
  return {
    ...initialHistoryState(),
    status: mode === 'loading' || mode === 'unsupported' || mode === 'error' ? mode : 'ready',
    samples: mode === 'collecting' ? [] : samples,
    from: now - BURN_HISTORY_MS,
    to: now,
    pages: 5,
    complete: mode !== 'partial',
    capped: mode === 'partial',
    capabilities: {
      pollIntervalSeconds: 300,
      retentionDays: 30,
      providers: ['claude', 'codex', 'xai'],
      maxQueryDays: 30,
      maxPageSize: 2000,
      status: {
        startedAt: now - BURN_HISTORY_MS,
        lastPollAt: now,
        lastSuccessAt: now,
        lastSampleAt: now,
        consecutiveFailures: mode === 'failure' ? 1 : 0,
        lastError: mode === 'failure' ? 'synthetic-failure' : null,
        stale: mode === 'stale',
      },
    },
  };
}
