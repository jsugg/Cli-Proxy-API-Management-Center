import { beforeAll, describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import i18n from '@/i18n';
import { ClaudeResetGrantDetails } from '@/features/quota/providers/claude/ClaudeResetGrantDetails';
import { bindQuotaClasses, QUOTA_CLASS_KEYS } from '@/features/quota/types';
import type { AnthropicResetGrant } from '@/services/api/claudeResetGrants';
import { formatInstantShort } from '@/utils/quota';
import { resolveTimeZoneLabel } from '@/utils/time/timezone';

const classes = bindQuotaClasses(
  Object.fromEntries(QUOTA_CLASS_KEYS.map((key) => [key, key])),
  'test-host'
);
const expiry = Date.now() + 11 * 86400_000;
const grant = (overrides: Partial<AnthropicResetGrant> = {}): AnthropicResetGrant => ({
  id: 'launch',
  label: 'Launch',
  resetsTotal: 3,
  resetsLeft: 2,
  startsAt: null,
  endsAt: new Date(expiry).toISOString(),
  clears: ['five_hour'],
  paused: false,
  usableNow: true,
  useRequiresLimit: true,
  percentUsed: {},
  ...overrides,
});
const render = (grants: AnthropicResetGrant[]) =>
  renderToStaticMarkup(createElement(ClaudeResetGrantDetails, { grants, classes }));

beforeAll(async () => {
  await i18n.changeLanguage('en');
});

describe('Claude reset grant details', () => {
  test('uses the Fable window label only for Fable refund grants', () => {
    const markup = render([
      grant({ givesBackWeekly: false, clears: ['seven_day_overage_included'] }),
    ]);
    expect(markup).toContain('weekly limit incl. extra usage');
    expect(markup).not.toContain('Clears: Fable limit');
  });
  test('each saved reset exposes its own named action and eligibility', () => {
    const grants = [
      grant({
        id: 'launch-2610-fable',
        label: 'Launch Fable',
        givesBackWeekly: true,
        clears: ['seven_day_overage_included'],
      }),
      grant({ id: 'launch-2610-fable-12mo', label: '12 months Fable', givesBackWeekly: true }),
      grant({
        id: 'launch-2610-fable-6mo',
        label: '6 months Fable',
        givesBackWeekly: true,
        usableNow: false,
      }),
    ];
    const markup = renderToStaticMarkup(
      createElement(ClaudeResetGrantDetails, {
        grants,
        classes,
        onChoose: () => {},
        canRedeemGrant: (id: string) => id !== 'launch-2610-fable-6mo',
        unavailableReason: () => 'not_usable',
      })
    );
    expect(markup.match(/<button/g)).toHaveLength(3);
    for (const id of grants.map((item) => item.id))
      expect(markup).toContain(`data-grant-id="${id}"`);
    expect(markup.match(/disabled=""/g)).toHaveLength(1);
    expect(markup).toContain('Redeem Fable reset · Launch Fable');
    expect(markup).toContain('Clears: Fable limit');
    expect(markup).not.toContain('weekly limit incl. extra usage');
    expect(markup).toContain('returns its share');
  });

  test('uses Codex detail classes, timezone, remaining count and live relative date', () => {
    const markup = render([grant()]);
    expect(markup).toContain('class="codexResetCredits"');
    expect(markup).toContain('class="codexResetCreditRow"');
    expect(markup).toContain(resolveTimeZoneLabel());
    expect(markup).toContain('Launch · 2 / 3 resets remaining');
    expect(markup).toContain(formatInstantShort(expiry));
    expect(markup).toContain('class="quotaResetRelative"');
    expect(markup).toContain('in 11d');
  });

  test('hides empty and spent grants', () => {
    expect(render([])).toBe('');
    expect(render([grant({ resetsLeft: 0 })])).toBe('');
    expect(render([grant(), grant({ id: 'spent', label: 'Spent', resetsLeft: 0 })])).not.toContain(
      'Spent'
    );
  });

  test('sorts by deadline without mutating input and keeps unknown dates last', () => {
    const grants = [
      grant({ id: 'unknown', label: 'Unknown', endsAt: null }),
      grant({ id: 'later', label: 'Later', endsAt: new Date(expiry + 86400_000).toISOString() }),
      grant({ id: 'first', label: 'First' }),
    ];
    const markup = render(grants);
    expect(markup.indexOf('First')).toBeLessThan(markup.indexOf('Later'));
    expect(markup.indexOf('Later')).toBeLessThan(markup.indexOf('Unknown'));
    expect(markup).toContain('Expiry unknown');
    expect(grants.map((item) => item.id)).toEqual(['unknown', 'later', 'first']);
  });

  test('keeps paused and expired unspent grants visible without implying usability', () => {
    const markup = render([
      grant({ paused: true, usableNow: false, endsAt: '2020-01-01T00:00:00Z' }),
    ]);
    expect(markup).toContain(formatInstantShort(Date.parse('2020-01-01T00:00:00Z')));
    expect(markup).not.toContain('<button');
  });

  test.each(['en', 'zh-CN', 'zh-TW', 'ru', 'vi'])(
    'translates fallback labels in %s',
    async (lng) => {
      await i18n.changeLanguage(lng);
      try {
        const markup = render([grant({ label: '', endsAt: null })]);
        expect(markup).toContain(i18n.t('claude_reset.grant_number', { index: 1 }));
        expect(markup).toContain(i18n.t('claude_reset.expiry_unknown'));
        expect(markup).not.toContain('claude_reset.');
      } finally {
        await i18n.changeLanguage('en');
      }
    }
  );
});
