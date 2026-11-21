import { useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Select';
import { useNow } from '@/hooks/useNow';
import { normalizeAuthIndex } from '@/utils/authIndex';
import { createQuotaLabelResolver, type QuotaLabelResolver } from '@/utils/quota/identity';
import type { QuotaFileEntry } from '../logic';
import {
  analyzeQuotaHistory,
  buildHistoryTracks,
  rankHistoryTracks,
  selectHistoryTrack,
  type HistoryTrack,
  type TrackOverview,
} from './model';
import { buildHistoryPlot } from './plot';
import { historyLimitLabel, historyProviderLabel } from './labels';
import type { QuotaHistoryState } from './session';
import styles from './QuotaHistoryView.module.scss';

export const HISTORY_RANGE_HOURS = [6, 24, 72, 168] as const;

export interface QuotaHistoryViewProps {
  state: QuotaHistoryState;
  connected: boolean;
  entries: readonly QuotaFileEntry[];
  showEmails?: boolean;
  rangeHours: number;
  onRangeChange: (hours: number) => void;
  onRefresh: () => void;
  onLoadMore: () => void;
  now?: number;
}

function accountLabel(
  track: HistoryTrack,
  entries: readonly QuotaFileEntry[],
  labelForFile: QuotaLabelResolver
): string {
  const indexes = new Set(track.samples.map((sample) => sample.authIndex));
  const match = entries.find(
    (entry) =>
      entry.type === track.provider &&
      indexes.has(normalizeAuthIndex(entry.file.authIndex ?? entry.file['auth_index']) ?? '')
  );
  return match
    ? labelForFile(match.file)
    : `${track.accountId.slice(0, 8)}…${track.accountId.slice(-4)}`;
}

export function QuotaHistoryView({
  state,
  connected,
  entries,
  showEmails = false,
  rangeHours,
  onRangeChange,
  onRefresh,
  onLoadMore,
  now: fixedNow,
}: QuotaHistoryViewProps) {
  const { t, i18n } = useTranslation();
  const tick = useNow(fixedNow === undefined);
  const now = fixedNow ?? Math.max(tick, state.to);
  const titleId = useId();
  const descriptionId = useId();
  const [selectedKey, setSelectedKey] = useState('');
  const labelForFile = useMemo(
    () =>
      createQuotaLabelResolver(
        entries.map((entry) => entry.file),
        showEmails
      ),
    [entries, showEmails]
  );
  const tracks = useMemo(() => buildHistoryTracks(state.samples), [state.samples]);
  const ranked = useMemo(() => rankHistoryTracks(tracks, now), [tracks, now]);
  const unreadable = tracks.length - ranked.length;
  const overview = selectHistoryTrack(ranked, selectedKey);
  const track = overview?.track;
  const analysis = analyzeQuotaHistory(
    track?.samples ?? [],
    now,
    state.complete,
    track?.periodBoundaries
  );
  const collectorStale = Boolean(
    state.capabilities?.status.stale &&
    (state.capabilities.status.lastSuccessAt !== null || state.samples.length > 0)
  );
  const collectorError = Boolean(
    state.capabilities?.status.lastError || state.capabilities?.status.consecutiveFailures
  );
  const forecast = collectorStale || collectorError ? null : analysis.projection;
  const plot = buildHistoryPlot(track?.samples ?? [], track?.periodBoundaries);
  const remaining = overview?.latestRemaining ?? null;
  const end = Math.max(state.to, now, forecast?.endAt ?? 0);
  const duration = Math.max(1, end - state.from);
  const x = (time: number) => Math.min(100, Math.max(0, ((time - state.from) / duration) * 100));
  const y = (used: number | null) => used ?? 100;
  const formatTime = (time: number) =>
    new Date(time).toLocaleString(i18n.language, {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  const formatPercent = (value: number) =>
    `${value.toLocaleString(i18n.language, { maximumFractionDigits: 1 })}%`;
  const trackLabel = (item: HistoryTrack) =>
    `${historyProviderLabel(t, item.provider)} · ${accountLabel(item, entries, labelForFile)} · ${historyLimitLabel(t, item.provider, item.limitId)} · ${
      item.periodSeconds === null
        ? t('quota_history.period_unknown')
        : t('quota_pool.period', { hours: item.periodSeconds / 3600 })
    }`;
  const ready = connected && state.status === 'ready';
  const reason = collectorError ? 'collector_error' : collectorStale ? 'stale' : analysis.reason;
  return (
    <section className={styles.panel} aria-labelledby={titleId}>
      <header className={styles.header}>
        <div>
          <h2 id={titleId}>{t('quota_history.title')}</h2>
          <p>{t('quota_history.subtitle')}</p>
        </div>
        <div className={styles.controls}>
          <Select
            value={String(rangeHours)}
            onChange={(value) => onRangeChange(Number(value))}
            options={HISTORY_RANGE_HOURS.map((hours) => ({
              value: String(hours),
              label:
                hours > 24 && hours % 24 === 0
                  ? t('quota_history.range_days', { count: hours / 24 })
                  : t('quota_history.range', { hours }),
            }))}
            ariaLabel={t('quota_history.range_label')}
            size="sm"
          />
          <Button
            variant="secondary"
            size="sm"
            onClick={onRefresh}
            disabled={!connected || state.busy}
          >
            {t('quota_history.refresh')}
          </Button>
        </div>
      </header>
      {!connected ? (
        <p role="status">{t('quota_history.disconnected')}</p>
      ) : state.status === 'loading' && !state.samples.length ? (
        <p role="status" aria-busy="true">
          {t('quota_history.loading')}
        </p>
      ) : state.status === 'unsupported' ? (
        <p role="status">{t('quota_history.unsupported')}</p>
      ) : state.status === 'error' ? (
        <p role="alert">{t('quota_history.error')}</p>
      ) : null}
      {ready && (
        <>
          {state.capabilities && (
            <p className={styles.note}>
              {t('quota_history.since', { time: formatTime(state.capabilities.status.startedAt) })}
            </p>
          )}
          {collectorStale && (
            <p role="status" className={styles.warning}>
              {t('quota_history.collector_stale')}
            </p>
          )}
          {collectorError && (
            <p role="status" className={styles.warning}>
              {t('quota_history.reason_collector_error')}
            </p>
          )}
          {!state.complete && (
            <p role="status" className={styles.warning}>
              {t(state.capped ? 'quota_history.capped' : 'quota_history.partial')}
            </p>
          )}
          {state.refreshFailed && (
            <p role="status" className={styles.warning}>
              {t('quota_history.refresh_failed', { time: formatTime(state.to) })}
            </p>
          )}
          {!track ? (
            <p role="status">
              {t(tracks.length ? 'quota_history.no_readings' : 'quota_history.collecting')}
            </p>
          ) : (
            <>
              <HistoryOverview
                items={ranked}
                selectedKey={track.key}
                onSelect={setSelectedKey}
                label={trackLabel}
                formatPercent={formatPercent}
              />
              {unreadable > 0 && (
                <p className={styles.note}>
                  {t('quota_history.unreadable_limits', { count: unreadable })}
                </p>
              )}
              <h3 className={styles.selectedTitle}>{trackLabel(track)}</h3>
              {track.credentialIdentity && (
                <p className={styles.warning}>{t('quota_history.credential_identity')}</p>
              )}
              <dl className={styles.stats}>
                <div>
                  <dt>{t('quota_history.remaining')}</dt>
                  <dd>{remaining === null ? t('quota_pool.unknown') : formatPercent(remaining)}</dd>
                </div>
                <div>
                  <dt>{t('quota_history.burn')}</dt>
                  <dd>
                    {reason === 'ready' && analysis.burnPerHour !== null
                      ? `${analysis.burnPerHour.toLocaleString(i18n.language, { maximumFractionDigits: 2 })} pp/h`
                      : t('quota_pool.unknown')}
                  </dd>
                </div>
                <div>
                  <dt>{t('quota_history.exhaustion')}</dt>
                  <dd>
                    {forecast && analysis.exhaustionAt !== null
                      ? formatTime(analysis.exhaustionAt)
                      : t('quota_pool.unknown')}
                  </dd>
                </div>
              </dl>
              <p role="status" className={styles.note}>
                {t(`quota_history.reason_${reason}`)}
              </p>
              {overview &&
                overview.measurableCount > 1 &&
                overview.minRemaining !== null &&
                overview.maxRemaining !== null && (
                  <p className={styles.note}>
                    {overview.minRemaining === overview.maxRemaining
                      ? t('quota_history.range_flat', {
                          value: formatPercent(overview.minRemaining),
                          count: overview.measurableCount,
                        })
                      : t('quota_history.range_span', {
                          low: formatPercent(overview.minRemaining),
                          high: formatPercent(overview.maxRemaining),
                          count: overview.measurableCount,
                        })}
                  </p>
                )}
              <p className={styles.note}>
                {t('quota_history.evidence', {
                  count: analysis.sampleCount,
                  span: Math.round(analysis.spanMs / 60000),
                  age:
                    analysis.ageMs === null
                      ? t('quota_pool.unknown')
                      : Math.floor(analysis.ageMs / 60000),
                  known: analysis.usableCount,
                  total: analysis.totalCount,
                })}
              </p>
              <div className={styles.chart}>
                <div className={styles.yAxis} aria-hidden="true">
                  <span>100%</span>
                  <span>50%</span>
                  <span>0%</span>
                </div>
                <div className={styles.plot}>
                  <svg
                    viewBox="0 0 100 100"
                    preserveAspectRatio="none"
                    role="img"
                    aria-labelledby={`${titleId} ${descriptionId}`}
                  >
                    <desc id={descriptionId}>{t('quota_history.chart_description')}</desc>
                    {[0, 50, 100].map((value) => (
                      <line
                        key={value}
                        x1="0"
                        x2="100"
                        y1={value}
                        y2={value}
                        className={styles.gridLine}
                        vectorEffect="non-scaling-stroke"
                      />
                    ))}
                    {plot.gaps.map((gap, index) => (
                      <rect
                        key={index}
                        x={x(gap.from)}
                        y="0"
                        width={Math.max(0.4, x(gap.to) - x(gap.from))}
                        height="100"
                        className={styles.gap}
                      >
                        <title>{t('quota_history.gap')}</title>
                      </rect>
                    ))}
                    {plot.changes.map((time) => (
                      <line
                        key={time}
                        x1={x(time)}
                        x2={x(time)}
                        y1="0"
                        y2="100"
                        className={styles.change}
                        vectorEffect="non-scaling-stroke"
                      >
                        <title>{t('quota_history.change')}</title>
                      </line>
                    ))}
                    <line
                      x1={x(now)}
                      x2={x(now)}
                      y1="0"
                      y2="100"
                      className={styles.now}
                      vectorEffect="non-scaling-stroke"
                    >
                      <title>{t('quota_history.now')}</title>
                    </line>
                    {plot.segments.map((segment, index) => (
                      <g key={index} data-history-recorded="">
                        <path
                          d={segment
                            .map(
                              (sample, i) =>
                                `${i ? 'L' : 'M'}${x(sample.observedAt)},${y(sample.usedPercent)}`
                            )
                            .join(' ')}
                          className={styles.recorded}
                          vectorEffect="non-scaling-stroke"
                        />
                        {segment.map((sample) => (
                          // Zero-length round-capped lines stay circular under the stretched viewBox.
                          <line
                            key={sample.observedAt}
                            x1={x(sample.observedAt)}
                            x2={x(sample.observedAt)}
                            y1={y(sample.usedPercent)}
                            y2={y(sample.usedPercent)}
                            vectorEffect="non-scaling-stroke"
                            className={styles.dot}
                            data-history-point=""
                          >
                            <title>{`${formatTime(sample.observedAt)} · ${formatPercent(100 - (sample.usedPercent ?? 0))}`}</title>
                          </line>
                        ))}
                      </g>
                    ))}
                    {forecast && (
                      <path
                        data-history-projected=""
                        d={`M${x(forecast.startAt)},${100 - forecast.remainingAtStart} L${x(forecast.endAt)},${100 - forecast.remainingAtEnd}`}
                        className={styles.projected}
                        strokeDasharray="6 4"
                        vectorEffect="non-scaling-stroke"
                      />
                    )}
                  </svg>
                  <div className={styles.xAxis} aria-hidden="true">
                    <span>{formatTime(state.from)}</span>
                    <span>{formatTime(end)}</span>
                  </div>
                </div>
              </div>
              <div className={styles.legend}>
                <span>{t('quota_history.recorded')}</span>
                <span>{t('quota_history.projected')}</span>
                <span>{t('quota_history.gap')}</span>
                <span>{t('quota_history.change')}</span>
              </div>
              <p className={styles.note}>{t('quota_history.assumption')}</p>
              <details className={styles.details}>
                <summary>{t('quota_history.observations')}</summary>
                <p className={styles.note}>
                  {t('quota_history.table_limit', {
                    shown: Math.min(track.samples.length, 100),
                    total: track.samples.length,
                  })}
                </p>
                <div className={styles.tableScroll}>
                  <table>
                    <thead>
                      <tr>
                        <th>{t('quota_history.observed_at')}</th>
                        <th>{t('quota_history.remaining')}</th>
                        <th>{t('quota_history.reset')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {track.samples.slice(-100).map((sample) => (
                        <tr key={sample.observedAt}>
                          <td>{formatTime(sample.observedAt)}</td>
                          <td>
                            {sample.state === 'ok' && sample.usedPercent !== null
                              ? formatPercent(100 - sample.usedPercent)
                              : t('quota_pool.unknown')}
                          </td>
                          <td>
                            {sample.resetAt === null
                              ? t('quota_pool.unknown')
                              : formatTime(sample.resetAt)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </details>
            </>
          )}
          {!state.complete && !state.capped && (
            <Button variant="secondary" size="sm" onClick={onLoadMore} disabled={state.busy}>
              {t('quota_history.load_more')}
            </Button>
          )}
        </>
      )}
    </section>
  );
}

function HistoryOverview({
  items,
  selectedKey,
  onSelect,
  label,
  formatPercent,
}: {
  items: readonly TrackOverview[];
  selectedKey: string;
  onSelect: (key: string) => void;
  label: (track: HistoryTrack) => string;
  formatPercent: (value: number) => string;
}) {
  const { t } = useTranslation();
  return (
    <div className={styles.overview} role="group" aria-label={t('quota_history.track_label')}>
      {items.map((item) => {
        const selected = item.track.key === selectedKey;
        return (
          <button
            key={item.track.key}
            type="button"
            className={styles.overviewItem}
            aria-pressed={selected}
            onClick={() => onSelect(item.track.key)}
          >
            <span className={styles.overviewLabel}>{label(item.track)}</span>
            <span className={styles.overviewValue}>
              {item.latestRemaining === null
                ? t('quota_pool.unknown')
                : formatPercent(item.latestRemaining)}
            </span>
            <span className={styles.overviewMeter} aria-hidden="true">
              <span style={{ width: `${item.latestRemaining ?? 0}%` }} />
            </span>
            <span className={styles.overviewMeta}>
              {!item.fresh
                ? t('quota_history.overview_stale')
                : item.minRemaining !== null &&
                    item.maxRemaining !== null &&
                    item.maxRemaining > item.minRemaining
                  ? t('quota_history.overview_moved', {
                      low: formatPercent(item.minRemaining),
                      high: formatPercent(item.maxRemaining),
                    })
                  : t('quota_history.overview_flat')}
            </span>
          </button>
        );
      })}
    </div>
  );
}
