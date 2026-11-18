import { useTranslation } from 'react-i18next';
import { IconTimer } from '@/components/ui/icons';
import { useNow } from '@/hooks/useNow';
import { formatInstantShort, formatRelativeInstant } from '@/utils/quota';
import { resolveTimeZoneLabel } from '@/utils/time/timezone';
import styles from './AuthFileCard.module.scss';

/** Calm, expected-state copy for a reached usage limit; the raw body stays in Details. */
export function AuthFileLimitNotice({ availableAt }: { availableAt: number | null }) {
  const { t, i18n } = useTranslation();
  const now = useNow();
  const known = availableAt !== null && availableAt > now;
  return (
    <div className={styles.limitNotice} role="status">
      <IconTimer className={styles.limitIcon} size={14} aria-hidden="true" />
      <span>
        <strong>{t('auth_files.limit_reached')}</strong>{' '}
        {known
          ? t('auth_files.limit_available_again', {
              relative: formatRelativeInstant(availableAt, now, i18n.resolvedLanguage),
              time: formatInstantShort(availableAt),
              timezone: resolveTimeZoneLabel(),
            })
          : t('auth_files.limit_renews_automatically')}
      </span>
    </div>
  );
}
