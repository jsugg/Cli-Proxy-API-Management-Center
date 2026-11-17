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
