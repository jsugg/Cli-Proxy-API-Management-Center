import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { useNow } from '@/hooks/useNow';
import { formatInstantShort, formatRelativeInstant } from '@/utils/quota';
import { resolveTimeZoneLabel } from '@/utils/time/timezone';
import { PROVIDER_LOGOS } from '../brandLogos';
import { shouldShowSubscriptionSummary } from '../subscriptions';
import type { ProviderGroup } from '../types';
import styles from './ProviderSubscriptionSummary.module.scss';

interface ProviderSubscriptionSummaryProps {
  group: ProviderGroup;
  status: 'loading' | 'ready' | 'error';
}

type Segment = 'active' | 'limited' | 'attention' | 'disabled';
const SEGMENTS: readonly Segment[] = ['active', 'limited', 'attention', 'disabled'];

/** Read-only account availability for one provider; management stays on Auth Files and Quota. */
export function ProviderSubscriptionSummary({ group, status }: ProviderSubscriptionSummaryProps) {
  const { t, i18n } = useTranslation();
  const now = useNow();
  const titleId = useId();
  if (!shouldShowSubscriptionSummary(group.id, group.subscriptions)) return null;
  const summary = group.subscriptions;
  const logo = PROVIDER_LOGOS[group.id];
  const providerName = t(`providersPage.providerNames.${group.id}`);
  const ready = status === 'ready' && summary !== undefined;

  let headline: string;
  if (!ready) {
    headline = t(status === 'error' ? 'providersPage.subscriptions.error' : 'common.loading');
  } else if (summary.total === 0) {
    headline = t('providersPage.subscriptions.none');
  } else {
    headline = t('providersPage.subscriptions.usable', {
      active: summary.active,
      total: summary.total,
    });
  }

  const nextAvailableAt =
    ready && summary.nextAvailableAt !== null && summary.nextAvailableAt > now
      ? summary.nextAvailableAt
      : null;

  return (
    <section className={styles.panel} aria-labelledby={titleId}>
      <header className={styles.header}>
        <div className={styles.titleRow}>
          {logo ? <img src={logo.src} alt="" aria-hidden="true" className={styles.logo} /> : null}
          <div className={styles.titleText}>
            <h2 id={titleId} className={styles.title}>
              {providerName} · {t('providersPage.subscriptions.title')}
            </h2>
            <p
              className={status === 'error' ? styles.headlineError : styles.headline}
              role={status === 'error' ? 'alert' : 'status'}
              aria-busy={status === 'loading' && !ready}
            >
              {headline}
            </p>
          </div>
        </div>
        <nav className={styles.actions} aria-label={t('providersPage.subscriptions.actions')}>
          <Link className="btn btn-secondary btn-sm" to="/auth-files">
            {t('providersPage.subscriptions.manage')}
          </Link>
          <Link className="btn btn-secondary btn-sm" to="/quota">
            {t('providersPage.subscriptions.viewQuota')}
          </Link>
        </nav>
      </header>

      {ready && summary.total > 0 ? (
        <>
          <dl className={styles.segments}>
            {SEGMENTS.map((segment) => (
              <div
                key={segment}
                className={styles.segment}
                data-segment={segment}
                data-empty={summary[segment] === 0 ? '' : undefined}
              >
                <dt>{t(`providersPage.subscriptions.state_${segment}`)}</dt>
                <dd>{summary[segment]}</dd>
              </div>
            ))}
          </dl>
          {summary.limited > 0 ? (
            <p className={styles.note}>
              {nextAvailableAt !== null
                ? t('providersPage.subscriptions.nextAvailable', {
                    relative: formatRelativeInstant(nextAvailableAt, now, i18n.resolvedLanguage),
                    time: formatInstantShort(nextAvailableAt),
                    timezone: resolveTimeZoneLabel(),
                  })
                : t('providersPage.subscriptions.limitedUnknownTime')}
            </p>
          ) : null}
          {summary.attention > 0 ? (
            <p className={styles.noteAttention}>
              {t('providersPage.subscriptions.attentionHint', { count: summary.attention })}
            </p>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
