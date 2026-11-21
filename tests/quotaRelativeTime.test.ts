/**
 * Relative-time formatting for quota cards.
 */

import { describe, expect, test } from 'bun:test';
import {
  buildResetDisplay,
  formatInstantShort,
  formatRelativeFreshness,
  formatQuotaResetTime,
  formatRelativeInstant,
  relativeTimeParts,
} from '@/utils/quota';
import { DAY_MS, HOUR_MS, MINUTE_MS } from '@/utils/time/durations';

const NOW = new Date(2026, 7, 2, 12, 0, 0).getTime();

describe('relativeTimeParts', () => {
  test('picks the coarsest unit that still describes the gap', () => {
    expect(relativeTimeParts(NOW + DAY_MS, NOW)).toEqual({ value: 1, unit: 'day' });
    expect(relativeTimeParts(NOW + HOUR_MS, NOW)).toEqual({ value: 1, unit: 'hour' });
    expect(relativeTimeParts(NOW + 30_000, NOW)).toEqual({ value: 1, unit: 'minute' });
  });

  test('never renders a magnitude that should have been the next unit up', () => {
    // Rounding up here would produce "24 hours" and "60 minutes".
    expect(relativeTimeParts(NOW + DAY_MS - 1, NOW)).toEqual({ value: 23, unit: 'hour' });
    expect(relativeTimeParts(NOW + HOUR_MS - 1, NOW)).toEqual({ value: 59, unit: 'minute' });
  });

  test('truncates, so a deadline never appears further off than it is', () => {
    expect(relativeTimeParts(NOW + 11 * DAY_MS + 1, NOW)).toEqual({ value: 11, unit: 'day' });
    expect(relativeTimeParts(NOW + 11 * DAY_MS + 23 * HOUR_MS, NOW)).toEqual({
      value: 11,
      unit: 'day',
    });
    expect(relativeTimeParts(NOW + 90 * MINUTE_MS, NOW)).toEqual({ value: 1, unit: 'hour' });
  });

  test('past instants are negative rather than clamped to zero', () => {
    // The timeline-local predecessor clamped with Math.max(0, …), so an expired
    // credit read "in 1 minute".
    expect(relativeTimeParts(NOW - 3 * DAY_MS, NOW)).toEqual({ value: -3, unit: 'day' });
    expect(relativeTimeParts(NOW - 2 * HOUR_MS, NOW)).toEqual({ value: -2, unit: 'hour' });
  });

  test('sub-minute magnitudes floor to 1 in both directions', () => {
    expect(relativeTimeParts(NOW + 1, NOW)).toEqual({ value: 1, unit: 'minute' });
    expect(relativeTimeParts(NOW, NOW)).toEqual({ value: 1, unit: 'minute' });
    expect(relativeTimeParts(NOW - 1, NOW)).toEqual({ value: -1, unit: 'minute' });
  });
});

describe('formatRelativeInstant', () => {
  test.each([
    [DAY_MS + 17 * HOUR_MS + 30 * MINUTE_MS, '1d 17h'],
    [107 * DAY_MS + 10 * HOUR_MS, '107d 10h'],
    [2 * DAY_MS, '2d'],
    [3 * HOUR_MS, '3h'],
    [3 * HOUR_MS + 5 * MINUTE_MS + 59_000, '3h 5m'],
    [42 * MINUTE_MS, '42m'],
    [DAY_MS - 1, '23h 59m'],
    [HOUR_MS - 1, '59m'],
  ])('truncates %d milliseconds in both directions', (gap, duration) => {
    expect(formatRelativeInstant(NOW + gap, NOW, 'en')).toBe(`in ${duration}`);
    expect(formatRelativeInstant(NOW - gap, NOW, 'en')).toBe(`${duration} ago`);
  });

  test('preserves sub-minute wording without a zero-minute countdown', () => {
    expect(formatRelativeInstant(NOW + 59_999, NOW, 'en')).toBe('in 1 minute');
    expect(formatRelativeInstant(NOW, NOW, 'en')).toBe('in 1 minute');
    expect(formatRelativeInstant(NOW - 1, NOW, 'en')).toBe('1 minute ago');
  });

  test.each([
    ['en', 'in {{duration}}', '{{duration}} ago'],
    ['zh-CN', '{{duration}}后', '{{duration}}前'],
    ['zh-TW', '{{duration}}後', '{{duration}}前'],
    ['ru', 'через {{duration}}', '{{duration}} назад'],
    ['vi', 'sau {{duration}}', '{{duration}} trước'],
    ['ko', '{{duration}} 후', '{{duration}} 전'],
    ['tr', '{{duration}} sonra', '{{duration}} önce'],
  ])('localizes the duration and direction in %s', (locale, future, past) => {
    const gap = DAY_MS + 17 * HOUR_MS + 30 * MINUTE_MS;
    // Narrow spellings vary with the runtime's ICU version; direction and values must not.
    const duration = [
      new Intl.NumberFormat(locale, {
        style: 'unit',
        unit: 'day',
        unitDisplay: locale === 'vi' ? 'short' : 'narrow',
      }).format(1),
      new Intl.NumberFormat(locale, {
        style: 'unit',
        unit: 'hour',
        unitDisplay: locale === 'vi' ? 'short' : 'narrow',
      }).format(17),
    ].join(' ');
    expect(formatRelativeInstant(NOW + gap, NOW, locale)).toBe(
      future.replace('{{duration}}', duration)
    );
    expect(formatRelativeInstant(NOW - gap, NOW, locale)).toBe(
      past.replace('{{duration}}', duration)
    );
  });

  test('formats durations when Intl.DurationFormat is absent', () => {
    const locales = ['en', 'zh-CN', 'zh-TW', 'ru', 'vi', 'ko', 'tr'];
    const gap = DAY_MS + 17 * HOUR_MS;
    const expected = locales.map((locale) => formatRelativeInstant(NOW + gap, NOW, locale));
    const descriptor = Object.getOwnPropertyDescriptor(Intl, 'DurationFormat');
    Object.defineProperty(Intl, 'DurationFormat', { configurable: true, value: undefined });
    try {
      expect(locales.map((locale) => formatRelativeInstant(NOW + gap, NOW, locale))).toEqual(
        expected
      );
      expect(formatRelativeInstant(NOW + DAY_MS + 17 * HOUR_MS, NOW, 'en')).toBe('in 1d 17h');
      expect(formatRelativeInstant(NOW - 3 * HOUR_MS - 5 * MINUTE_MS, NOW, 'en')).toBe('3h 5m ago');
    } finally {
      if (descriptor) Object.defineProperty(Intl, 'DurationFormat', descriptor);
      else Reflect.deleteProperty(Intl, 'DurationFormat');
    }
  });

  test('renders in the requested locale', () => {
    expect(formatRelativeInstant(NOW + 11 * DAY_MS, NOW, 'en')).toBe('in 11d');
    expect(formatRelativeInstant(NOW + 11 * DAY_MS, NOW, 'zh-CN')).toContain('天');
    expect(formatRelativeInstant(NOW + 11 * DAY_MS, NOW, 'zh-TW')).toContain('天');
    expect(formatRelativeInstant(NOW + 11 * DAY_MS, NOW, 'ru')).toBeTruthy();
  });

  test('distinguishes past from future', () => {
    const future = formatRelativeInstant(NOW + 3 * DAY_MS, NOW, 'en');
    const past = formatRelativeInstant(NOW - 3 * DAY_MS, NOW, 'en');
    expect(future).not.toBe(past);
    expect(past).toContain('ago');
  });

  test('falls back instead of throwing on an unusable locale tag', () => {
    expect(() => formatRelativeInstant(NOW + DAY_MS, NOW, 'not-a-locale!!')).not.toThrow();
    expect(formatRelativeInstant(NOW + DAY_MS, NOW, 'not-a-locale!!')).toBeTruthy();
  });
});

