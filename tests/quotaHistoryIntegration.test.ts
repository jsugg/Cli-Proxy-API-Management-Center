import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

test('quota route follows provider tabs and privacy, while the preview uses synthetic history', () => {
  const page = readFileSync('src/features/quota/QuotaPage.tsx', 'utf8');
  expect(page).toContain('<QuotaHistoryPanel');
  expect(page).toContain("tab === 'claude' || tab === 'codex'");
  expect(page).toContain("tab === 'all' || tab === 'claude' || tab === 'codex'");
  const hook = readFileSync('src/features/quota/history/useQuotaHistory.ts', 'utf8');
  expect(hook).toContain('snapshot?.owner === owner');
  expect(hook).toContain('session.dispose()');
  expect(hook).not.toContain('fetchQuota');
  expect(readFileSync('src/features/quota/preview/QuotaTierPreview.tsx', 'utf8')).toContain(
    '<QuotaHistoryPreview'
  );
});

test('all locales carry matching history keys and interpolation variables', () => {
  const locales = ['en', 'zh-CN', 'zh-TW', 'ru', 'vi', 'ko', 'tr'];
  const read = (locale: string): Record<string, string> =>
    JSON.parse(readFileSync(`src/i18n/locales/${locale}.json`, 'utf8')).quota_history;
  const english = read('en');
  const en = JSON.parse(readFileSync('src/i18n/locales/en.json', 'utf8'));
  expect(en.quota_pool.explanation).not.toContain('No quota history');
  expect(english.since).toContain('Collector started');
  expect(english.since).not.toContain('Recording since');
  for (const locale of locales) {
    const strings = read(locale);
    expect(Object.keys(strings).sort()).toEqual(Object.keys(english).sort());
    for (const [key, value] of Object.entries(english)) {
      expect(strings[key].match(/{{\w+}}/g)?.sort() ?? []).toEqual(
        value.match(/{{\w+}}/g)?.sort() ?? []
      );
    }
  }
});
