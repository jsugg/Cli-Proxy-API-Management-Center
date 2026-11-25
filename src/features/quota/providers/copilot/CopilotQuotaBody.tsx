import { useTranslation } from 'react-i18next';
import type { CopilotQuotaState } from '@/types';
import { useNow } from '@/hooks/useNow';
import { buildResetDisplay } from '@/utils/quota';
import { QuotaMeter } from '../../components/QuotaMeter';
import { QuotaResetLabel } from '../../components/QuotaResetLabel';
import type { QuotaBodyProps } from '../../types';

export function CopilotQuotaBody({ quota, classes }: QuotaBodyProps<CopilotQuotaState>) {
  const { t, i18n } = useTranslation();
  const now = useNow();
  const data = quota.data;
  if (!data?.buckets?.length)
    return <div className={classes.quotaMessage}>{t('copilot_quota.no_data')}</div>;

  const locale = i18n.resolvedLanguage;
  const reset = buildResetDisplay(null, data.resetAtMs, now, locale);
  const format = (value: number) => Math.round(value).toLocaleString(locale);
  return (
    <>
      {(data.plan || reset || data.creditsUsed !== null) && (
        <div className={classes.codexPlan}>
          {data.plan && (
            <span className={classes.codexPlanItem} data-quota-plan="">
              <span className={classes.codexPlanLabel}>{t('copilot_quota.plan_label')}</span>
              <span className={classes.codexPlanValue}>{data.plan}</span>
            </span>
          )}
          {reset && (
            <span className={classes.codexPlanItem}>
              <span className={classes.codexPlanLabel}>{t('copilot_quota.resets')}</span>
              <QuotaResetLabel display={reset} classes={classes} />
            </span>
          )}
          {data.creditsUsed !== null && (
            <span className={classes.codexPlanItem}>
              <span className={classes.codexPlanLabel}>{t('copilot_quota.credits_used')}</span>
              <span className={classes.codexPlanValue}>{format(data.creditsUsed)}</span>
            </span>
          )}
        </div>
      )}
      {data.buckets.map((bucket, index) => {
        const label = t(`copilot_quota.bucket_${bucket.id}`);
        const percent =
          bucket.percentRemaining === null ? null : Number(bucket.percentRemaining.toFixed(1));
        return (
          <div key={bucket.id} className={classes.quotaRow} data-copilot-bucket={bucket.id}>
            <div className={classes.quotaRowHeader}>
              <span className={classes.quotaModel}>{label}</span>
              <div className={classes.quotaMeta}>
                <span className={classes.quotaPercent}>
                  {percent === null
                    ? t('copilot_quota.unlimited')
                    : t('copilot_quota.remaining', { percent })}
                </span>
              </div>
            </div>
            {percent !== null && (
              <div
                role="meter"
                aria-label={label}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={percent}
              >
                <QuotaMeter percent={percent} classes={classes} index={index} />
              </div>
            )}
            {bucket.remaining !== null && bucket.entitlement !== null && bucket.entitlement > 0 && (
              <div className={classes.quotaAmount}>
                {t('copilot_quota.used_of', {
                  used: format(Math.max(0, bucket.entitlement - bucket.remaining)),
                  entitlement: format(bucket.entitlement),
                })}
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}
