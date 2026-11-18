import { useCallback, useEffect, useRef, useState } from 'react';
import { apiClient } from '@/services/api/client';
import { createQuotaHistoryClient } from '@/services/api/quotaHistory';
import { useAuthStore, useQuotaStore } from '@/stores';
import {
  HISTORY_REFRESH_MS,
  QuotaHistorySession,
  initialHistoryState,
  type QuotaHistoryState,
} from './session';
import type { HistoryProvider } from './types';

/**
 * Read companion observations automatically; never issue provider probes from the browser.
 * Refreshes pause while the tab is hidden and resume, once, when it becomes visible.
 */
export function useQuotaHistory(
  provider: HistoryProvider | undefined,
  rangeMs: number,
  enabled: boolean
) {
  const connectionStatus = useAuthStore((state) => state.connectionStatus);
  const generation = useQuotaStore((state) => state.cacheGeneration);
  const revision = apiClient.getConnectionRevision();
  const owner = JSON.stringify([
    revision,
    generation,
    provider,
    rangeMs,
    enabled,
    connectionStatus,
  ]);
  const [snapshot, setSnapshot] = useState<{ owner: string; state: QuotaHistoryState } | null>(
    null
  );
  const sessionRef = useRef<QuotaHistorySession | null>(null);

  useEffect(() => {
    if (!enabled || connectionStatus !== 'connected') return;
    let mounted = true;
    const current = () =>
      mounted &&
      apiClient.getConnectionRevision() === revision &&
      useQuotaStore.getState().cacheGeneration === generation &&
      useAuthStore.getState().connectionStatus === 'connected';
    const session = new QuotaHistorySession({
      provider,
      rangeMs,
      isCurrent: current,
      client: createQuotaHistoryClient(current),
    });
    sessionRef.current = session;
    const unsubscribe = session.subscribe(() =>
      setSnapshot({ owner, state: session.getSnapshot() })
    );
    // Refresh no faster than the collector records, and never while the tab is hidden.
    let timer: number | undefined;
    const schedule = () => {
      window.clearTimeout(timer);
      if (!mounted || document.visibilityState !== 'visible') return;
      const pollMs = (session.getSnapshot().capabilities?.pollIntervalSeconds ?? 0) * 1000;
      timer = window.setTimeout(
        () => {
          void session.refresh().finally(schedule);
        },
        Math.max(HISTORY_REFRESH_MS, pollMs)
      );
    };
    const onVisibility = () => {
      if (!mounted) return;
      if (document.visibilityState !== 'visible') {
        window.clearTimeout(timer);
        return;
      }
      const lastTo = session.getSnapshot().to;
      if (!lastTo || Date.now() - lastTo >= HISTORY_REFRESH_MS) void session.refresh();
      schedule();
    };
    document.addEventListener('visibilitychange', onVisibility);
    void session.refresh().finally(schedule);
    return () => {
      mounted = false;
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibility);
      unsubscribe();
      session.dispose();
      sessionRef.current = null;
    };
  }, [connectionStatus, enabled, generation, owner, provider, rangeMs, revision]);

  const refresh = useCallback(() => {
    void sessionRef.current?.refresh();
  }, []);
  const loadMore = useCallback(() => {
    void sessionRef.current?.loadMore();
  }, []);
  const state = snapshot?.owner === owner ? snapshot.state : initialHistoryState();
  return { state, refresh, loadMore, connected: connectionStatus === 'connected' };
}
