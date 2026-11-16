import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import i18n from '../src/i18n';
import { QuotaHistoryView } from '../src/features/quota/history/QuotaHistoryView';
import { buildHistoryPlot } from '../src/features/quota/history/plot';
import {
  buildHistoryTracks,
  HISTORY_MAX_AGE_MS,
  type HistoryTrack,
} from '../src/features/quota/history/model';
import { initialHistoryState } from '../src/features/quota/history/session';
import { parseHistoryCapabilities, parseHistoryPage } from '../src/services/api/quotaHistory';
import { historyCapabilitiesPayload, historySamplePayload } from './fixtures/quotaHistory';

const now = Date.parse('2026-11-16T12:00:00Z');
const from = now - 3600000;
const capabilities = parseHistoryCapabilities({
  ...historyCapabilitiesPayload,
  status: { ...historyCapabilitiesPayload.status, stale: false },
});
const samples = parseHistoryPage(
  {
    schema_version: 1,
    next_cursor: null,
    samples: [20, 10, 0].map((ago, index) => ({
      ...historySamplePayload,
      observed_at: new Date(now - ago * 60000).toISOString(),
      used_percent: 10 + index * 10,
    })),
  },
  { from, to: now, limit: 2000 }
).samples;
const ready = {
  ...initialHistoryState(),
  status: 'ready' as const,
  from,
  to: now,
  capabilities,
  samples,
  complete: true,
};
const render = (state = ready) =>
  renderToStaticMarkup(
    createElement(QuotaHistoryView, {
      state,
      connected: true,
      entries: [
        {
          type: 'claude',
          file: { name: 'claude-alice@example.test.json', type: 'claude', authIndex: 'fixture' },
        },
      ],
      rangeHours: 1,
      onRangeChange: () => undefined,
      onRefresh: () => undefined,
      onLoadMore: () => undefined,
      now,
    })
  );

const orphan = {
  ...samples[0],
  accountId: 'aaa-old',
  authIndex: 'old-fixture',
  limitId: 'unknown',
  state: 'unknown' as const,
  usedPercent: null,
  periodSeconds: null,
  resetAt: null,
};

