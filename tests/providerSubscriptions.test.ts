import { describe, expect, test } from 'bun:test';
import { buildProviderGroups } from '../src/features/providers/useProviderWorkbench';
import { normalizeAuthFilesResponse } from '../src/services/api/authFiles';
import type { AuthFileItem } from '../src/types/authFile';

const account = (name: string, type: string, extra: Partial<AuthFileItem> = {}): AuthFileItem => ({
  name,
  type,
  account_type: 'oauth',
  runtimeOnly: false,
  status: 'active',
  ...extra,
});

describe('provider subscription counts', () => {
  test('includes three Claude and three Codex subscriptions without creating API resources', () => {
    const files = ['claude', 'codex'].flatMap((type) =>
      [1, 2, 3].map((id) => account(`${type}-${id}.json`, type))
    );
    const groups = buildProviderGroups({}, files);
    for (const brand of ['claude', 'codex']) {
      const group = groups.find((item) => item.id === brand);
      expect(group?.subscriptions).toEqual({ total: 3, active: 3 });
      expect(group?.resources).toEqual([]);
    }
    expect(groups.find((item) => item.id === 'openaiCompatibility')?.subscriptions).toBeUndefined();
  });

  test('counts disabled, unavailable and error subscriptions as inactive', () => {
    const groups = buildProviderGroups({}, [
      account('active', 'codex'),
      account('disabled', 'codex', { disabled: true }),
      account('cooling', 'codex', { unavailable: true }),
      account('error', 'codex', { status: 'error' }),
    ]);
    expect(groups.find((item) => item.id === 'codex')?.subscriptions).toEqual({
      total: 4,
      active: 1,
    });
  });

  test('does not count API-key credentials or other OAuth providers as subscriptions', () => {
    const files = [
      account('api-key', 'codex', { account_type: 'api_key', account: 'fixture-secret' }),
      account('runtime', 'claude', { runtimeOnly: true }),
      account('unknown-kind', 'claude', { account_type: undefined }),
      account('other', 'vertex'),
    ];
    const groups = buildProviderGroups({}, files);
    expect(groups.find((item) => item.id === 'claude')?.subscriptions).toEqual({
      total: 0,
      active: 0,
    });
    expect(groups.find((item) => item.id === 'codex')?.subscriptions).toEqual({
      total: 0,
      active: 0,
    });
    expect(JSON.stringify(groups)).not.toContain('fixture-secret');
  });

  test('keeps API resources separate when a provider has both credential types', () => {
    const group = buildProviderGroups({ codexApiKeys: [{ apiKey: 'fixture-key' }] }, [
      account('subscription', 'codex'),
    ]).find((item) => item.id === 'codex');
    expect(group?.subscriptions).toEqual({ total: 1, active: 1 });
    expect(group?.resources).toHaveLength(1);
    expect(group?.resources[0].apiKey).toBe('fixture-key');
  });

  test('uses normalized runtime-only metadata and a provider fallback', () => {
    const { files } = normalizeAuthFilesResponse({
      files: [
        account('runtime', 'claude', { runtime_only: 'true' }),
        account('fallback', '', { provider: 'codex' }),
      ],
    });
    const groups = buildProviderGroups({}, files);
    expect(groups.find((item) => item.id === 'claude')?.subscriptions).toEqual({
      total: 0,
      active: 0,
    });
    expect(groups.find((item) => item.id === 'codex')?.subscriptions).toEqual({
      total: 1,
      active: 1,
    });
  });

  test('does not invent subscription counts when credentials were not loaded', () => {
    expect(buildProviderGroups({}).every((group) => group.subscriptions === undefined)).toBe(true);
  });

  test('active counts are independent of input order across credential health combinations', () => {
    const files = [false, true].flatMap((disabled) =>
      [false, true].flatMap((unavailable) =>
        ['active', 'error', 'disabled'].map((status) =>
          account(`${disabled}-${unavailable}-${status}`, 'claude', {
            disabled,
            unavailable,
            status,
          })
        )
      )
    );
    for (const order of [files, [...files].reverse()]) {
      expect(
        buildProviderGroups({}, order).find((group) => group.id === 'claude')?.subscriptions
      ).toEqual({ total: 12, active: 1 });
    }
  });
});
