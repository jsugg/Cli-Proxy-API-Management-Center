/**
 * Plain-language facts for spending a manual reset, kept apart from rendering so
 * the semantics are testable: what renews by itself, and when.
 */

export interface RenewalWindow {
  id: string;
  label: string;
  usedPercent: number | null;
  resetAtMs?: number | null;
}

export interface AutomaticRenewal {
  id: string;
  label: string;
  atMs: number;
  exhausted: boolean;
}

/** Windows that renew on their own, soonest first. Past or unknown instants are omitted. */
export function automaticRenewals<W extends RenewalWindow>(
  windows: readonly W[],
  nowMs: number,
  labelFor: (window: W) => string = (window) => window.label
): AutomaticRenewal[] {
  return windows
    .filter(
      (window): window is W & { resetAtMs: number } =>
        typeof window.resetAtMs === 'number' &&
        Number.isFinite(window.resetAtMs) &&
        window.resetAtMs > nowMs
    )
    .map((window) => ({
      id: window.id,
      label: labelFor(window),
      atMs: window.resetAtMs,
      exhausted: typeof window.usedPercent === 'number' && window.usedPercent >= 100,
    }))
    .sort((a, b) => a.atMs - b.atMs);
}

/** True only when the provider reported at least one exhausted window. Unknown is not limited. */
export function anyWindowExhausted(windows: readonly RenewalWindow[]): boolean {
  return windows.some(
    (window) => typeof window.usedPercent === 'number' && window.usedPercent >= 100
  );
}

export interface ExpiringEntitlement {
  key: string;
  expiresAtMs: number | null;
}

/** Soonest-expiring first; unknown expiry last. Ordering is display-only, never a selection. */
export function sortByExpiry<T extends ExpiringEntitlement>(items: readonly T[]): T[] {
  return [...items].sort(
    (a, b) =>
      (a.expiresAtMs ?? Infinity) - (b.expiresAtMs ?? Infinity) || a.key.localeCompare(b.key)
  );
}
