import { useEffect, useState } from 'react';
import { useQuotaStore } from '@/stores/useQuotaStore';
import type { QuotaFileEntry } from '../logic';
import { QUOTA_ADAPTERS, getQuotaMap } from '../providers';
import { getQuotaCacheKey } from '@/utils/quota/identity';
import { QUOTA_REVALIDATE_AFTER_MS, selectAutoRevalidateTargets } from '../autoRevalidate';

export type QuotaBackgroundLoader = (
  targets: QuotaFileEntry[],
  options?: { background?: boolean }
) => Promise<void>;

const isVisible = () => typeof document === 'undefined' || document.visibilityState === 'visible';

/**
 * Show cached readings immediately and refresh stale or missing ones in the
 * background, only while the tab is visible. No interval polling: a pass runs on
 * mount, when entries change, when the tab becomes visible again, and once per
 * staleness interval while the page stays open.
 */
export function useQuotaAutoRevalidate(
  entries: QuotaFileEntry[],
  disabled: boolean,
  loadQuota: QuotaBackgroundLoader
) {
  const session = useQuotaStore((state) => state.cacheGeneration);
  const fileGenerations = useQuotaStore((state) => state.fileGenerations);
  const [wake, setWake] = useState(0);

  useEffect(() => {
    const onVisibility = () => {
      if (isVisible()) setWake((value) => value + 1);
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);

  useEffect(() => {
    if (disabled || !isVisible()) return;
    const targets = selectAutoRevalidateTargets(entries, {
      stateFor: (entry) => getQuotaMap(QUOTA_ADAPTERS[entry.type])[getQuotaCacheKey(entry.file)],
      session,
      fileGenerations,
      nowMs: Date.now(),
    });
    if (targets.length > 0) void loadQuota(targets, { background: true });
    // One timer per pass, cleared on any change or unmount; it only re-checks staleness.
    const timer = window.setTimeout(() => setWake((value) => value + 1), QUOTA_REVALIDATE_AFTER_MS);
    return () => window.clearTimeout(timer);
  }, [disabled, entries, fileGenerations, loadQuota, session, wake]);
}