describe('formatInstantShort', () => {
  test('matches the shape the baked reset labels already use', () => {
    const iso = new Date(2026, 7, 13, 14, 30).toISOString();
    expect(formatInstantShort(new Date(iso).getTime())).toBe(formatQuotaResetTime(iso));
  });

  test('degrades to a dash rather than "Invalid Date"', () => {
    expect(formatInstantShort(Number.NaN)).toBe('-');
  });
});

describe('buildResetDisplay', () => {
  test('pairs a baked absolute label with a computed relative one', () => {
    const display = buildResetDisplay('08-13 14:30', NOW + 11 * DAY_MS, NOW, 'en');
    expect(display).not.toBeNull();
    expect(display?.absolute).toBe('08-13 14:30');
    expect(display?.relative).toBe('in 11d');
  });

  test('keeps the baked label alone when the instant is missing', () => {
    // A store entry cached by an older build carries resetLabel but no resetAtMs.
    expect(buildResetDisplay('08-13 14:30', null, NOW, 'en')).toEqual({
      absolute: '08-13 14:30',
      relative: null,
    });
    expect(buildResetDisplay('08-13 14:30', undefined, NOW, 'en')?.relative).toBeNull();
  });

  test('derives the absolute half from the instant when no label was baked', () => {
    const at = NOW + 2 * HOUR_MS;
    const display = buildResetDisplay(undefined, at, NOW, 'en');
    expect(display?.absolute).toBe(formatInstantShort(at));
    expect(display?.relative).toBe('in 2h');
  });

  test('returns null when there is nothing to render', () => {
    expect(buildResetDisplay(undefined, null, NOW, 'en')).toBeNull();
    expect(buildResetDisplay('', null, NOW, 'en')).toBeNull();
    expect(buildResetDisplay('   ', null, NOW, 'en')).toBeNull();
    // '-' is the providers' own placeholder for "no reset known".
    expect(buildResetDisplay('-', null, NOW, 'en')).toBeNull();
  });

  test('treats a placeholder label with a real instant as renderable', () => {
    const display = buildResetDisplay('-', NOW + DAY_MS, NOW, 'en');
    expect(display?.absolute).toBe(formatInstantShort(NOW + DAY_MS));
    expect(display?.relative).toBe('in 1d');
  });

  test('rejects a non-finite instant', () => {
    expect(buildResetDisplay(undefined, Number.NaN, NOW, 'en')).toBeNull();
    expect(
      buildResetDisplay('08-13 14:30', Number.POSITIVE_INFINITY, NOW, 'en')?.relative
    ).toBeNull();
  });
});

describe('formatRelativeFreshness', () => {
  test('keeps the existing coarse labels for observations', () => {
    expect(formatRelativeFreshness(NOW - 90 * MINUTE_MS, NOW, 'en')).toBe('1 hour ago');
    expect(formatRelativeFreshness(NOW - MINUTE_MS, NOW, 'en')).toBe('1 minute ago');
  });
});

test('Vietnamese countdown separates numbers from alphabetic units', () => {
  expect(formatRelativeInstant(NOW + DAY_MS + 17 * HOUR_MS, NOW, 'vi')).toBe('sau 1 ngày 17 giờ');
  expect(formatRelativeInstant(NOW - 3 * HOUR_MS - 5 * MINUTE_MS, NOW, 'vi')).toBe(
    '3 giờ 5 phút trước'
  );
});