function selectTrack(tracks: HistoryTrack[], selectedKey = ''): HistoryTrack | undefined {
  const source = readFileSync('src/features/quota/history/QuotaHistoryView.tsx', 'utf8');
  const block = source.slice(
    source.indexOf('  const track ='),
    source.indexOf('  const analysis =')
  );
  const js = ts.transpileModule(`${block}\nreturn track;`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return new Function('tracks', 'selectedKey', 'now', 'HISTORY_MAX_AGE_MS', js)(
    tracks,
    selectedKey,
    now,
    HISTORY_MAX_AGE_MS
  ) as HistoryTrack | undefined;
}

describe('recorded history chart', () => {
  test('defaults past an orphan unknown-only track to a fresh measured chart', async () => {
    await i18n.changeLanguage('en');
    const markup = render({ ...ready, samples: [orphan, ...samples] });
    expect(markup).toContain('data-history-recorded');
    expect(markup).toContain('data-history-projected');
    expect(markup).toContain('60 pp/h');
    expect(markup).toContain('70%');
  });

  test('preserves explicit unknown and stale selections, with first-track fallback when all unknown', () => {
    const tracks = buildHistoryTracks([orphan, ...samples]);
    expect(selectTrack(tracks)?.accountId).toBe('opaque-a');
    expect(selectTrack(tracks, tracks[0].key)).toBe(tracks[0]);
    const stale = buildHistoryTracks(
      samples.map((sample) => ({
        ...sample,
        accountId: 'aaa-stale',
        observedAt: sample.observedAt - 20 * 60000,
      }))
    );
    expect(selectTrack([...stale, ...tracks], stale[0].key)).toBe(stale[0]);
    expect(selectTrack([tracks[0]])).toBe(tracks[0]);
  });

  test('default eligibility excludes expired, future, stale, missing and invalid readings', () => {
    for (const patch of [
      { observedAt: now + 1 },
      { observedAt: now - HISTORY_MAX_AGE_MS - 1 },
      { resetAt: now },
      { resetAt: null },
      { usedPercent: Number.NaN },
      { usedPercent: 101 },
      { usedPercent: null },
      { state: 'unknown' as const },
      { periodSeconds: null },
    ]) {
      const ineligible = buildHistoryTracks([
        { ...samples[2], ...patch, accountId: 'aaa-invalid' },
      ])[0];
      const healthy = buildHistoryTracks(samples)[0];
      expect(selectTrack([ineligible, healthy])).toBe(healthy);
    }
  });

  test('does not chase newer timestamps between otherwise healthy tracks', () => {
    const first = buildHistoryTracks(
      samples.map((sample) => ({
        ...sample,
        accountId: 'aaa-healthy',
        observedAt: sample.observedAt - 60000,
      }))
    )[0];
    const second = buildHistoryTracks(samples)[0];
    expect(selectTrack([first, second])).toBe(first);
    const newerFirst = {
      ...first,
      samples: first.samples.map((sample) => ({
        ...sample,
        observedAt: sample.observedAt + 60000,
      })),
    };
    expect(selectTrack([newerFirst, second])).toBe(newerFirst);
  });

  test('separates records at errors, long gaps and new series without inventing zeros', () => {
    expect(buildHistoryPlot(samples).segments).toHaveLength(1);
    const unknown = { ...samples[1], state: 'unknown' as const, usedPercent: null };
    const plot = buildHistoryPlot([samples[0], unknown, samples[2]]);
    expect(plot.segments).toHaveLength(2);
    expect(plot.gaps).toEqual([
      { from: unknown.observedAt, to: unknown.observedAt },
      { from: samples[0].observedAt, to: samples[2].observedAt },
    ]);
    expect(plot.segments.flat().every((sample) => sample.usedPercent !== null)).toBeTrue();
    const changed = buildHistoryPlot([samples[0], samples[1], { ...samples[2], seriesId: 'new' }]);
    expect(changed.segments).toHaveLength(2);
    expect(changed.changes).toHaveLength(1);
    expect(
      buildHistoryPlot([samples[0], unknown, { ...samples[2], seriesId: 'new' }]).changes
    ).toHaveLength(1);
  });

  test('draws actual first samples; solid recorded and dashed projected remain distinguishable', async () => {
    await i18n.changeLanguage('en');
    const markup = render();
    expect(markup).toContain('role="img"');
    expect(markup).toContain('data-history-recorded');
    expect(markup).toContain('data-history-projected');
    expect(markup).toContain('pp/h');
    expect(markup).toContain('constant');
    expect(markup).not.toContain('alice@example.test');
    expect(markup).toContain('claude-a•••@e•••.json');
    expect(render({ ...ready, samples: [samples[0]] })).toContain('<circle');
    expect(render({ ...ready, samples: [samples[0]] })).not.toContain('data-history-projected');
  });

  test('unsupported, collecting, errors, stale and partial reads are explicit and never forecast', async () => {
    await i18n.changeLanguage('en');
    expect(render({ ...ready, status: 'unsupported', samples: [] })).toContain('not available');
    expect(render({ ...ready, samples: [] })).toContain('Collecting');
    expect(
      render({
        ...ready,
        samples: [],
        capabilities: {
          ...capabilities,
          status: { ...capabilities.status, stale: true, lastSuccessAt: null },
        },
      })
    ).not.toContain('Collector is stale');
    expect(render({ ...ready, status: 'error' })).toContain('Could not read');
    for (const state of [
      { ...ready, complete: false, nextCursor: 'next' },
      {
        ...ready,
        capabilities: { ...capabilities, status: { ...capabilities.status, stale: true } },
      },
      {
        ...ready,
        capabilities: {
          ...capabilities,
          status: {
            ...capabilities.status,
            lastError: 'enumeration_failed',
            consecutiveFailures: 1,
          },
        },
      },
    ])
      expect(render(state)).not.toContain('data-history-projected');
  });

  test('a null-duration missing window breaks the displayed known-period chart after recovery', async () => {
    await i18n.changeLanguage('en');
    const recovered = [20, 15, 10, 5, 0].map((ago, index) => ({
      ...samples[0],
      observedAt: now - ago * 60000,
      usedPercent: index === 2 ? null : 10 + index * 5,
      state: index === 2 ? ('unknown' as const) : ('ok' as const),
      periodSeconds: index === 2 ? null : 18000,
      resetAt: index === 2 ? null : now + 3600000,
      reason: index === 2 ? 'missing_window' : null,
    }));
    const markup = render({ ...ready, samples: recovered });
    expect(markup.match(/data-history-recorded/g)).toHaveLength(2);
    expect(markup).not.toContain('data-history-projected');
    expect(markup).toContain('Usable observations in the last 60 min: 4/5');
  });
});
