import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import i18n from '../src/i18n';
import {
  anyWindowExhausted,
  automaticRenewals,
  sortByExpiry,
} from '../src/features/quota/reset/resetSemantics';
import { CodexResetConfirmation } from '../src/features/quota/reset/CodexResetConfirmation';
import { ClaudeResetGrantChoices } from '../src/features/quota/providers/claude/ClaudeResetGrantDialog';
import { resetGrantUnavailableReason } from '../src/features/quota/providers/claude/resetGrantChoice';
import type {
  AnthropicResetGrant,
  AnthropicResetGrantStatus,
} from '../src/services/api/claudeResetGrants';
import type { CodexQuotaState } from '../src/types';

const now = Date.now();
const hour = 3600_000;
const day = 24 * hour;

const codexQuota = (usedPercent: number): CodexQuotaState => ({
  status: 'success',
  observedAt: new Date(now).toISOString(),
  windows: [
    {
      id: 'weekly',
      label: 'Weekly limit',
      usedPercent: 13,
      resetLabel: '-',
      resetAtMs: now + 2 * day,
    },
    { id: 'five', label: '5-hour limit', usedPercent, resetLabel: '-', resetAtMs: now + hour },
  ],
  rateLimitResetCreditsAvailableCount: 2,
  rateLimitResetCredits: [
    {
      id: 'late',
      status: 'available',
      grantedAt: '',
      expiresAt: new Date(now + 25 * day).toISOString(),
    },
    {
      id: 'soon',
      status: 'available',
      grantedAt: '',
      expiresAt: new Date(now + 14 * day).toISOString(),
    },
  ],
  rateLimitResetCreditsError: '',
});

const grant = (patch: Partial<AnthropicResetGrant> = {}): AnthropicResetGrant => ({
  id: 'launch',
  label: 'New model launch',
  resetsTotal: 1,
  resetsLeft: 1,
  startsAt: null,
  endsAt: new Date(now + 100 * day).toISOString(),
  clears: ['five_hour', 'seven_day'],
  paused: false,
  usableNow: true,
  useRequiresLimit: true,
  percentUsed: {},
  resetType: 'full',
  givesBackWeekly: false,
  ...patch,
});
const status = (patch: Partial<AnthropicResetGrantStatus> = {}): AnthropicResetGrantStatus => ({
  eligible: true,
  ineligibleReason: null,
  atLimit: true,
  grants: [grant()],
  nextGrantId: null,
  weeklyResetsAt: null,
  cooldownUntil: null,
  ...patch,
});

describe('manual reset semantics', () => {
  test('automatic renewals list future window resets soonest first and flag exhausted ones', () => {
    const renewals = automaticRenewals(
      [
        { id: 'w', label: 'Weekly', usedPercent: 100, resetAtMs: now + day },
        { id: 'f', label: '5-hour', usedPercent: 10, resetAtMs: now + hour },
        { id: 'past', label: 'Past', usedPercent: 0, resetAtMs: now - 1 },
        { id: 'unknown', label: 'Unknown', usedPercent: 0, resetAtMs: null },
      ],
      now
    );
    expect(renewals.map((item) => [item.id, item.exhausted])).toEqual([
      ['f', false],
      ['w', true],
    ]);
    expect(anyWindowExhausted([{ id: 'x', label: '', usedPercent: null }])).toBe(false);
  });

  test('expiry ordering is display-only and puts unknown expiry last', () => {
    expect(
      sortByExpiry([
        { key: 'b', expiresAtMs: null },
        { key: 'a', expiresAtMs: 2 },
        { key: 'c', expiresAtMs: 1 },
      ]).map((item) => item.key)
    ).toEqual(['c', 'a', 'b']);
  });

  test('Codex confirmation names the account, says OpenAI picks the credit, and lists renewals', async () => {
    await i18n.changeLanguage('en');
    const markup = renderToStaticMarkup(
      createElement(CodexResetConfirmation, { quota: codexQuota(20), name: 'ju…ugg@example.test' })
    );
    expect(markup).toContain('Spend 1 of 2 manual resets on “ju…ugg@example.test”?');
    expect(markup).toContain('OpenAI chooses');
    expect(markup.match(/expires /g)).toHaveLength(2);
    expect(markup).toContain('Renews automatically, no reset needed');
    expect(markup.indexOf('5-hour limit')).toBeLessThan(markup.indexOf('Weekly limit'));
    expect(markup).toContain('None of this account');
    expect(markup).toContain('cannot be returned');
    expect(markup).not.toContain('<button');
  });

  test('the not-limited caution disappears once a window is actually used up', async () => {
    await i18n.changeLanguage('en');
    const markup = renderToStaticMarkup(
      createElement(CodexResetConfirmation, { quota: codexQuota(100), name: 'x' })
    );
    expect(markup).not.toContain('None of this account');
    expect(markup).toContain('used up');
  });

  test('Claude grant reasons explain why a specific entitlement cannot be spent', () => {
    expect(resetGrantUnavailableReason(status(), grant(), now)).toBeNull();
    expect(resetGrantUnavailableReason(status({ atLimit: false }), grant(), now)).toBe(
      'not_limited'
    );
    expect(resetGrantUnavailableReason(null, grant(), now)).toBe('unknown');
    expect(
      resetGrantUnavailableReason(
        status({ cooldownUntil: new Date(now + hour).toISOString() }),
        grant(),
        now
      )
    ).toBe('cooldown');
    const future = grant({ startsAt: new Date(now + day).toISOString() });
    expect(resetGrantUnavailableReason(status({ grants: [future] }), future, now)).toBe(
      'not_started'
    );
  });

  test('Claude choices show what each entitlement clears, its expiry timezone and why it is blocked', async () => {
    await i18n.changeLanguage('en');
    const markup = renderToStaticMarkup(
      createElement(ClaudeResetGrantChoices, {
        grants: [grant()],
        selected: null,
        canRedeemGrant: () => false,
        onSelect: () => undefined,
        unavailableReason: () => 'not_limited',
      })
    );
    expect(markup).toContain('Clears: 5-hour limit, weekly limit');
    expect(markup).toMatch(/Expires: .+\(GMT/);
    expect(markup).toContain('Usable only while this account is at its limit.');
    expect(markup).toContain('disabled=""');
  });
});
