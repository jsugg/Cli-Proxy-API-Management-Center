import { createElement, type ReactNode } from 'react';
import type { TFunction } from 'i18next';
import type { CodexQuotaState } from '@/types';
import type { QuotaCardState } from '../providers';
import { CodexResetConfirmation } from './CodexResetConfirmation';

/** Codex is the only adapter with a reset action; anything else keeps the generic text. */
export function resetConfirmationMessage(
  t: TFunction,
  quota: QuotaCardState | undefined,
  name: string
): ReactNode {
  if (quota?.status === 'success' && 'rateLimitResetCredits' in quota) {
    return createElement(CodexResetConfirmation, { quota: quota as CodexQuotaState, name });
  }
  return t('codex_quota.reset_confirm_message', { name });
}
