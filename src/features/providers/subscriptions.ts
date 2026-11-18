import { summarizeAvailability } from '@/features/authFiles/availability';
import type { AuthFileItem } from '@/types/authFile';
import type { ProviderBrand, ProviderSubscriptionSummary } from './types';

/** Workbench brands whose signed-in (OAuth) accounts live on the Auth Files page. */
const SUBSCRIPTION_BRANDS: readonly ProviderBrand[] = [
  'claude',
  'codex',
  'gemini',
  'kimi',
  'meta',
  'xai',
];
/** Brands where an empty account list is still worth stating. */
const ALWAYS_SHOWN_BRANDS: ReadonlySet<ProviderBrand> = new Set(['claude', 'codex']);
const SUBSCRIPTION_BRAND_SET: ReadonlySet<ProviderBrand> = new Set(SUBSCRIPTION_BRANDS);

export const isSubscriptionBrand = (brand: ProviderBrand): boolean =>
  SUBSCRIPTION_BRAND_SET.has(brand);

export const subscriptionBrandForType = (type: unknown): ProviderBrand | null => {
  const key = typeof type === 'string' ? type.trim().toLowerCase() : '';
  return SUBSCRIPTION_BRAND_SET.has(key as ProviderBrand) ? (key as ProviderBrand) : null;
};

export const shouldShowSubscriptionSummary = (
  brand: ProviderBrand,
  summary: ProviderSubscriptionSummary | undefined
): boolean =>
  isSubscriptionBrand(brand) && (ALWAYS_SHOWN_BRANDS.has(brand) || (summary?.total ?? 0) > 0);

/** `active` means usable now: limited, failing and disabled accounts are counted apart. */
export function summarizeSubscriptions(
  accounts: readonly AuthFileItem[],
  nowMs: number = Date.now()
): ProviderSubscriptionSummary {
  const summary = summarizeAvailability(accounts, nowMs);
  return {
    total: summary.total,
    active: summary.available,
    limited: summary.limited,
    attention: summary.attention,
    disabled: summary.disabled,
    nextAvailableAt: summary.nextAvailableAt,
  };
}
