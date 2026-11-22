import { useTranslation } from 'react-i18next';
import { useNow } from '@/hooks/useNow';
import type { CodexQuotaState } from '@/types';
import { formatInstantShort, parseIsoToMs } from '@/utils/quota';
import { resolveTimeZoneLabel } from '@/utils/time/timezone';
import { AutomaticRenewalList } from './AutomaticRenewalList';
import { anyWindowExhausted, automaticRenewals, sortByExpiry } from './resetSemantics';
import styles from './ResetExplainer.module.scss';

/**
 * Body of the Codex manual-reset confirmation. With a `creditId` the consume call names that
 * credit; without one OpenAI picks, and the dialog says so rather than implying a choice.
 */
export function CodexResetConfirmation({
  quota,
  name,
  creditId,
}: {
  quota: CodexQuotaState;
  name: string;
  creditId?: string;
}) {
  const { t } = useTranslation();
  const now = useNow();
  const windows = quota.windows ?? [];
  const available = quota.rateLimitResetCreditsAvailableCount ?? 0;
  const credits = sortByExpiry(
    (quota.rateLimitResetCredits ?? []).map((credit, index) => ({
      key: credit.id || `credit-${index}`,
      selected: Boolean(creditId) && credit.id === creditId,
      expiresAtMs: parseIsoToMs(credit.expiresAt),
    }))
  );
  const renewals = automaticRenewals(windows, now, (window) =>
    window.labelKey ? t(window.labelKey, window.labelParams) : window.label
  );
  const limited = anyWindowExhausted(windows);
  const timezone = resolveTimeZoneLabel();

  return (
    <div className={styles.explainer}>
      <p>{t('quota_reset.codex_lead', { name, count: available })}</p>
      <section className={styles.section}>
        <h4 className={styles.heading}>{t('quota_reset.effect_heading')}</h4>
        <p>{t('quota_reset.codex_effect')}</p>
      </section>
      <section className={styles.section}>
        <h4 className={styles.heading}>{t('quota_reset.which_heading', { timezone })}</h4>
        <p className={styles.muted}>
          {t(creditId ? 'quota_reset.codex_which_selected' : 'quota_reset.codex_which')}
        </p>
        {credits.length > 0 && (
          <ul className={styles.list}>
            {credits.map((credit) => (
              <li
                key={credit.key}
                className={credit.selected ? styles.selected : undefined}
                aria-current={credit.selected ? 'true' : undefined}
              >
                <span>
                  {t(
                    credit.selected
                      ? 'quota_reset.manual_reset_selected'
                      : 'quota_reset.manual_reset'
                  )}
                </span>
                <span className={styles.when}>
                  {credit.expiresAtMs === null
                    ? t('claude_reset.expiry_unknown')
                    : t('quota_reset.expires_at', { date: formatInstantShort(credit.expiresAtMs) })}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className={styles.section}>
        <h4 className={styles.heading}>{t('quota_reset.renewal_heading')}</h4>
        <AutomaticRenewalList renewals={renewals} />
      </section>
      {!limited && <p className={styles.caution}>{t('quota_reset.not_limited_caution')}</p>}
      <p className={styles.muted}>{t('quota_reset.irreversible')}</p>
    </div>
  );
}
