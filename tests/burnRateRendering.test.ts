import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import i18n from '../src/i18n';
import { BurnRateChart } from '../src/features/quota/burnRate/BurnRateChart';
import { buildBurnRate, DAY_MS } from '../src/features/quota/burnRate/model';
import { BurnRateView } from '../src/features/quota/burnRate/BurnRateView';
import { burnRateFixture, BURN_PREVIEW_NOW } from '../src/features/quota/burnRate/fixtures';

test('generic providers, direct labels, accessible table, coverage and reset summaries render', async () => {
  await i18n.changeLanguage('en');
  const html = renderToStaticMarkup(
    createElement(BurnRateView, {
      state: burnRateFixture('ready'),
      now: BURN_PREVIEW_NOW,
      connected: true,
      onRefresh: () => undefined,
    })
  );
  for (const text of [
    'Burn rate',
    'Claude',
    'Codex',
    'xAI',
    '<svg',
    '<details',
    '<table',
    'left at reset',
    '%/d',
    'aliases',
    'based on',
  ])
    expect(html.includes(text), text).toBeTrue();
  expect(html).not.toContain('burn_rate.');
});
test('all unavailable states render without invented projections', async () => {
  await i18n.changeLanguage('en');
  for (const mode of [
    'collecting',
    'stale',
    'partial',
    'failure',
    'error',
    'unsupported',
    'loading',
  ] as const) {
    const html = renderToStaticMarkup(
      createElement(BurnRateView, {
        state: burnRateFixture(mode),
        now: BURN_PREVIEW_NOW,
        connected: true,
        onRefresh: () => undefined,
      })
    );
    expect(html).not.toContain('data-projection="true"');
    expect(html.includes('burn_rate.')).toBeFalse();
  }
}, 30000);
test('all locales carry burn rate keys and matching interpolation variables', () => {
  const read = (locale: string) =>
    JSON.parse(readFileSync(`src/i18n/locales/${locale}.json`, 'utf8'));
  const en = read('en');
  for (const locale of ['en', 'zh-CN', 'zh-TW', 'ru', 'vi', 'ko', 'tr']) {
    const data = read(locale);
    expect(data.nav.burn_rate).toBeTruthy();
    expect(data.nav_meta.burn_rate).toBeTruthy();
    expect(Object.keys(data.burn_rate).sort()).toEqual(Object.keys(en.burn_rate).sort());
    for (const key of Object.keys(en.burn_rate))
      expect(data.burn_rate[key].match(/{{\w+}}/g)?.sort() ?? []).toEqual(
        en.burn_rate[key].match(/{{\w+}}/g)?.sort() ?? []
      );
  }
});

const renderSamples = (used: number[]) => {
  const state = burnRateFixture('ready');
  const base = state.samples.find((s) => s.provider === 'xai')!;
  state.capabilities = { ...state.capabilities!, providers: ['xai'] };
  state.samples = used.map((usedPercent, i) => ({
    ...base,
    observedAt: BURN_PREVIEW_NOW - (used.length - 1 - i) * 3600000,
    resetAt: BURN_PREVIEW_NOW + DAY_MS,
    usedPercent,
  }));
  return state;
};
const renderState = (state: ReturnType<typeof burnRateFixture>) =>
  renderToStaticMarkup(
    createElement(BurnRateView, {
      state,
      now: BURN_PREVIEW_NOW,
      connected: true,
      onRefresh: () => undefined,
    })
  );

test('already exhausted and past predicted exhaustion render used up without a past runs-out time', async () => {
  await i18n.changeLanguage('en');
  for (const used of [[100], [100, 100, 100], [80, 90, 99.99]]) {
    const state = renderSamples(used);
    state.samples = state.samples.map((s) => ({ ...s, observedAt: s.observedAt - 5 * 60000 }));
    const html = renderState(state);
    expect(html).toContain('used up');
    expect(html).not.toContain('runs out');
  }
});

test('recorded paths split at a pooled window boundary', () => {
  const state = renderSamples([20, 30, 40]);
  const group = buildBurnRate(state.samples, BURN_PREVIEW_NOW, 300)[0];
  group.history = [
    { at: BURN_PREVIEW_NOW - 600000, remaining: 10 },
    { at: BURN_PREVIEW_NOW - 300000, remaining: 90, boundary: true },
    { at: BURN_PREVIEW_NOW, remaining: 80 },
  ];
  const html = renderToStaticMarkup(
    createElement(BurnRateChart, { groups: [group], provider: 'xai', now: BURN_PREVIEW_NOW })
  );
  const solid = [...html.matchAll(/<path[^>]*stroke-width="1.8"[^>]*>/g)];
  expect(solid).toHaveLength(2);
  expect(solid[0][0]).not.toContain(' L');
  expect(solid[1][0]).toContain(' L');
});

test('later refill markers draw vertical lines without pooled value dots', () => {
  const state = renderSamples([20, 30, 40]);
  const base = state.samples.at(-1)!;
  state.samples.push({ ...base, accountId: 'second', resetAt: BURN_PREVIEW_NOW + 2 * DAY_MS });
  const [group] = buildBurnRate(state.samples, BURN_PREVIEW_NOW, 300);
  const html = renderToStaticMarkup(
    createElement(BurnRateChart, { groups: [group], provider: 'xai', now: BURN_PREVIEW_NOW })
  );
  expect([...html.matchAll(/stroke-dasharray="4 4"/g)]).toHaveLength(2);
  expect([...html.matchAll(/<i /g)]).toHaveLength(2); // now and earliest refill only
});
