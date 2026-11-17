import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import i18n from '../src/i18n';
import { QuotaTimeline } from '../src/features/quota/components/QuotaTimeline';
import { QuotaHistoryView } from '../src/features/quota/history/QuotaHistoryView';
import { initialHistoryState } from '../src/features/quota/history/session';
import { buildCodexCreditOverageContext } from '../src/features/quota/providers/codex/creditOverage';
import { CodexCreditOverageDialog } from '../src/features/quota/providers/codex/CodexCreditOverageDialog';
import { createQuotaLabelResolver, getQuotaCacheKey } from '../src/utils/quota/identity';
import type { AuthFileItem } from '../src/types';
import type { QuotaHistorySample } from '../src/features/quota/history/types';

const now = Date.parse('2026-11-17T12:00:00Z');
const files: AuthFileItem[] = [
  'jupiter.alpha.one@example.test',
  'jupiter.beta.one@example.test',
  'jupiter.gamma.two@example.test',
].map((email, index) =>
  Object.freeze({
    name: `codex-${index + 1}-${email}.json`,
    provider: 'codex',
    type: 'codex',
    email,
    authIndex: `fixture-${index + 1}`,
  })
);
const entries = files.map((file) => ({ type: 'codex' as const, file }));
const labels = [
  'jupiter.a…one@example.test',
  'jupiter.b…one@example.test',
  'jupi…two@example.test',
];

