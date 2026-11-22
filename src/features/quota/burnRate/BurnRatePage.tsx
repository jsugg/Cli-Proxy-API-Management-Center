import { useQuotaHistory } from '../history/useQuotaHistory';
import { BURN_HISTORY_MS } from './model';
import { BurnRateView } from './BurnRateView';

export function BurnRatePage() {
  const { state, connected, refresh } = useQuotaHistory(undefined, BURN_HISTORY_MS, true, {
    maxPages: 30,
    loadAll: true,
    incremental: true,
  });
  return <BurnRateView state={state} connected={connected} onRefresh={refresh} />;
}
