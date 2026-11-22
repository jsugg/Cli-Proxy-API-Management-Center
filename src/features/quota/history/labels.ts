import type { TFunction } from 'i18next';
export { getTypeLabel as historyProviderLabel } from '@/features/authFiles/constants';

export function historyLimitLabel(t: TFunction, provider: string, limitId: string): string {
  const claudeKeys: Record<string, string> = {
    'five-hour': 'five_hour',
    'seven-day': 'seven_day',
    'seven-day-opus': 'seven_day_opus',
    'seven-day-sonnet': 'seven_day_sonnet',
    'seven-day-oauth-apps': 'seven_day_oauth_apps',
    'seven-day-cowork': 'seven_day_cowork',
    'seven-day-fable': 'seven_day_fable',
  };
  const codexKeys: Record<string, string> = {
    'five-hour': 'primary_window',
    weekly: 'secondary_window',
    monthly: 'team_secondary_window',
    'code-review-five-hour': 'code_review_primary_window',
    'code-review-weekly': 'code_review_secondary_window',
    'code-review-monthly': 'code_review_team_secondary_window',
  };
  const key = (provider === 'claude' ? claudeKeys : provider === 'codex' ? codexKeys : {})[limitId];
  return key
    ? t(`${provider}_quota.${key}`)
    : limitId.replace(/[-_]+/g, ' ').replace(/^./, (letter) => letter.toUpperCase());
}
