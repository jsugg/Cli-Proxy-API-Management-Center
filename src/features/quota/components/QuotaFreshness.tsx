import { useTranslation } from 'react-i18next';
import { useNow } from '@/hooks/useNow';
import { formatInstantShort, formatRelativeFreshness } from '@/utils/quota';
import { QUOTA_REVALIDATE_AFTER_MS } from '../autoRevalidate';

/** When the shown reading was taken; never implies the data is live. */
export function QuotaFreshness({
  observedAt,
  className,
}: {
  observedAt?: string | null;
  className?: string;
}) {
  const { t, i18n } = useTranslation();
  const now = useNow();
  const at = Date.parse(observedAt ?? '');
  if (!Number.isFinite(at)) return null;
  const stale = now - at >= QUOTA_REVALIDATE_AFTER_MS;
  return (
    <span className={className} data-stale={stale ? '' : undefined} title={formatInstantShort(at)}>
      {t(stale ? 'quota_management.freshness_stale' : 'quota_management.freshness', {
        relative: formatRelativeFreshness(Math.min(at, now), now, i18n.resolvedLanguage),
      })}
    </span>
  );
}
