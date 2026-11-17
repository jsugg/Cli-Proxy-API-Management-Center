import { describe, expect, test } from 'bun:test';
import {
  classifyAuthFileAvailability,
  parseQuotaStatusMessage,
  summarizeAvailability,
} from '../src/features/authFiles/availability';
import { isProblemAuthFile } from '../src/features/authFiles/constants';
import type { AuthFileCooldown, AuthFileItem } from '../src/types/authFile';

const now = Date.parse('2026-11-17T12:00:00Z');
const hour = 3600_000;
const file = (patch: Partial<AuthFileItem> = {}): AuthFileItem => ({
  name: 'account.json',
  type: 'codex',
  status: 'active',
  ...patch,
});
const cooldowns = (records: AuthFileCooldown[], receivedAtMs = now) => ({
  cooldownSnapshot: { receivedAtMs, records },
});
const codexLimit = (resetsAt?: number) =>
  JSON.stringify({
    error: {
      type: 'usage_limit_reached',
      message: 'The usage limit has been reached',
      ...(resetsAt ? { resets_at: Math.floor(resetsAt / 1000) } : {}),
    },
  });

describe('auth file availability', () => {
  test('a Codex usage_limit_reached body is an expected limit with its provider reset time', () => {
    const result = classifyAuthFileAvailability(
      file({ unavailable: true, status: 'error', statusMessage: codexLimit(now + 2 * hour) }),
      now
    );
    expect(result).toEqual({ state: 'limited', availableAt: now + 2 * hour });
  });

  test('server quota cooldowns classify any provider as limited, anchored to receipt time', () => {
    const result = classifyAuthFileAvailability(
      file({
        type: 'claude',
        unavailable: true,
        status: 'error',
        statusMessage: '{"type":"error","error":{"type":"rate_limit_error"}}',
        ...cooldowns(
          [
            {
              scope: 'credential',
              reason: 'quota',
              retryAt: '2026-11-17T13:00:00Z',
              remainingSeconds: 3600,
            },
          ],
          now - 10 * 60_000
        ),
      }),
      now
    );
    expect(result.state).toBe('limited');
    // Ten minutes elapsed since receipt; never the local wall clock against retry_at.
    expect(result.availableAt).toBe(now + 50 * 60_000);
  });

  test('the earliest of cooldown, next_retry_after and provider reset wins', () => {
    const result = classifyAuthFileAvailability(
      file({
        unavailable: true,
        status: 'error',
        statusMessage: codexLimit(now + 5 * hour),
        next_retry_after: new Date(now + hour).toISOString(),
      }),
      now
    );
    expect(result.availableAt).toBe(now + hour);
  });

  test('a limit without any reported time is still limited, not unknown failure', () => {
    expect(classifyAuthFileAvailability(file({ statusMessage: 'quota exhausted' }), now)).toEqual({
      state: 'limited',
      availableAt: null,
    });
  });

  test('real auth, transport, service and parsing failures stay errors', () => {
    for (const patch of [
      { status: 'error', statusMessage: 'unauthorized' },
      { unavailable: true, statusMessage: 'transient upstream error' },
      { statusMessage: '{"error":{"type":"server_error"}}' },
      { statusMessage: 'The usage limit has been reached' },
      { statusMessage: '{not json' },
      { requires_sign_in: true, statusMessage: codexLimit(now + hour) },
      { refresh_error: { code: 'invalid_grant' }, quota_blocked: true },
    ] satisfies Partial<AuthFileItem>[]) {
      expect(classifyAuthFileAvailability(file(patch), now).state).toBe('attention');
    }
  });

  test('a credential-wide auth cooldown outranks a concurrent model quota cooldown', () => {
    const result = classifyAuthFileAvailability(
      file({
        unavailable: true,
        ...cooldowns([
          { scope: 'model', modelKey: 'm', reason: 'quota', retryAt: '', remainingSeconds: 600 },
          { scope: 'credential', reason: 'unauthorized', retryAt: '', remainingSeconds: 600 },
        ]),
      }),
      now
    );
    expect(result.state).toBe('attention');
  });

  test('a model-only quota cooldown on a usable credential leaves it available', () => {
    expect(
      classifyAuthFileAvailability(
        file(
          cooldowns([
            { scope: 'model', modelKey: 'm', reason: 'quota', retryAt: '', remainingSeconds: 600 },
          ])
        ),
        now
      ).state
    ).toBe('available');
  });

  test('elapsed quota cooldowns never keep a recovered credential limited', () => {
    const result = classifyAuthFileAvailability(
      file(
        cooldowns(
          [{ scope: 'credential', reason: 'quota', retryAt: '', remainingSeconds: 60 }],
          now - 2 * 60_000
        )
      ),
      now
    );
    expect(result.state).toBe('available');
  });

  test('disabled is its own state even when the last error was a limit', () => {
    expect(
      classifyAuthFileAvailability(file({ disabled: true, statusMessage: codexLimit() }), now).state
    ).toBe('disabled');
  });

  test('only structured provider markers count as quota; resets in the past are dropped', () => {
    expect(parseQuotaStatusMessage('{"error":{"status":"RESOURCE_EXHAUSTED"}}').quota).toBe(true);
    expect(parseQuotaStatusMessage('{"error":{"code":"usage_limit_reached"}}').quota).toBe(true);
    expect(parseQuotaStatusMessage('usage limit reached, please wait').quota).toBe(false);
    expect(
      classifyAuthFileAvailability(file({ statusMessage: codexLimit(now - hour) }), now).availableAt
    ).toBeNull();
  });

  test('summaries count every state once and report the earliest known recovery', () => {
    const summary = summarizeAvailability(
      [
        file(),
        file({ statusMessage: codexLimit(now + 3 * hour) }),
        file({ statusMessage: codexLimit(now + hour) }),
        file({ statusMessage: 'quota' }),
        file({ status: 'error' }),
        file({ disabled: true }),
      ],
      now
    );
    expect(summary).toEqual({
      total: 6,
      available: 1,
      limited: 3,
      attention: 1,
      disabled: 1,
      nextAvailableAt: now + hour,
      limitedWithoutTime: 1,
    });
  });

  test('limited credentials are excluded from the problem filter and its bulk delete', () => {
    expect(isProblemAuthFile(file({ unavailable: true, statusMessage: codexLimit() }))).toBe(false);
    expect(isProblemAuthFile(file({ unavailable: true }))).toBe(true);
  });
});
