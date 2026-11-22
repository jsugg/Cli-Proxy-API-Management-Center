import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Select';
import { getAuthFileIcon, getTypeLabel } from '@/features/authFiles/constants';
import { useNow } from '@/hooks/useNow';
import { useThemeStore } from '@/stores';
import { burnLimitLabel } from './labels';
import type { QuotaHistoryState } from '../history/session';
import { buildBurnRate, type BurnGroup, type BurnWindow } from './model';
import { BurnRateChart } from './BurnRateChart';
import styles from './BurnRate.module.scss';

export interface BurnRateViewProps {
  state: QuotaHistoryState;
  connected: boolean;
  onRefresh: () => void;
  now?: number;
}
export function BurnRateView({ state, connected, onRefresh, now: fixedNow }: BurnRateViewProps) {
  const { t, i18n } = useTranslation();
  const tick = useNow(fixedNow === undefined);
  const now = fixedNow ?? Math.max(tick, state.to);
  const theme = useThemeStore((s) => s.resolvedTheme);
  const [window, setWindow] = useState<BurnWindow>('long');
  const status = state.capabilities?.status;
  const stale = Boolean(
    status?.stale ||
    (status?.lastSuccessAt != null &&
      now - status.lastSuccessAt >
        Math.max(10 * 60000, 3 * (state.capabilities?.pollIntervalSeconds ?? 300) * 1000))
  );
  const failed = Boolean(status?.lastError || status?.consecutiveFailures);
  const forecastAllowed =
    state.complete && !state.capped && !state.refreshFailed && !stale && !failed;
  const rows = useMemo(
    () =>
      (state.capabilities?.providers ?? []).map((provider) => {
        const samples = state.samples.filter((s) => s.provider === provider);
        return {
          provider,
          count: new Set(samples.map((s) => s.accountId)).size,
          groups: buildBurnRate(
            samples,
            now,
            state.capabilities?.pollIntervalSeconds ?? 300,
            window,
            forecastAllowed
          ),
          credentialIdentity: samples.some((s) => s.identityQuality === 'credential'),
        };
      }),
    [state.samples, state.capabilities, now, window, forecastAllowed]
  );
  const ready = connected && state.status === 'ready';
  const date = (at: number) =>
    new Date(at).toLocaleString(i18n.language, {
      weekday: 'short',
      hour: 'numeric',
      minute: '2-digit',
    });
  return (
    <section className={styles.page}>
      <header className={styles.header}>
        <div>
          <h1>{t('burn_rate.title')}</h1>
          {ready && (
            <p>
              {t('burn_rate.updated', {
                count: rows.reduce((sum, row) => sum + row.count, 0),
                time: date(state.to),
              })}
            </p>
          )}
        </div>
        <div className={styles.controls}>
          <Select
            value={window}
            onChange={(value) => setWindow(value as BurnWindow)}
            size="sm"
            ariaLabel={t('burn_rate.window')}
            fullWidth={false}
            options={(['long', 'short'] as const).map((value) => ({
              value,
              label: t(`burn_rate.${value}`),
            }))}
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
      <p className={styles.note}>{t('burn_rate.description')}</p>
      {!connected ? (
        <p role="status">{t('quota_history.disconnected')}</p>
      ) : state.status !== 'ready' ? (
        <p
          role={state.status === 'error' ? 'alert' : 'status'}
          aria-busy={state.status === 'loading'}
        >
          {t(`quota_history.${state.status}`)}
        </p>
      ) : null}
      {ready && (
        <>
          {stale && (
            <p className={styles.warning} role="status">
              {t('quota_history.collector_stale')}
            </p>
          )}
          {failed && (
            <p className={styles.warning} role="status">
              {t('quota_history.reason_collector_error')}
            </p>
          )}
          {(!state.complete || state.capped) && (
            <p className={styles.warning} role="status">
              {t(state.capped ? 'quota_history.capped' : 'quota_history.partial')}
            </p>
          )}
          {state.refreshFailed && (
            <p className={styles.warning} role="status">
              {t('quota_history.refresh_failed', { time: date(state.to) })}
            </p>
          )}
          <div className={styles.columnHead} aria-hidden="true">
            <span>{t('burn_rate.provider')}</span>
            <span>{t('burn_rate.chart_heading')}</span>
            <span>{t('burn_rate.next_reset')}</span>
          </div>
          {rows.map((row) => {
            const primary = row.groups[0];
            const icon = getAuthFileIcon(row.provider, theme);
            return (
              <article
                className={styles.row}
                key={row.provider}
                aria-label={getTypeLabel(t, row.provider)}
              >
                <div className={styles.meta}>
                  <div className={styles.provider}>
                    {icon ? (
                      <img src={icon} alt="" />
                    ) : (
                      <span className={styles.fallback} aria-hidden="true">
                        {row.provider[0].toUpperCase()}
                      </span>
                    )}
                    <div>
                      <h2>{getTypeLabel(t, row.provider)}</h2>
                      <p>{t('burn_rate.subs', { count: row.count })}</p>
                    </div>
                  </div>
                  {row.groups.length >= 2 && (
                    <ul className={styles.legend}>
                      {row.groups.map((group) => (
                        <li key={group.key}>
                          <i style={{ background: `var(--series-${group.color})` }} />
                          {burnLimitLabel(t, row.provider, group, row.groups)}
                        </li>
                      ))}
                    </ul>
                  )}
                  {row.credentialIdentity && (
                    <p className={styles.note}>{t('burn_rate.aliases')}</p>
                  )}
                </div>
                {primary ? (
                  <>
                    <BurnRateChart groups={row.groups} provider={row.provider} now={now} />
                    <div className={styles.summary}>
                      <ResetSummary group={primary} now={now} date={date} />
                      {primary.rated < primary.contributing && (
                        <p className={styles.note}>
                          {t('burn_rate.coverage', {
                            rated: primary.rated,
                            total: primary.contributing,
                          })}
                        </p>
                      )}
                    </div>
                  </>
                ) : (
                  <p className={styles.empty} role="status">
                    {t(row.count ? 'burn_rate.no_fresh' : 'quota_history.collecting')}
                  </p>
                )}
              </article>
            );
          })}
          {!rows.length && <p role="status">{t('quota_history.collecting')}</p>}
          <p className={styles.note}>{t('burn_rate.assumption')}</p>
        </>
      )}
    </section>
  );
}
function ResetSummary({
  group,
  now,
  date,
}: {
  group: BurnGroup;
  now: number;
  date: (at: number) => string;
}) {
  const { t, i18n } = useTranslation();
  const minutes = Math.max(0, Math.ceil((group.nextReset - now) / 60000));
  const elapsed = Math.max(
    0,
    Math.min(1, 1 - (group.nextReset - now) / (group.periodSeconds * 1000))
  );
  const danger = group.earliestExhaustion !== null;
  const percent = (value: number) =>
    value.toLocaleString(i18n.language, { maximumFractionDigits: 1 });
  return (
    <>
      <div className={styles.reset}>
        <svg className={styles.ring} viewBox="0 0 40 40" aria-hidden="true">
          <circle cx="20" cy="20" r="16" className={styles.ringBase} />
          <circle
            cx="20"
            cy="20"
            r="16"
            pathLength="100"
            strokeDasharray={`${elapsed * 100} 100`}
            transform="rotate(-90 20 20)"
            style={{ stroke: `var(--series-${group.color})` }}
          />
        </svg>
        <div>
          <strong>
            {t('burn_rate.countdown', {
              days: Math.floor(minutes / 1440),
              hours: Math.floor(minutes / 60) % 24,
              minutes: minutes % 60,
            })}
          </strong>
          <p>{date(group.nextReset)}</p>
        </div>
      </div>
      <p className={styles.status}>
        <i
          className={
            danger
              ? styles.danger
              : group.leftAtReset !== null && group.leftAtReset <= 25
                ? styles.good
                : styles.amber
          }
        />
        {danger
          ? group.earliestExhaustion! <= now
            ? t('quota_reset.window_exhausted')
            : t('burn_rate.runs_out', { time: date(group.earliestExhaustion!) })
          : group.leftAtReset === null
            ? t('burn_rate.no_forecast')
            : t('burn_rate.left', { value: percent(group.leftAtReset) })}
      </p>
      <p>
        {group.ratePerDay === null
          ? t('burn_rate.no_rate')
          : t('burn_rate.rate', { value: percent(group.ratePerDay) })}
      </p>
    </>
  );
}