describe('consistent quota account labels', () => {
  test('synthetic previews cover three same-domain accounts for each provider', async () => {
    const { identityPreviewFile } = await import('../src/features/quota/preview/identityFixtures');
    for (const provider of ['claude', 'codex'] as const) {
      const examples = [0, 1, 2].map((index) => identityPreviewFile(provider, index));
      expect(examples.map(createQuotaLabelResolver(examples))).toEqual(labels);
      expect(
        examples.every((file) => file.email && file.name.startsWith(`${provider}-`))
      ).toBeTrue();
      expect(examples.every((file) => file.authIndex === undefined)).toBeTrue();
    }
  });

  test('credit context labels tolerate malformed email metadata without altering account keys', () => {
    const file = {
      ...files[0],
      email: 42 as unknown as string,
      chatgpt_account_id: 'fixture-account',
    };
    const context = buildCodexCreditOverageContext(file, undefined);
    expect(context?.accountLabel).toBe('jupiter.alpha.one@example.test');
    expect(context?.key).toBe(`fixture-account|file:${file.name}`);
    expect(context?.accountId).toBe('fixture-account');
  });

  test('credit confirmation displays the same scoped masked label and clean full reveal', async () => {
    await i18n.changeLanguage('en');
    const file = { ...files[0], chatgpt_account_id: 'fixture-account' };
    const original = buildCodexCreditOverageContext(file, undefined)!;
    for (const showEmails of [false, true]) {
      const label = createQuotaLabelResolver(files, showEmails)(file);
      const context = { ...original, accountLabel: label };
      const markup = renderToStaticMarkup(
        createElement(CodexCreditOverageDialog, {
          open: true,
          context,
          entry: undefined,
          sharedCredentialCount: 1,
          selection: null,
          pendingTarget: null,
          feedback: null,
          onSelect: () => undefined,
          onSave: () => undefined,
          onClose: () => undefined,
        })
      );
      expect(markup).toContain(`<dd>${label}</dd>`);
      expect(markup).not.toContain('codex-1-');
      if (!showEmails) expect(markup).not.toContain(file.email!);
      expect(context.key).toBe(original.key);
      expect(context.accountId).toBe('fixture-account');
    }
  });

  test('credit presentation reacts to reveal and hide without changing the mutation context', () => {
    const file = { ...files[0], chatgpt_account_id: 'fixture-account' };
    const original = buildCodexCreditOverageContext(file, undefined)!;
    const source = readFileSync('src/features/quota/components/QuotaCard.tsx', 'utf8');
    const start = source.indexOf('  const creditOverageDialogContext =');
    expect(start).toBeGreaterThan(0);
    const block = source.slice(start, source.indexOf('  const codexAfterPlan =', start));
    const js = ts.transpileModule(`${block}\nreturn creditOverageDialogContext;`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText;
    for (const showEmails of [true, false, true, false]) {
      const displayName = createQuotaLabelResolver(files, showEmails)(file);
      const context = new Function('creditOverage', 'displayName', js)(
        { context: original },
        displayName
      ) as typeof original;
      expect(context.accountLabel).toBe(showEmails ? file.email! : labels[0]);
      expect(context.key).toBe(original.key);
      expect(context.accountId).toBe(original.accountId);
      expect(original.accountLabel).toBe(file.email!);
    }
  });

  test('a late reset notification cannot expose a captured revealed email after hide', async () => {
    const source = readFileSync('src/features/quota/hooks/useQuotaActions.ts', 'utf8');
    const block = source.slice(
      source.indexOf('  const resetQuota ='),
      source.indexOf('  return { resettingQuotaName')
    );
    const revealedLabels = createQuotaLabelResolver(files, true);
    let confirmation: { onConfirm: () => Promise<void> } | undefined;
    let resolve!: () => void;
    const notifications: string[] = [];
    const env = {
      useCallback: (fn: unknown) => fn,
      disableControls: false,
      resettingQuotaName: null,
      labelForFile: revealedLabels,
      getQuotaCacheKey,
      getQuotaState: () => undefined,
      showConfirmation: (value: typeof confirmation) => {
        confirmation = value;
      },
      showNotification: (value: string) => notifications.push(value),
      t: (key: string, params?: { name: string }) => `${key}: ${params?.name ?? ''}`,
      captureQuotaCacheGeneration: () => 1,
      commitIfQuotaCacheCurrent: (_generation: number, commit: () => void) => commit(),
      getQuotaSetter: () => () => undefined,
      setResettingQuotaName: () => undefined,
    };
    const js = ts.transpileModule(`${block}\nreturn resetQuota;`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const reset = new Function(...Object.keys(env), js)(...Object.values(env)) as (
      file: AuthFileItem,
      adapter: object
    ) => void;
    reset(files[0], {
      resetQuota: () =>
        new Promise<void>((done) => {
          resolve = done;
        }),
      buildSuccessState: () => ({ status: 'success' }),
    });
    const pending = confirmation!.onConfirm();
    const hiddenLabels = createQuotaLabelResolver(files);
    resolve();
    await pending;
    expect(notifications[0]).toContain(hiddenLabels(files[0]));
    expect(notifications[0]).not.toContain(files[0].email!);
  });

  test('a late refresh notification also stays masked after capturing revealed labels', async () => {
    const source = readFileSync('src/features/quota/hooks/useQuotaActions.ts', 'utf8');
    const block = source.slice(
      source.indexOf('  const refreshQuota ='),
      source.indexOf('  const resetQuota =')
    );
    let resolve!: (data: object) => void;
    const notifications: string[] = [];
    let target: AuthFileItem | undefined;
    const env = {
      useCallback: (fn: unknown) => fn,
      disableControls: false,
      resettingQuotaName: null,
      labelForFile: createQuotaLabelResolver(files, true),
      getQuotaCacheKey,
      getQuotaState: () => undefined,
      showNotification: (message: string) => notifications.push(message),
      t: (key: string, params?: { name: string }) => `${key}: ${params?.name ?? ''}`,
      captureQuotaCacheGeneration: () => 1,
      commitIfQuotaCacheCurrent: (_generation: number, commit: () => void) => commit(),
      getQuotaSetter: () => () => undefined,
      enrichQuotaInBackground: async () => undefined,
      getStatusFromError: () => undefined,
    };
    const js = ts.transpileModule(`${block}\nreturn refreshQuota;`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const refresh = new Function(...Object.keys(env), js)(...Object.values(env)) as (
      file: AuthFileItem,
      adapter: object
    ) => Promise<void>;
    const pending = refresh(files[0], {
      fetchQuota: (file: AuthFileItem) => {
        target = file;
        return new Promise<object>((done) => {
          resolve = done;
        });
      },
      buildLoadingState: () => ({ status: 'loading' }),
      buildSuccessState: () => ({ status: 'success' }),
    });
    const hiddenLabels = createQuotaLabelResolver(files);
    resolve({});
    await pending;
    expect(notifications[0]).toContain(hiddenLabels(files[0]));
    expect(notifications[0]).not.toContain(files[0].email!);
    expect(target).toBe(files[0]);
  });
  test('timeline names and tooltips use the same metadata-first scoped mask, with clean reveal', async () => {
    await i18n.changeLanguage('en');
    for (const showEmails of [false, true]) {
      const labelForFile = createQuotaLabelResolver(files, showEmails);
      const markup = renderToStaticMarkup(
        createElement(QuotaTimeline, {
          entries,
          quotaFor: () => ({
            status: 'success',
            windows: [
              {
                id: 'weekly',
                label: 'Weekly',
                usedPercent: 20,
                resetAtMs: now + 3600000,
                periodHours: 168,
              },
            ],
          }),
          displayNameFor: (name) => name,
          labelForFile,
          showEmails,
          resolvedTheme: 'light',
          now,
        })
      );
      for (const [index, file] of files.entries()) {
        const label = showEmails ? file.email! : labels[index];
        expect(markup).toContain(`title="${label}"`);
        expect(markup).toContain(`title="${label}\n`);
        expect(markup).not.toContain(`codex-${index + 1}-`);
        if (!showEmails) expect(markup).not.toContain(file.email!);
      }
    }
  });

  test('history selectors use the same labels without filename/index decorations', async () => {
    await i18n.changeLanguage('en');
    const samples: QuotaHistorySample[] = files.map((file, index) => ({
      observedAt: now,
      provider: 'codex',
      accountId: `opaque-${index + 1}`,
      authIndex: String(file.authIndex),
      identityQuality: 'credential',
      limitId: 'weekly',
      seriesId: 'fixture-series',
      periodSeconds: 604800,
      resetAt: now + 3600000,
      usedPercent: 20,
      state: 'ok',
      reason: null,
    }));
    const markup = renderToStaticMarkup(
      createElement(QuotaHistoryView, {
        state: {
          ...initialHistoryState(),
          status: 'ready',
          from: now - 3600000,
          to: now,
          samples,
          complete: true,
        },
        connected: true,
        entries,
        rangeHours: 1,
        now,
        onRangeChange: () => undefined,
        onRefresh: () => undefined,
        onLoadMore: () => undefined,
      })
    );
    expect(markup).toContain(labels[0]);
    expect(markup).not.toContain('codex-1-');
    expect(markup).not.toContain(files[0].email!);
  });

  test('reset confirmations use the display label while actions keep exact file identity', async () => {
    const source = readFileSync('src/features/quota/hooks/useQuotaActions.ts', 'utf8');
    const block = source.slice(
      source.indexOf('  const resetQuota ='),
      source.indexOf('  return { resettingQuotaName')
    );
    const labelForFile = createQuotaLabelResolver(files);
    let confirmation: { message: string; onConfirm: () => Promise<void> } | undefined;
    let target: AuthFileItem | undefined;
    let generationName: string | undefined;
    const env = {
      useCallback: (fn: unknown) => fn,
      disableControls: false,
      resettingQuotaName: null,
      labelForFile,
      getQuotaCacheKey,
      getQuotaState: () => undefined,
      showConfirmation: (value: typeof confirmation) => {
        confirmation = value;
      },
      showNotification: () => undefined,
      t: (key: string, params?: { name: string }) => `${key}: ${params?.name ?? ''}`,
      captureQuotaCacheGeneration: (name: string) => {
        generationName = name;
        return 1;
      },
      commitIfQuotaCacheCurrent: (_generation: number, commit: () => void) => commit(),
      getQuotaSetter: () => () => undefined,
      setResettingQuotaName: () => undefined,
    };
    const js = ts.transpileModule(`${block}\nreturn resetQuota;`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const reset = new Function(...Object.keys(env), js)(...Object.values(env)) as (
      file: AuthFileItem,
      adapter: object
    ) => void;
    reset(files[0], {
      resetQuota: async (file: AuthFileItem) => {
        target = file;
        return {};
      },
      buildSuccessState: () => ({ status: 'success' }),
    });
    expect(confirmation?.message).toContain(labels[0]);
    expect(confirmation?.message).not.toContain(files[0].name);
    await confirmation?.onConfirm();
    expect(target).toBe(files[0]);
    expect(generationName).toBe(files[0].name);
    expect(target?.authIndex).toBe('fixture-1');
  });

  test('card display, ARIA names and credit confirmation share the resolved label', () => {
    const card = readFileSync('src/features/quota/components/QuotaCard.tsx', 'utf8');
    expect(card).toContain('labelForFile?.(file) ?? getQuotaDisplayLabel(file, showEmails)');
    expect(card).toContain('title={displayName}');
    expect(card).toContain('name={displayName}');
    expect(card).toContain('}: ${displayName}`');
    const credit = readFileSync(
      'src/features/quota/providers/codex/useCodexCreditOverage.ts',
      'utf8'
    );
    expect(card).toContain('accountLabel: displayName');
    expect(credit).toContain('labelForFile?.masked(file) ?? getQuotaDisplayLabel(file)');
    const claude = readFileSync(
      'src/features/quota/providers/claude/ClaudeResetGrants.tsx',
      'utf8'
    );
    expect(claude).toContain('name: labelForFile?.masked(file) ?? getQuotaDisplayLabel(file)');
  });
});
