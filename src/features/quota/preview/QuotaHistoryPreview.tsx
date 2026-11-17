import { useMemo, useState } from 'react';
import { Select } from '@/components/ui/Select';
import type { QuotaFileEntry } from '../logic';
import { QuotaHistoryView } from '../history/QuotaHistoryView';
import { initialHistoryState, type QuotaHistoryState } from '../history/session';
import type { QuotaHistorySample } from '../history/types';
import { identityPreviewFile } from './identityFixtures';

const MODES = [
  'ready',
  'collecting',
  'first',
  'unsupported',
  'partial',
  'stale',
  'gaps',
  'flat',
  'failure',
] as const;
type PreviewMode = (typeof MODES)[number];
const entries: QuotaFileEntry[] = (['claude', 'codex'] as const).flatMap((provider) =>
  [0, 1, 2].map((index) => ({
    type: provider,
    file: {
      ...identityPreviewFile(provider, index),
      authIndex: `preview-${provider}-${index + 1}`,
    },
  }))
);

function fixture(mode: PreviewMode, rangeHours: number): QuotaHistoryState {
  const to = Date.now();
  const sample = (
    ago: number,
    used: number,
    provider: 'claude' | 'codex',
    account = 0
  ): QuotaHistorySample => ({
    observedAt: to - ago * 60000,
    provider,
    accountId: `${provider}-opaque-example-${account + 1}`,
    authIndex: `preview-${provider}-${account + 1}`,
    identityQuality: provider === 'claude' ? 'provider' : 'credential',
    limitId: provider === 'claude' ? 'seven-day' : 'weekly',
    seriesId: `${provider}-window-example-${account + 1}`,
    periodSeconds: 604800,
    resetAt: to + 45 * 60000,
    usedPercent: used,
    state: 'ok',
    reason: null,
  });
  let samples = (['claude', 'codex'] as const).flatMap((provider) =>
    [0, 1, 2].flatMap((account) =>
      Array.from({ length: 10 }, (_, i) =>
        sample(45 - i * 5, mode === 'flat' ? 50 : 20 + i * 4 + account * 5, provider, account)
      )
    )
  );
  if (mode === 'first') samples = [sample(0, 20, 'claude')];
  if (mode === 'gaps')
    samples = samples.map((row, index) =>
      index === 6
        ? {
            ...row,
            state: 'unknown',
            usedPercent: null,
            periodSeconds: null,
            resetAt: null,
            reason: 'missing_window',
          }
        : index < 3
          ? { ...row, seriesId: 'previous-reset', usedPercent: (row.usedPercent ?? 0) + 30 }
          : row
    );
  if (mode === 'collecting' || mode === 'unsupported') samples = [];
  return {
    ...initialHistoryState(),
    status: mode === 'unsupported' ? 'unsupported' : 'ready',
    from: to - rangeHours * 3600000,
    to,
    pages: 1,
    samples,
    complete: mode !== 'partial',
    nextCursor: mode === 'partial' ? 'fixture-next' : null,
    capabilities: {
      pollIntervalSeconds: 300,
      retentionDays: 30,
      providers: ['claude', 'codex'],
      maxQueryDays: 30,
      maxPageSize: 2000,
      status: {
        startedAt: to - 3600000,
        lastPollAt: to,
        lastSuccessAt: mode === 'collecting' ? null : to,
        lastSampleAt: samples.length ? to : null,
        consecutiveFailures: mode === 'failure' ? 1 : 0,
        lastError: mode === 'failure' ? 'enumeration_failed' : null,
        stale: mode === 'stale',
      },
    },
  };
}

/** Development-only real components with synthetic observations and no backend calls. */
export function QuotaHistoryPreview({ showEmails }: { showEmails: boolean }) {
  const [mode, setMode] = useState<PreviewMode>('ready');
  const [rangeHours, setRangeHours] = useState(1);
  const [revision, setRevision] = useState(0);
  const state = useMemo(() => {
    void revision;
    return fixture(mode, rangeHours);
  }, [mode, rangeHours, revision]);
  return (
    <div>
      <Select
        value={mode}
        options={MODES.map((value) => ({ value, label: `History fixture: ${value}` }))}
        ariaLabel="Synthetic history state"
        onChange={(value) => {
          if (MODES.includes(value as PreviewMode)) setMode(value as PreviewMode);
        }}
      />
      <QuotaHistoryView
        state={state}
        connected
        entries={entries}
        showEmails={showEmails}
        rangeHours={rangeHours}
        onRangeChange={setRangeHours}
        onRefresh={() => setRevision((value) => value + 1)}
        onLoadMore={() => setMode('ready')}
        now={state.to}
      />
    </div>
  );
}
