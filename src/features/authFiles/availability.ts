import type { AuthFileItem } from '@/types/authFile';

/**
 * Operator-facing availability, separate from raw backend status.
 *
 * - `limited`: the provider's usage limit was reached. Expected and self-healing;
 *   never a "problem" and never part of bulk problem deletion.
 * - `attention`: auth, transport, service or parsing failures that need a person.
 * - `disabled`: intentionally turned off.
 */
export type AuthFileAvailabilityState = 'available' | 'limited' | 'attention' | 'disabled';

export interface AuthFileAvailability {
  state: AuthFileAvailabilityState;
  /** Epoch ms when the limit is expected to lift, if the server or provider said so. */
  availableAt: number | null;
}

const QUOTA_COOLDOWN_REASONS = new Set(['quota', 'credential_quota']);
const QUOTA_STATUS_MARKERS = new Set(['quota', 'quota exhausted', 'usage_limit_reached']);
const QUOTA_ERROR_TYPES = new Set(['usage_limit_reached']);
const QUOTA_ERROR_STATUSES = new Set(['resource_exhausted']);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const text = (value: unknown): string =>
  typeof value === 'string' ? value.trim().toLowerCase() : '';

const toEpochMs = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    // Provider bodies use epoch seconds; anything this large is already milliseconds.
    return value < 1e12 ? value * 1000 : value;
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

const readStatusMessage = (file: AuthFileItem): string => {
  const raw = file.statusMessage ?? file['status_message'];
  return typeof raw === 'string' ? raw.trim() : '';
};

interface QuotaMessage {
  quota: boolean;
  resetAt: number | null;
}

/**
 * Recognize provider usage-limit bodies by their structured type only. Free text
 * is never matched: a negated or per-minute message must not hide a real failure.
 */
export function parseQuotaStatusMessage(message: string): QuotaMessage {
  const normalized = message.trim();
  if (!normalized) return { quota: false, resetAt: null };
  if (QUOTA_STATUS_MARKERS.has(normalized.toLowerCase())) return { quota: true, resetAt: null };
  if (!normalized.startsWith('{')) return { quota: false, resetAt: null };
  let body: unknown;
  try {
    body = JSON.parse(normalized);
  } catch {
    return { quota: false, resetAt: null };
  }
  const error = isRecord(body) && isRecord(body.error) ? body.error : null;
  if (!error) return { quota: false, resetAt: null };
  const quota =
    QUOTA_ERROR_TYPES.has(text(error.type)) ||
    QUOTA_ERROR_TYPES.has(text(error.code)) ||
    QUOTA_ERROR_STATUSES.has(text(error.status));
  return { quota, resetAt: quota ? toEpochMs(error.resets_at ?? error.reset_at) : null };
}

const ATTENTION_COOLDOWN_REASONS = new Set([
  'invalid_grant',
  'unauthorized',
  'payment_required',
  'not_found',
  'cloudflare_challenge',
]);

/** Classify one credential. `nowMs` anchors server-relative cooldown timers. */
export function classifyAuthFileAvailability(
  file: AuthFileItem,
  nowMs: number = Date.now()
): AuthFileAvailability {
  const status = text(file.status);
  if (file.disabled === true || status === 'disabled') {
    return { state: 'disabled', availableAt: null };
  }
  // Sign-in and renewal failures outrank any concurrent quota signal.
  if (file['requires_sign_in'] === true || isRecord(file['refresh_error'])) {
    return { state: 'attention', availableAt: null };
  }

  const snapshot = file.cooldownSnapshot;
  const elapsedMs = snapshot ? Math.max(0, nowMs - snapshot.receivedAtMs) : 0;
  let quotaCooldownAt: number | null = null;
  let credentialQuotaCooldown = false;
  let attentionCooldown = false;
  for (const record of snapshot?.records ?? []) {
    const remainingMs = record.remainingSeconds * 1000 - elapsedMs;
    if (remainingMs <= 0) continue;
    if (QUOTA_COOLDOWN_REASONS.has(record.reason)) {
      const at = nowMs + remainingMs;
      quotaCooldownAt = quotaCooldownAt === null ? at : Math.min(quotaCooldownAt, at);
      if (record.scope === 'credential') credentialQuotaCooldown = true;
    } else if (record.scope === 'credential' && ATTENTION_COOLDOWN_REASONS.has(record.reason)) {
      attentionCooldown = true;
    }
  }
  if (attentionCooldown) return { state: 'attention', availableAt: null };

  const message = readStatusMessage(file);
  const parsed = parseQuotaStatusMessage(message);
  const blocked = file.unavailable === true || status === 'error';
  const quotaEvidence =
    parsed.quota ||
    credentialQuotaCooldown ||
    file['quota_blocked'] === true ||
    (blocked && quotaCooldownAt !== null);

  if (quotaEvidence) {
    const retryAfter = toEpochMs(file['next_retry_after']);
    const candidates = [quotaCooldownAt, retryAfter, parsed.resetAt].filter(
      (value): value is number => value !== null && value > nowMs
    );
    return { state: 'limited', availableAt: candidates.length ? Math.min(...candidates) : null };
  }

  const healthyMessage =
    !message || ['ok', 'healthy', 'ready', 'success', 'available'].includes(message.toLowerCase());
  if (blocked || !healthyMessage) return { state: 'attention', availableAt: null };
  return { state: 'available', availableAt: null };
}

export interface AvailabilitySummary {
  total: number;
  available: number;
  limited: number;
  attention: number;
  disabled: number;
  /** Earliest known time a limited credential becomes usable again. */
  nextAvailableAt: number | null;
  /** Limited credentials whose recovery time is not known. */
  limitedWithoutTime: number;
}

export function summarizeAvailability(
  files: readonly AuthFileItem[],
  nowMs: number = Date.now()
): AvailabilitySummary {
  const summary: AvailabilitySummary = {
    total: 0,
    available: 0,
    limited: 0,
    attention: 0,
    disabled: 0,
    nextAvailableAt: null,
    limitedWithoutTime: 0,
  };
  for (const file of files) {
    const { state, availableAt } = classifyAuthFileAvailability(file, nowMs);
    summary.total += 1;
    summary[state] += 1;
    if (state !== 'limited') continue;
    if (availableAt === null) summary.limitedWithoutTime += 1;
    else
      summary.nextAvailableAt =
        summary.nextAvailableAt === null
          ? availableAt
          : Math.min(summary.nextAvailableAt, availableAt);
  }
  return summary;
}
