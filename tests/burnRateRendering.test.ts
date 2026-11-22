import { expect, test } from 'bun:test';
import {
  Children,
  createElement,
  isValidElement,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';
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

const twoSeries = () => {
  const samples = burnRateFixture('ready').samples.filter((sample) => sample.provider === 'xai');
  return buildBurnRate(
    [86400, 7 * 86400].flatMap((periodSeconds) =>
      samples.map((sample) => ({ ...sample, limitId: 'requests', periodSeconds }))
    ),
    BURN_PREVIEW_NOW
  );
};

test('closed recorded-values details mount no table rows for the 1154-row fixture', async () => {
  await i18n.changeLanguage('en');
  const groups = twoSeries();
  expect(groups[0].history).toHaveLength(1153);
  const timings: number[] = [];
  let html = '';
  for (let i = 0; i < 5; i++) {
    const start = performance.now();
    html = renderToStaticMarkup(
      createElement(BurnRateChart, { groups, provider: 'xai', now: BURN_PREVIEW_NOW })
    );
    timings.push(performance.now() - start);
  }
  console.info(
    'two-series, 1154-row fixture render ms:',
    timings.map((ms) => ms.toFixed(2)).join(', ')
  );
  expect(html).toContain('<summary');
  expect(html).not.toContain('<tr');
  expect(html).not.toContain('<table');
});

test('hover updates are isolated from memoized recorded values and path geometry', () => {
  // SSR cannot dispatch pointer events. Guard ownership and memo boundaries here;
  // browser verification measures actual pointer updates with the table open and closed.
  const source = readFileSync('src/features/quota/burnRate/BurnRateChart.tsx', 'utf8');
  const hoverLayer = source.slice(source.indexOf('function HoverLayer('));
  const chart = source.slice(
    source.indexOf('export function BurnRateChart('),
    source.indexOf('function HoverLayer(')
  );
  expect(chart).not.toContain('setHover');
  expect(hoverLayer).toContain('setHover');
  expect(source).toMatch(/const RecordedValues = memo\(/);
  expect(source).toMatch(/const ChartGeometry = memo\(/);
  expect(source).toContain('useMemo(');
  expect(source).toContain('onToggle=');
});

test('duplicate limit labels show actual durations in legends and direct labels', async () => {
  await i18n.changeLanguage('en');
  const state = renderSamples([20, 30, 40]);
  state.samples = [86400, 7 * 86400].flatMap((periodSeconds) =>
    state.samples.map((sample) => ({ ...sample, limitId: 'requests', periodSeconds }))
  );
  const html = renderState(state);
  expect(html.match(/Requests · 24h/g)).toHaveLength(2);
  expect(html.match(/Requests · 168h/g)).toHaveLength(2);
});

function chartElements(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  const elements: ReactElement<Record<string, unknown>>[] = [];
  Children.forEach(node, (child) => {
    if (isValidElement<Record<string, unknown>>(child)) {
      elements.push(child, ...chartElements(child.props.children as ReactNode));
    }
  });
  return elements;
}

test('unchanged data preserves geometry element identity and memoized table props', () => {
  const groups = twoSeries();
  let firstGeometry: unknown;
  let firstTable: ReactElement<Record<string, unknown>>;
  let renders = 0;
  function Harness() {
    const [tick, setTick] = useState(0);
    const tree = BurnRateChart({ groups, provider: 'xai', now: BURN_PREVIEW_NOW });
    const elements = chartElements(tree);
    const memoized = elements.filter(
      (element) =>
        typeof element.type === 'object' &&
        element.type !== null &&
        '$$typeof' in element.type &&
        element.type.$$typeof === Symbol.for('react.memo')
    );
    const geometry = memoized.find((element) => 'now' in element.props);
    const table = memoized.find((element) => !('now' in element.props))!;
    renders++;
    expect(geometry).toBeDefined();
    expect(table).toBeDefined();
    if (tick === 0) {
      firstGeometry = geometry;
      firstTable = table;
      setTick(1);
    } else {
      expect(geometry).toBe(firstGeometry);
      expect(table.type).toBe(firstTable.type);
      expect(table.props).toEqual(firstTable.props);
    }
    return tree;
  }
  renderToStaticMarkup(createElement(Harness));
  expect(renders).toBe(2);
});

function renderInteractedPart(part: 'HoverLayer' | 'RecordedValues') {
  const groups = twoSeries();
  let interacted = false;
  function Harness() {
    const tree = BurnRateChart({ groups, provider: 'xai', now: BURN_PREVIEW_NOW });
    const element = chartElements(tree).find((element) => {
      const type = element.type as unknown as { name?: string; type?: { name?: string } };
      return (type.name ?? type.type?.name) === part;
    })!;
    const type = element.type as unknown as {
      (props: Record<string, unknown>): ReactNode;
      type?: (props: Record<string, unknown>) => ReactNode;
    };
    // Invoke the captured component in the SSR harness so React applies its state update.
    const rendered = (type.type ?? type)(element.props);
    if (!interacted) {
      interacted = true;
      const eventName = part === 'RecordedValues' ? 'onToggle' : 'onPointerMove';
      const target = chartElements(rendered).find((element) => eventName in element.props)!;
      const handler = target.props[eventName] as (event: unknown) => void;
      handler({
        clientX: 30,
        currentTarget: { open: true, getBoundingClientRect: () => ({ left: 0, width: 100 }) },
      });
    }
    return rendered;
  }
  return renderToStaticMarkup(createElement(Harness));
}

test('opening recorded values mounts the grid with duration-qualified column headers', async () => {
  await i18n.changeLanguage('en');
  const html = renderInteractedPart('RecordedValues');
  expect(html.match(/<tr/g)).toHaveLength(1154);
  expect(html).toContain('scope="col">Requests · 24h</th>');
  expect(html).toContain('scope="col">Requests · 168h</th>');
});

test('hover tooltips distinguish identical limit names by their actual duration', async () => {
  await i18n.changeLanguage('en');
  const html = renderInteractedPart('HoverLayer');
  expect(html).toContain('Requests · 24h:');
  expect(html).toContain('Requests · 168h:');
});
