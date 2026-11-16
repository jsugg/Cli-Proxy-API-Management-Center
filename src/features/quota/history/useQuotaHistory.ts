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

/** Read companion observations automatically; never issue provider probes from the browser. */
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
    void session.refresh();
    const timer = window.setInterval(() => {
      void session.refresh();
    }, HISTORY_REFRESH_MS);
    return () => {
      mounted = false;
      window.clearInterval(timer);
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
