import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNow } from '@/hooks/useNow';
import { formatRelativeInstant } from '@/utils/quota';
import type { QuotaFileEntry } from '../logic';
import type { QuotaCardState } from '../providers';
import { buildQuotaPools } from '../pool';
import styles from './QuotaPoolSummary.module.scss';

interface QuotaPoolSummaryProps {
  entries: readonly QuotaFileEntry[];
  quotaFor: (entry: QuotaFileEntry) => QuotaCardState | undefined;
  now?: number;
}

export function QuotaPoolSummary({ entries, quotaFor, now: fixedNow }: QuotaPoolSummaryProps) {
  const { t, i18n } = useTranslation();
  const tick = useNow(fixedNow === undefined);
  const [receiptTime, setReceiptTime] = useState(0);
  // A response can arrive after the shared clock's last minute tick.
  useEffect(() => setReceiptTime(Date.now()), [entries, quotaFor]);
  const now = fixedNow ?? Math.max(tick, receiptTime);
  const pools = buildQuotaPools(entries, quotaFor, now);
  if (!pools.length) return null;
  return (
    <section aria-label={t('quota_pool.title')}>
      <div className={styles.grid}>
        {pools.map((pool) => (
          <article className={styles.card} key={pool.provider}>
            <header className={styles.heading}>
              <h2>{pool.provider === 'claude' ? 'Claude' : 'Codex'}</h2>
              <span>{t('quota_pool.accounts', { count: pool.total })}</span>
            </header>
            {pool.windows.map((window) => (
              <div className={styles.limit} key={JSON.stringify([window.id, window.periodHours])}>
                <div className={styles.heading}>
                  <span>
                    {window.label || (window.labelKey ? t(window.labelKey) : window.id)}
                    {window.periodHours !== null &&
                      ` · ${t('quota_pool.period', { hours: window.periodHours })}`}
                  </span>
                  <strong>
                    {window.remainingPercent === null
                      ? t('quota_pool.unknown')
                      : `${Math.round(window.remainingPercent)}%`}
                  </strong>
                </div>
                <div className={styles.track} aria-hidden="true">
                  {window.remainingPercent !== null && (
                    <span style={{ width: `${window.remainingPercent}%` }} />
                  )}
                </div>
                <div className={styles.meta}>
                  <span>
                    {t('quota_pool.coverage', { known: window.known, total: pool.total })}
                  </span>
                  <span>
                    {window.nextResetAtMs === null
                      ? t('quota_pool.reset_unknown')
                      : t('quota_pool.next_reset', {
                          time: formatRelativeInstant(window.nextResetAtMs, now, i18n.language),
                        })}
                  </span>
                </div>
              </div>
            ))}
          </article>
        ))}
      </div>
      <p className={styles.note}>{t('quota_pool.explanation')}</p>
    </section>
  );
}
