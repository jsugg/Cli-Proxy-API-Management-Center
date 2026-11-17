import { useTranslation } from 'react-i18next';
import { useNow } from '@/hooks/useNow';
import { formatInstantShort, formatRelativeInstant } from '@/utils/quota';
import type { AutomaticRenewal } from './resetSemantics';
import styles from './ResetExplainer.module.scss';

/** "What happens if you just wait" — every limit that renews without spending anything. */
export function AutomaticRenewalList({ renewals }: { renewals: readonly AutomaticRenewal[] }) {
  const { t, i18n } = useTranslation();
  const now = useNow();
  if (renewals.length === 0) {
    return <p className={styles.muted}>{t('quota_reset.renewal_unknown')}</p>;
  }
  return (
    <ul className={styles.list}>
      {renewals.map((renewal) => (
        <li key={renewal.id}>
          <span>
            {renewal.label}
            {renewal.exhausted ? ` · ${t('quota_reset.window_exhausted')}` : ''}
          </span>
          <span className={styles.when}>
            {formatInstantShort(renewal.atMs)} ·{' '}
            {formatRelativeInstant(renewal.atMs, now, i18n.resolvedLanguage)}
          </span>
        </li>
      ))}
    </ul>
  );
}
