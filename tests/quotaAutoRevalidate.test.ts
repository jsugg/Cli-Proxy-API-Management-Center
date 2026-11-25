import { describe, expect, test } from 'bun:test';
import {
  QUOTA_AUTO_BATCH_LIMIT,
  QUOTA_REVALIDATE_AFTER_MS,
  needsRevalidation,
  selectAutoRevalidateTargets,
} from '../src/features/quota/autoRevalidate';
import type { QuotaFileEntry } from '../src/features/quota/logic';
import type { QuotaCardState } from '../src/features/quota/providers';
import type { QuotaProviderType } from '../src/features/quota/providers/types';

const now = Date.parse('2026-11-17T12:00:00Z');
const entry = (name: string, type: QuotaProviderType = 'claude', disabled = false) =>
  ({ type, file: { name, type, authIndex: name, disabled } }) as QuotaFileEntry;
const success = (ageMs: number) =>
  ({ status: 'success', observedAt: new Date(now - ageMs).toISOString() }) as QuotaCardState;

const select = (
  entries: QuotaFileEntry[],
  states: Record<string, QuotaCardState | undefined> = {},
  options: { journal?: Map<string, number>; session?: number; at?: number } = {}
) =>
  selectAutoRevalidateTargets(entries, {
    stateFor: (item) => states[item.file.name],
    session: options.session ?? 1,
    fileGenerations: {},
    nowMs: options.at ?? now,
    journal: options.journal ?? new Map(),
  }).map((item) => item.file.name);

describe('quota auto revalidation', () => {
  test('loads missing readings and refreshes stale ones, keeping fresh cache as-is', () => {
    expect(
      select([entry('missing'), entry('fresh'), entry('stale')], {
        fresh: success(60_000),
        stale: success(QUOTA_REVALIDATE_AFTER_MS),
      })
    ).toEqual(['missing', 'stale']);
  });

  test('never auto-retries failures or in-flight reads; explicit refresh stays the way back', () => {
    expect(
      select([entry('failed'), entry('busy')], {
        failed: { status: 'error', error: 'rate limited' },
        busy: { status: 'loading' },
      })
    ).toEqual([]);
    expect(needsRevalidation({ status: 'idle' }, now)).toBe(true);
    expect(needsRevalidation({ status: 'success' }, now)).toBe(true);
  });

  test('only side-effect-free providers and enabled credentials are probed automatically', () => {
    expect(
      select([
        entry('codex', 'codex'),
        entry('copilot', 'copilot'),
        entry('antigravity', 'antigravity'),
        entry('xai', 'xai'),
        entry('off', 'claude', true),
      ])
    ).toEqual(['codex', 'copilot']);
  });

  test('one attempt per credential per interval across visits, whatever the outcome', () => {
    const journal = new Map<string, number>();
    expect(select([entry('a')], {}, { journal })).toEqual(['a']);
    // Route switch / remount while the first read failed or is still pending.
    expect(select([entry('a')], {}, { journal, at: now + 60_000 })).toEqual([]);
    expect(select([entry('a')], {}, { journal, at: now + QUOTA_REVALIDATE_AFTER_MS })).toEqual([
      'a',
    ]);
  });

  test('a new connection session is never blocked by the previous session journal', () => {
    const journal = new Map<string, number>();
    select([entry('a')], {}, { journal, session: 1 });
    expect(select([entry('a')], {}, { journal, session: 2 })).toEqual(['a']);
  });

  test('each pass is bounded regardless of page size', () => {
    const many = Array.from({ length: 30 }, (_, index) => entry(`c${index}`));
    expect(select(many)).toHaveLength(QUOTA_AUTO_BATCH_LIMIT);
  });
});
