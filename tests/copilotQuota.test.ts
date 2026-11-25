import { afterEach, expect, mock, spyOn, test } from 'bun:test';
import { COPILOT_CONFIG, parseCopilotQuota } from '@/features/quota/providers/copilot/data';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CopilotQuotaBody } from '@/features/quota/providers/copilot/CopilotQuotaBody';
import { QUOTA_CLASS_KEYS, bindQuotaClasses } from '@/features/quota/types';
import i18n from '@/i18n';
import { authFilesApi } from '@/services/api/authFiles';
import { apiClient } from '@/services/api/client';
import { useQuotaStore } from '@/stores/useQuotaStore';

const file = { name: 'copilot-test.json', authIndex: 'test-index', type: 'copilot' };
const credential = JSON.stringify({
  type: 'copilot',
  refresh_token: 'test-oauth',
  access_token: 'test-inference',
});
const snapshot = {
  quota_remaining: 1150.9,
  remaining: 1150,
  entitlement: 20000,
  percent_remaining: 5.7,
};
const payload = (premium: unknown) => ({
  login: 'fixture-account',
  quota_snapshots: { premium_interactions: premium },
});

afterEach(() => mock.restore());

test('downloads the selected credential and passes only its GitHub token to the fixed quota endpoint', async () => {
  spyOn(apiClient, 'captureConnection').mockReturnValue(apiClient);
  const download = spyOn(authFilesApi, 'downloadText').mockResolvedValue(credential);
  const post = spyOn(apiClient, 'post').mockResolvedValue({
    status_code: 200,
    body: payload(snapshot),
  });
  const data = await COPILOT_CONFIG.fetchQuota(file, i18n.t);
  expect(download).toHaveBeenCalledWith(file.name);
  expect(post).toHaveBeenCalledWith(
    '/requests/api-call',
    {
      method: 'GET',
      authIndex: 'test-index',
      url: 'https://api.github.com/copilot_internal/user',
      header: {
        Authorization: 'Bearer test-oauth',
        'User-Agent': 'copilot/1.0.114',
        Accept: 'application/json',
      },
    },
    undefined
  );
  const state = COPILOT_CONFIG.buildSuccessState(data);
  expect(Number.isFinite(Date.parse(state.observedAt ?? ''))).toBe(true);
  expect(state.data).toEqual({
    buckets: [
      {
        id: 'premium_interactions',
        unlimited: false,
        percentRemaining: 5.7,
        remaining: 1150.9,
        entitlement: 20000,
      },
    ],
    resetAtMs: null,
    plan: null,
    login: 'fixture-account',
    creditsUsed: null,
  });
});

// Shape of a live business seat (token-billed, every bucket unlimited), 2026-11-25.
const businessSeat = {
  login: 'fixture_ENT',
  copilot_plan: 'business',
  quota_reset_date: '2026-12-01',
  quota_reset_date_utc: '2026-12-01T00:00:00.000Z',
  token_based_billing: true,
  quota_snapshots: Object.fromEntries(
    ['chat', 'completions', 'premium_interactions'].map((id) => [
      id,
      {
        quota_id: id,
        unlimited: true,
        percent_remaining: 100,
        quota_remaining: 0,
        remaining: 0,
        entitlement: 0,
        credits_used: id === 'premium_interactions' ? 58524 : 0,
        overage_permitted: id === 'premium_interactions',
      },
    ])
  ),
};

test('business seats with unlimited buckets are a successful reading, not unavailable', () => {
  expect(parseCopilotQuota(businessSeat)).toEqual({
    buckets: ['premium_interactions', 'chat', 'completions'].map((id) => ({
      id,
      unlimited: true,
      percentRemaining: null,
      remaining: null,
      entitlement: null,
    })),
    resetAtMs: Date.parse('2026-12-01T00:00:00.000Z'),
    plan: 'business',
    login: 'fixture_ENT',
    creditsUsed: 58524,
  });
  const dateOnly = { ...businessSeat, quota_reset_date_utc: undefined };
  expect(parseCopilotQuota(dateOnly)?.resetAtMs).toBe(Date.parse('2026-12-01T00:00:00Z'));
  expect(
    parseCopilotQuota({ ...businessSeat, login: 'not a login', copilot_plan: '<b>' })
  ).toMatchObject({ login: null, plan: null });
});

test('zero is valid but missing and invalid windows are not exhausted quotas', () => {
  expect(
    parseCopilotQuota(payload({ ...snapshot, quota_remaining: 0, percent_remaining: 0 }))
      ?.buckets[0].remaining
  ).toBe(0);
  for (const premium of [undefined, {}, { ...snapshot, percent_remaining: null }]) {
    expect(parseCopilotQuota(payload(premium))).toBeNull();
  }
});

