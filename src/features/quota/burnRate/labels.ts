import type { TFunction } from 'i18next';
import { historyLimitLabel } from '../history/labels';
import type { BurnGroup } from './model';

/** Identical limit names need the actual period to distinguish their series. */
export function burnLimitLabel(
  t: TFunction,
  provider: string,
  group: BurnGroup,
  groups: readonly BurnGroup[]
): string {
  const label = historyLimitLabel(t, provider, group.limitId);
  return groups.filter((item) => historyLimitLabel(t, provider, item.limitId) === label).length > 1
    ? `${label} · ${t('quota_pool.period', { hours: group.periodSeconds / 3600 })}`
    : label;
}
