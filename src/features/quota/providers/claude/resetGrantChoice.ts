import type { TFunction } from 'i18next';
import {
  anthropicResetGrantBlocker,
  type AnthropicResetWindow,
  type AnthropicResetGrant,
  type AnthropicResetGrantStatus,
} from '@/services/api/claudeResetGrants';

export function resetGrantKind(grant?: AnthropicResetGrant) {
  if (grant?.givesBackWeekly) return 'fable';
  return grant?.resetType ?? 'unknown';
}

/** Never substitute the recommendation or another grant for an explicit choice. */
export function canChooseResetGrant(
  status: AnthropicResetGrantStatus | null,
  pendingGrantId: string | undefined,
  grantId: unknown,
  now: number
): grantId is string {
  if (typeof grantId !== 'string' || !grantId) return false;
  // An uncertain claim must retry its original identity even if discovery no longer lists it.
  if (pendingGrantId) return pendingGrantId === grantId;
  if (!status || anthropicResetGrantBlocker(status, grantId)) return false;
  const grant = status.grants.find((candidate) => candidate.id === grantId)!;
  return (
    (!grant.startsAt || Date.parse(grant.startsAt) <= now) &&
    (!grant.endsAt || Date.parse(grant.endsAt) > now) &&
    (!status.cooldownUntil || Date.parse(status.cooldownUntil) <= now)
  );
}

/** Human labels for the windows a grant clears, in the provider's order. */
export function formatResetWindows(
  t: TFunction,
  windows: readonly AnthropicResetWindow[],
  grant?: AnthropicResetGrant
): string {
  return windows
    .map((window) =>
      t(
        grant?.givesBackWeekly && window === 'seven_day_overage_included'
          ? 'claude_reset.window_fable'
          : `claude_reset.window_${window}`
      )
    )
    .join(', ');
}

/** Why a grant cannot be chosen now, phrased for the person choosing. */
export function resetGrantUnavailableReason(
  status: AnthropicResetGrantStatus | null,
  grant: AnthropicResetGrant,
  now: number
): string | null {
  if (!status) return 'unknown';
  const blocker = anthropicResetGrantBlocker(status, grant.id);
  if (blocker) return blocker;
  if (grant.startsAt && Date.parse(grant.startsAt) > now) return 'not_started';
  if (grant.endsAt && Date.parse(grant.endsAt) <= now) return 'expired_grant';
  if (status.cooldownUntil && Date.parse(status.cooldownUntil) > now) return 'cooldown';
  return null;
}
