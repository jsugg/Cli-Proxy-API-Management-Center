/** Relative countdowns beside unchanged absolute timestamps. */

import i18n from '@/i18n';
import { DAY_MS, HOUR_MS, MINUTE_MS } from '@/utils/time/durations';

export interface RelativeTimeParts {
  /** Signed magnitude: positive is future, negative is past. */
  value: number;
  unit: 'day' | 'hour' | 'minute';
}

/**
 * Coarsest unit that still describes the gap, with a signed magnitude.
 *
 * Signed on purpose: the earlier timeline-local version clamped with
 * `Math.max(0, …)`, so a credit that expired last week read "in 1 minute" —
 * technically monotonic, actively misleading.
 *
 * Truncated, not rounded up, for two reasons. It is the ordinary countdown
 * convention ("2 hours left" holds from 2:59 down to 2:00), and rounding up
 * crosses the unit thresholds: `DAY_MS - 1` picks the hour unit and then
 * ceils to "24 hours", `HOUR_MS - 1` to "60 minutes". For a deadline it also
 * errs in the safe direction — never claiming more time than remains.
 *
 * Sub-minute gaps floor to a magnitude of 1 so nothing renders "in 0 minutes".
 */
export function relativeTimeParts(targetMs: number, nowMs: number): RelativeTimeParts {
  const delta = targetMs - nowMs;
  const sign = delta < 0 ? -1 : 1;
  const abs = Math.abs(delta);

  if (abs >= DAY_MS) return { value: sign * Math.floor(abs / DAY_MS), unit: 'day' };
  if (abs >= HOUR_MS) return { value: sign * Math.floor(abs / HOUR_MS), unit: 'hour' };
  return { value: sign * Math.max(1, Math.floor(abs / MINUTE_MS)), unit: 'minute' };
}

/**
 * Formatters are cached per locale: this runs once per quota row per minute,
 * and constructing an Intl formatter is the expensive part.
 */
const relativeFormatters = new Map<string, Intl.RelativeTimeFormat>();

function getRelativeFormatter(locale?: string): Intl.RelativeTimeFormat {
  const key = locale ?? '';
  const cached = relativeFormatters.get(key);
  if (cached) return cached;

  let formatter: Intl.RelativeTimeFormat;
  try {
    formatter = new Intl.RelativeTimeFormat(locale, { numeric: 'always' });
  } catch {
    // An unexpected `resolvedLanguage` throws RangeError rather than falling
    // back on its own. A countdown in the wrong language beats no card at all.
    formatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'always' });
  }
  relativeFormatters.set(key, formatter);
  return formatter;
}

/** Coarse observation age; freshness labels deliberately keep their existing wording. */
export function formatRelativeFreshness(targetMs: number, nowMs: number, locale?: string): string {
  const { value, unit } = relativeTimeParts(targetMs, nowMs);
  return getRelativeFormatter(locale).format(value, unit);
}

type DurationUnit = 'day' | 'hour' | 'minute';
type Duration = Partial<Record<'days' | 'hours' | 'minutes', number>>;
interface DurationFormatter {
  format(duration: Duration): string;
}

// DurationFormat is not available in every supported browser or TypeScript Intl library.
type DurationFormatterConstructor = new (
  locale: string,
  options: { style: 'narrow' | 'short' }
) => DurationFormatter;

const durationFormatters = new Map<string, DurationFormatter>();
const unitFormatters = new Map<string, Intl.NumberFormat>();

function formatDurationUnit(value: number, unit: DurationUnit, locale: string): string {
  const DurationFormat = (Intl as typeof Intl & { DurationFormat?: DurationFormatterConstructor })
    .DurationFormat;
  const style = locale.split('-')[0] === 'vi' ? 'short' : 'narrow';
  if (DurationFormat) {
    let formatter = durationFormatters.get(locale);
    if (!formatter) {
      formatter = new DurationFormat(locale, { style });
      durationFormatters.set(locale, formatter);
    }
    return formatter.format({ [`${unit}s`]: value });
  }

  const key = `${locale}:${unit}`;
  let formatter = unitFormatters.get(key);
  if (!formatter) {
    formatter = new Intl.NumberFormat(locale, { style: 'unit', unit, unitDisplay: style });
    unitFormatters.set(key, formatter);
  }
  return formatter.format(value);
}

/** Use one supported locale for the duration and its translated direction wrapper. */
function resolveCountdownLocale(requested?: string): string {
  for (const candidate of [requested, i18n.resolvedLanguage, 'en']) {
    if (!candidate) continue;
    try {
      if (Intl.RelativeTimeFormat.supportedLocalesOf(candidate).length) return candidate;
    } catch {
      // Skip malformed tags as well as unsupported languages.
    }
  }
  return 'en';
}

/** Truncated days + hours, hours + minutes, or minutes, with localized direction. */
export function formatRelativeInstant(targetMs: number, nowMs: number, locale?: string): string {
  const gap = Math.abs(targetMs - nowMs);
  const language = resolveCountdownLocale(locale);
  const { value, unit } = relativeTimeParts(targetMs, nowMs);
  const parts = [
    `${gap < MINUTE_MS ? '<' : ''}${formatDurationUnit(Math.abs(value), unit, language)}`,
  ];
  const remainder =
    unit === 'day'
      ? Math.floor((gap % DAY_MS) / HOUR_MS)
      : unit === 'hour'
        ? Math.floor((gap % HOUR_MS) / MINUTE_MS)
        : 0;
  if (remainder) {
    parts.push(formatDurationUnit(remainder, unit === 'day' ? 'hour' : 'minute', language));
  }

  // A fixed separator keeps native DurationFormat and NumberFormat fallback output alike.
  return i18n.t(
    targetMs < nowMs ? 'quota_management.relative_past' : 'quota_management.relative_future',
    { lng: language, duration: parts.join(' ') }
  );
}

/**
 * Absolute instant in the shape every quota row already uses (`MM-DD HH:mm`,
 * browser-local, 24-hour). Kept in one place so the reset labels baked at fetch
 * time and the ones formatted at render time can never drift apart.
 */
export function formatInstantShort(ms: number): string {
  if (!Number.isFinite(ms)) return '-';
  return new Date(ms).toLocaleString(undefined, {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

export interface ResetDisplay {
  absolute: string;
  /** Null when no usable instant was available — render the absolute half alone. */
  relative: string | null;
}

/**
 * Pair an already-formatted absolute label with a freshly computed relative one.
 *
 * The absolute label wins when present because providers bake it at fetch time
 * and some of them cannot be reproduced at render (`formatCodexResetLabel`
 * resolves `reset_after_seconds` against the fetch-time clock). The instant is
 * only used for the relative half, and its absence degrades to exactly the
 * pre-existing rendering — which is what a store entry cached by an older
 * build, with no `resetAtMs` field, will hit.
 *
 * Returns null when there is nothing worth rendering at all.
 */
export function buildResetDisplay(
  absoluteLabel: string | undefined | null,
  atMs: number | undefined | null,
  nowMs: number,
  locale?: string
): ResetDisplay | null {
  const trimmed = typeof absoluteLabel === 'string' ? absoluteLabel.trim() : '';
  const absolute = trimmed && trimmed !== '-' ? trimmed : null;
  const usableMs = typeof atMs === 'number' && Number.isFinite(atMs) ? atMs : null;

  if (absolute === null && usableMs === null) return null;

  return {
    absolute: absolute ?? formatInstantShort(usableMs as number),
    relative: usableMs === null ? null : formatRelativeInstant(usableMs, nowMs, locale),
  };
}
