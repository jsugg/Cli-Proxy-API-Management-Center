import { useTranslation } from 'react-i18next';
import { useNow } from '@/hooks/useNow';
import type { AnthropicResetGrant } from '@/services/api/claudeResetGrants';
import { buildResetDisplay, parseIsoToMs } from '@/utils/quota';
import { resolveTimeZoneLabel } from '@/utils/time/timezone';
import { QuotaResetLabel } from '../../components/QuotaResetLabel';
import { formatResetWindows } from './resetGrantChoice';
import type { QuotaClassMap } from '../../types';
import { Button } from '@/components/ui/Button';
import { resetGrantKind } from './resetGrantChoice';
import styles from './ClaudeResetGrantDialog.module.scss';

interface ClaudeResetGrantDetailsProps {
  grants: readonly AnthropicResetGrant[];
  classes: QuotaClassMap;
  onChoose?: (id: string) => void;
  canRedeemGrant?: (id: string) => boolean;
  unavailableReason?: (grant: AnthropicResetGrant) => string | null;
}

/** Match Codex's reset-credit details without treating a multi-reset grant as one credit. */
export function ClaudeResetGrantDetails({
  grants,
  classes,
  onChoose,
  canRedeemGrant,
  unavailableReason,
}: ClaudeResetGrantDetailsProps) {
  const { t, i18n } = useTranslation();
  const now = useNow();
  const remaining = grants
    .filter((grant) => grant.resetsLeft > 0)
    .sort((a, b) => (parseIsoToMs(a.endsAt) ?? Infinity) - (parseIsoToMs(b.endsAt) ?? Infinity));

  if (remaining.length === 0) return null;

  return (
    <div className={classes.codexResetCredits}>
      <div className={classes.codexResetCreditsTitle}>
        {t('claude_reset.expiry_title', { timezone: resolveTimeZoneLabel() })}
      </div>
      <div className={classes.codexResetCreditLabel}>{t('quota_reset.bank_hint')}</div>
      {remaining.map((grant, index) => {
        const display = buildResetDisplay(
          null,
          parseIsoToMs(grant.endsAt),
          now,
          i18n.resolvedLanguage
        );
        const available = canRedeemGrant?.(grant.id) ?? false;
        const reason = unavailableReason?.(grant);
        return (
          <div key={grant.id} className={classes.codexResetCreditRow}>
            <span className={classes.codexResetCreditLabel}>
              {grant.label || t('claude_reset.grant_number', { index: index + 1 })}
              {' · '}
              {t('claude_reset.count', { left: grant.resetsLeft, total: grant.resetsTotal })}
              {grant.clears.length > 0 && (
                <>
                  {' · '}
                  {t('claude_reset.clears', {
                    windows: formatResetWindows(t, grant.clears, grant),
                  })}
                </>
              )}
              {grant.givesBackWeekly && (
                <span className={styles.effect}>{t('claude_reset.fable_hint')}</span>
              )}
              {onChoose && !available && reason && (
                <span className={styles.effect}>
                  {t(`claude_reset.reason_${reason}`, t('claude_reset.grant_unavailable'))}
                </span>
              )}
            </span>
            <span className={classes.codexResetCreditTime}>
              {display ? (
                <QuotaResetLabel display={display} classes={classes} />
              ) : (
                <span className={classes.quotaReset}>{t('claude_reset.expiry_unknown')}</span>
              )}
              {onChoose && (
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  className={styles.grantAction}
                  data-grant-id={grant.id}
                  disabled={!available}
                  aria-haspopup="dialog"
                  aria-label={t('claude_reset.redeem_grant', {
                    kind: t(`claude_reset.kind_${resetGrantKind(grant)}`),
                    label: grant.label || grant.id,
                  })}
                  onClick={() => onChoose(grant.id)}
                >
                  {t('claude_reset.use_grant', {
                    kind: t(`claude_reset.kind_${resetGrantKind(grant)}`),
                  })}
                </Button>
              )}
            </span>
          </div>
        );
      })}
    </div>
  );
}
