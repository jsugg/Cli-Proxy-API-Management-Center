import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import '../src/i18n/index';
import i18n from '../src/i18n';
import { QuotaPoolSummary } from '../src/features/quota/components/QuotaPoolSummary';
import { QuotaTimeline } from '../src/features/quota/components/QuotaTimeline';
import { readFileSync } from 'node:fs';

test('summaries explain missing data and never display an invented balance or forecast', async () => {
  await i18n.changeLanguage('en');
  const markup = renderToStaticMarkup(
    createElement(QuotaPoolSummary, {
      entries: [{ type: 'claude', file: { name: 'alice@example.com.json' } }],
      quotaFor: () => undefined,
      now: Date.now(),
    })
  );
  expect(markup).toContain('Unweighted');
  expect(markup).toContain('0/1');
  expect(markup).toContain('Unknown');
  expect(markup).not.toContain('alice@example');
  expect(markup).not.toContain('100%');
});

test('loaded summaries omit absent limits while retaining reported unknown limits', async () => {
  await i18n.changeLanguage('en');
  const markup = renderToStaticMarkup(
    createElement(QuotaPoolSummary, {
      entries: ['a', 'b', 'c'].map((name) => ({ type: 'claude' as const, file: { name } })),
      quotaFor: () => ({
        status: 'success',
        stale: true,
        windows: [
          { id: 'seven-day', label: 'Weekly', usedPercent: 20, periodHours: 168, resetLabel: '' },
        ],
      }),
      now: Date.now(),
    })
  );
  expect(markup).not.toContain('5-hour limit');
  expect(markup).not.toContain(' · 5h');
  expect(markup).toContain('Weekly');
  expect(markup).toContain('Unknown');
  expect(markup).toContain('0/3');
});

test('loaded limit labels follow a language switch', async () => {
  const render = () =>
    renderToStaticMarkup(
      createElement(QuotaPoolSummary, {
        entries: [{ type: 'claude' as const, file: { name: 'a' } }],
        quotaFor: () => ({
          status: 'success',
          windows: [
            {
              id: 'seven-day',
              label: 'Fetched in English',
              labelKey: 'claude_quota.seven_day',
              usedPercent: 20,
              periodHours: 168,
              resetLabel: '',
            },
          ],
        }),
        now: Date.now(),
      })
    );
  try {
    await i18n.changeLanguage('zh-CN');
    const markup = render();
    expect(markup).toContain(i18n.t('claude_quota.seven_day'));
    expect(markup).not.toContain('Fetched in English');
  } finally {
    await i18n.changeLanguage('en');
  }
});

test('timeline masks email identities by default, including titles', () => {
  const now = Date.now();
  const markup = renderToStaticMarkup(
    createElement(QuotaTimeline, {
      entries: [{ type: 'claude', file: { name: 'alice@example.com.json' } }],
      quotaFor: () => ({
        status: 'success',
        windows: [
          {
            id: 'seven-day',
            label: 'Weekly',
            usedPercent: 20,
            resetAtMs: now + 100_000,
            periodHours: 168,
          },
        ],
      }),
      displayNameFor: (name: string) => name,
      resolvedTheme: 'dark',
      now,
    })
  );
  expect(markup).not.toContain('alice@example.com');
  expect(markup).toContain('al…e@example.com');
});

test('quota cards hide email identities by default and allow explicit reveal', () => {
  const source = readFileSync(
    new URL('../src/features/quota/components/QuotaCard.tsx', import.meta.url),
    'utf8'
  );
  expect(source).toContain('showEmails = false');
  expect(source).toContain('labelForFile?.(file) ?? getQuotaDisplayLabel(file, showEmails)');
  expect(source).toContain('context={creditOverageDialogContext}');
});

test('development fixture renders the real summary with a privacy toggle', () => {
  const source = readFileSync(
    new URL('../src/features/quota/preview/QuotaTierPreview.tsx', import.meta.url),
    'utf8'
  );
  expect(source).toContain('<QuotaPoolSummary');
  expect(source).toContain('showEmails={showEmails}');
});

test('new observations advance the summary clock between minute ticks', () => {
  const source = readFileSync(
    new URL('../src/features/quota/components/QuotaPoolSummary.tsx', import.meta.url),
    'utf8'
  );
  expect(source).toContain('setReceiptTime(Date.now())');
  expect(source).toContain('Math.max(tick, receiptTime)');
});

test('summary scopes remembered provider windows to the quota cache session', () => {
  const source = readFileSync(
    new URL('../src/features/quota/components/QuotaPoolSummary.tsx', import.meta.url),
    'utf8'
  );
  expect(source).toContain('state.cacheGeneration');
  expect(source).toContain('remembered.session === session ? remembered.windows : {}');
  expect(source).toContain('previous.session === session');
  expect(source).toContain("state?.status === 'success'");
});

test('a GitHub Copilot summary card shows monthly buckets and marks unlimited seats', async () => {
  await i18n.changeLanguage('en');
  const now = Date.now();
  const markup = renderToStaticMarkup(
    createElement(QuotaPoolSummary, {
      entries: [{ type: 'copilot', file: { name: 'copilot-1.json', type: 'copilot' } }],
      quotaFor: () => ({
        status: 'success',
        observedAt: new Date(now).toISOString(),
        data: {
          buckets: ['premium_interactions', 'chat', 'completions'].map((id) => ({
            id,
            unlimited: true,
            percentRemaining: null,
            remaining: null,
            entitlement: null,
          })),
          resetAtMs: now + 6 * 86_400_000,
          plan: 'business',
          login: 'octo',
          creditsUsed: 1,
        },
      }),
      now,
    })
  );
  expect(markup).toContain('GitHub Copilot');
  expect(markup).toContain('1 enabled credential<');
  for (const label of ['Premium requests', 'Chat', 'Code completions'])
    expect(markup).toContain(label);
  expect(markup).toContain('monthly');
  expect(markup.match(/Unlimited/g)?.length).toBeGreaterThanOrEqual(3);
  expect(markup).toContain('1/1');
  expect(markup).not.toContain('octo');
});
