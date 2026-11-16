import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { readFileSync } from 'node:fs';
import i18n from '../src/i18n/index';
import { ProviderCategoryList } from '../src/features/providers/components/ProviderCategoryList';
import { ProviderHeaderCard } from '../src/features/providers/components/ProviderHeaderCard';
import { ProviderSubscriptionSummary } from '../src/features/providers/components/ProviderSubscriptionSummary';
import { buildProviderGroups } from '../src/features/providers/useProviderWorkbench';

const groups = buildProviderGroups({}, [
  { name: 'one', type: 'codex', account_type: 'oauth', status: 'active' },
  { name: 'two', type: 'codex', account_type: 'oauth', status: 'active' },
  { name: 'three', type: 'codex', account_type: 'oauth', status: 'active' },
]).filter((group) => group.id === 'codex');

const renderCategories = (subscriptionStatus: 'loading' | 'ready' | 'error' = 'ready') =>
  renderToStaticMarkup(
    createElement(ProviderCategoryList, {
      groups:
        subscriptionStatus === 'ready'
          ? groups
          : buildProviderGroups({}).filter((g) => g.id === 'codex'),
      activeBrand: 'codex',
      subscriptionStatus,
      onSelect: () => {},
    })
  );

describe('provider subscription presentation', () => {
  test('includes subscriptions in active totals and labels the credential types separately', () => {
    const markup = renderCategories();
    expect(markup).toContain(
      i18n.t('providersPage.categories.activeCount', { active: 3, total: 3 })
    );
    expect(markup).toContain(
      i18n.t('providersPage.subscriptions.breakdown', { subscriptions: 3, keys: 0 })
    );
  });

  test('shows a loading state rather than a false zero for unknown subscriptions', () => {
    const markup = renderCategories('loading');
    expect(markup).toContain(i18n.t('common.loading'));
    expect(markup).not.toContain(
      i18n.t('providersPage.categories.activeCount', { active: 0, total: 0 })
    );
  });

  test('surfaces credential fetch failures instead of presenting no subscriptions', () => {
    expect(renderCategories('error')).toContain(i18n.t('providersPage.subscriptions.error'));
  });

  test('does not present an incomplete header total as authoritative', () => {
    const markup = renderToStaticMarkup(
      createElement(ProviderHeaderCard, {
        totalActive: 0,
        totalResources: 0,
        providerFamilies: 0,
        updatedAtLabel: 'now',
        summaryNotice: 'Subscription counts unavailable',
        onRefresh: () => {},
        onNew: () => {},
      })
    );
    expect(markup).toContain('Subscription counts unavailable');
    expect(markup).not.toContain(
      i18n.t('providersPage.header.activeResources', { active: 0, total: 0 })
    );
  });

  test('offers a read-only account summary and an account-management link', () => {
    const markup = renderToStaticMarkup(
      createElement(
        MemoryRouter,
        null,
        createElement(ProviderSubscriptionSummary, { group: groups[0], status: 'ready' })
      )
    );
    expect(markup).toContain(i18n.t('providersPage.subscriptions.title'));
    expect(markup).toContain(
      i18n.t('providersPage.categories.activeCount', { active: 3, total: 3 })
    );
    expect(markup).toContain('href="/auth-files"');
    expect(markup).not.toContain('<button');
  });

  test('does not render subscriptions for generic OpenAI-compatible API providers', () => {
    const markup = renderToStaticMarkup(
      createElement(ProviderSubscriptionSummary, {
        group: { id: 'openaiCompatibility', resources: [] },
        status: 'ready',
      })
    );
    expect(markup).toBe('');
  });

  test('translates the new subscription labels in all supported languages', () => {
    for (const locale of ['en', 'zh-CN', 'zh-TW', 'ru', 'vi', 'ko', 'tr']) {
      const messages = JSON.parse(
        readFileSync(new URL(`../src/i18n/locales/${locale}.json`, import.meta.url), 'utf8')
      );
      const labels = messages.providersPage.subscriptions;
      expect(Object.keys(labels).sort()).toEqual([
        'apiKeys',
        'breakdown',
        'error',
        'manage',
        'title',
      ]);
      expect(labels.breakdown).toContain('{{subscriptions}}');
      expect(labels.breakdown).toContain('{{keys}}');
      for (const value of Object.values(labels)) expect(value).toBeString();
    }
  });
});
