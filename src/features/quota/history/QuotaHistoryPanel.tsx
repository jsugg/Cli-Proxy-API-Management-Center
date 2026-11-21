import { useState } from 'react';
import type { QuotaFileEntry } from '../logic';
import type { HistoryProvider } from './types';
import { QuotaHistoryView } from './QuotaHistoryView';
import { useQuotaHistory } from './useQuotaHistory';

export function QuotaHistoryPanel({
  provider,
  enabled,
  entries,
  showEmails,
}: {
  provider?: HistoryProvider;
  enabled: boolean;
  entries: readonly QuotaFileEntry[];
  showEmails: boolean;
}) {
  const [rangeHours, setRangeHours] = useState(24);
  const { state, refresh, loadMore, connected } = useQuotaHistory(
    provider,
    rangeHours * 3600000,
    enabled
  );
  if (!enabled || (provider && state.status === 'unsupported')) return null;
  return (
    <QuotaHistoryView
      state={state}
      connected={connected}
      entries={entries}
      showEmails={showEmails}
      rangeHours={rangeHours}
      onRangeChange={setRangeHours}
      onRefresh={refresh}
      onLoadMore={loadMore}
    />
  );
}
