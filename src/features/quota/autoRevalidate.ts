import { getQuotaCacheKey } from '@/utils/quota/identity';
import type { QuotaFileEntry } from './logic';
import type { QuotaCardState } from './providers';
import type { QuotaProviderType } from './providers/types';

/**
 * Providers whose quota read is a set of provider GET requests with no side effects.
 * Others keep click-to-load; Devin has its own once-per-visit loader.
 */
export const AUTO_REVALIDATE_PROVIDERS: ReadonlySet<QuotaProviderType> = new Set([
  'claude',
  'codex',
]);
/** Cached readings younger than this are shown as-is; older ones refresh in the background. */
export const QUOTA_REVALIDATE_AFTER_MS = 5 * 60_000;
/** At most this many automatic reads start per pass, whatever the page size. */
export const QUOTA_AUTO_BATCH_LIMIT = 8;

type StateWithObservation = QuotaCardState & { observedAt?: string };

/**
 * Automatic-read journal shared by every page in this tab. Keys include the cache
 * session and file generation, so a reconnect or credential change starts clean.
 * One attempt per credential per interval, whatever its outcome, bounds provider
 * traffic across route switches and repeated visits.
 */
const lastAttemptAt = new Map<string, number>();

export function autoRevalidateKey(
  entry: QuotaFileEntry,
  session: number,
  fileGeneration: number
): string {
  return JSON.stringify([session, fileGeneration, entry.type, getQuotaCacheKey(entry.file)]);
}

export function needsRevalidation(state: QuotaCardState | undefined, nowMs: number): boolean {
  if (!state || state.status === 'idle') return true;
  if (state.status !== 'success') return false;
  const observedAt = Date.parse((state as StateWithObservation).observedAt ?? '');
  return !Number.isFinite(observedAt) || nowMs - observedAt >= QUOTA_REVALIDATE_AFTER_MS;
}

export function selectAutoRevalidateTargets(
  entries: readonly QuotaFileEntry[],
  options: {
    stateFor: (entry: QuotaFileEntry) => QuotaCardState | undefined;
    session: number;
    fileGenerations: Readonly<Record<string, number>>;
    nowMs: number;
    journal?: Map<string, number>;
  }
): QuotaFileEntry[] {
  const journal = options.journal ?? lastAttemptAt;
  const targets: QuotaFileEntry[] = [];
  for (const entry of entries) {
    if (targets.length >= QUOTA_AUTO_BATCH_LIMIT) break;
    if (!AUTO_REVALIDATE_PROVIDERS.has(entry.type) || entry.file.disabled === true) continue;
    if (!needsRevalidation(options.stateFor(entry), options.nowMs)) continue;
    const key = autoRevalidateKey(
      entry,
      options.session,
      options.fileGenerations[entry.file.name] ?? 0
    );
    const previous = journal.get(key);
    if (previous !== undefined && options.nowMs - previous < QUOTA_REVALIDATE_AFTER_MS) continue;
    journal.set(key, options.nowMs);
    targets.push(entry);
  }
  return targets;
}

/** Test seam and logout hygiene: forget every automatic attempt. */
export function resetAutoRevalidateJournal(): void {
  lastAttemptAt.clear();
}