test('renders reported percentages independently of has_quota and optional counts', async () => {
  await i18n.changeLanguage('en');
  const classes = bindQuotaClasses(Object.fromEntries(QUOTA_CLASS_KEYS.map((k) => [k, k])), 'test');
  const render = (premium: unknown) => {
    const data = parseCopilotQuota(payload(premium));
    return renderToStaticMarkup(
      createElement(CopilotQuotaBody, {
        quota: { status: 'success', data: data ?? undefined },
        classes,
      })
    );
  };
  for (const counts of [
    {},
    { entitlement: '100' },
    { quota_remaining: null },
    { quota_remaining: '0', entitlement: '0' },
  ]) {
    const markup = render({ percent_remaining: ' 0 ', has_quota: false, ...counts });
    expect(markup).toContain('aria-valuenow="0"');
    expect(markup).not.toContain('quotaAmount');
  }
  const markup = render({ percent_remaining: '0.5', entitlement: '100', quota_remaining: '0' });
  expect(markup).toContain('aria-valuenow="0.5"');
  expect(markup).toContain('100 / 100 used');
  for (const premium of [
    {},
    ...[' ', false, 'NaN', -1, 101].map((percent_remaining) => ({ percent_remaining })),
  ]) {
    const unavailable = render(premium);
    expect(unavailable).not.toContain('role="meter"');
    expect(unavailable).not.toContain('quotaAmount');
    expect(unavailable).toContain(i18n.t('copilot_quota.no_data'));
  }
});

test('renders unlimited buckets, plan, monthly reset and credits without inventing a meter', async () => {
  await i18n.changeLanguage('en');
  const classes = bindQuotaClasses(Object.fromEntries(QUOTA_CLASS_KEYS.map((k) => [k, k])), 'test');
  const markup = renderToStaticMarkup(
    createElement(CopilotQuotaBody, {
      quota: { status: 'success', data: parseCopilotQuota(businessSeat) ?? undefined },
      classes,
    })
  );
  expect(markup.match(/Unlimited/g)).toHaveLength(3);
  for (const label of ['Premium requests', 'Chat', 'Code completions', 'business', 'Resets'])
    expect(markup).toContain(label);
  expect(markup).toContain('58,524');
  expect(markup).not.toContain('role="meter"');
  expect(markup).not.toContain('quotaAmount');
});

test('missing token or changed file/session never forwards the credential', async () => {
  spyOn(apiClient, 'captureConnection').mockReturnValue(apiClient);
  const post = spyOn(apiClient, 'post');
  const download = spyOn(authFilesApi, 'downloadText');
  for (const mode of ['missing', 'file', 'session']) {
    download.mockImplementation(async () => {
      if (mode === 'missing') return '{"type":"copilot","access_token":"test-inference"}';
      useQuotaStore.getState().clearQuotaCache(mode === 'file' ? [file.name] : undefined);
      return credential;
    });
    await expect(COPILOT_CONFIG.fetchQuota(file, i18n.t)).rejects.toThrow(
      i18n.t(mode === 'missing' ? 'copilot_quota.no_token' : 'copilot_quota.unavailable')
    );
  }
  expect(post).not.toHaveBeenCalled();
});

test('failures name their cause but expose neither the token nor upstream response details', async () => {
  await i18n.changeLanguage('en');
  spyOn(apiClient, 'captureConnection').mockReturnValue(apiClient);
  const download = spyOn(authFilesApi, 'downloadText').mockResolvedValue(credential);
  const post = spyOn(apiClient, 'post');
  const expectFailure = async (key: string, params?: Record<string, unknown>) => {
    const error = await COPILOT_CONFIG.fetchQuota(file, i18n.t).catch((err: Error) => err);
    expect(error).toEqual(new Error(i18n.t(`copilot_quota.${key}`, params)));
    expect((error as Error).message).not.toContain('test-oauth');
    expect((error as Error).message).not.toContain('test-inference');
    expect((error as { status?: unknown }).status).toBeUndefined();
  };
  for (const status of [401, 403]) {
    post.mockResolvedValue({ status_code: status, body: credential });
    await expectFailure('token_rejected', { status });
  }
  post.mockResolvedValue({ status_code: 404, body: credential });
  await expectFailure('http_error', { status: 404 });
  post.mockResolvedValue({ status_code: 200, body: { login: 'fixture-account' } });
  await expectFailure('no_data');
  post.mockRejectedValue(new Error(credential));
  await expectFailure('request_failed');
  download.mockRejectedValue(new Error(credential));
  await expectFailure('credential_unreadable');
  download.mockResolvedValue('{"type":"claude","refresh_token":"test-oauth"}');
  await expectFailure('credential_unreadable');
});
