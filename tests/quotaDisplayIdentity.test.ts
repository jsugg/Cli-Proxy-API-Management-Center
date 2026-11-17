import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { normalizeAuthFilesResponse } from '../src/services/api/authFiles';
import {
  createQuotaLabelResolver,
  getQuotaDisplayLabel,
  getQuotaDisplayName,
  getQuotaCacheKey,
} from '../src/utils/quota/identity';
import type { AuthFileItem } from '../src/types';

const file = (email: string, index = 1, provider = 'codex'): AuthFileItem => ({
  name: `${provider}-${index}-${email}.json`,
  type: provider,
  provider,
  email,
  authIndex: `fixture-${index}`,
});

describe('quota account display identity', () => {
  test('rejects oversized malformed metadata before allocating split parts', () => {
    expect(getQuotaDisplayLabel({ name: 'safe.json', email: '@'.repeat(100000) })).toBe(
      'safe.json'
    );
    const source = readFileSync('src/utils/quota/identity.ts', 'utf8');
    expect(source.indexOf('if (value.length > 254)')).toBeLessThan(
      source.indexOf("const parts = value.split('@')")
    );
  });
  test('prefers normalized safe email metadata, never technical filename or account secrets', () => {
    const normalized = normalizeAuthFilesResponse({
      files: [
        {
          name: 'codex-12-obsolete.email@example.test.json',
          provider: 'codex',
          auth_index: 'fixture-12',
          email: '  actual.person@accounts.example.test  ',
          account: 'do-not-render-secret',
        },
      ],
    }).files[0];
    expect(getQuotaDisplayName(normalized)).toBe('actual.person@accounts.example.test');
    expect(getQuotaDisplayLabel(normalized)).toBe('actu…son@accounts.example.test');
    expect(getQuotaDisplayLabel(normalized, true)).toBe('actual.person@accounts.example.test');
    const technicalLookingEmail = file('codex-2-legitimate@example.test');
    expect(getQuotaDisplayName(technicalLookingEmail)).toBe('codex-2-legitimate@example.test');
    const guarded = file('person.alpha@example.test');
    Object.defineProperty(guarded, 'account', {
      get() {
        throw new Error('Secret account read');
      },
    });
    Object.defineProperty(guarded, 'account_type', {
      get() {
        throw new Error('Secret account type read');
      },
    });
    expect(getQuotaDisplayLabel(guarded)).toBe('pers…pha@example.test');
  });

  test('cleans only the known provider-number filename convention when metadata is absent', () => {
    for (const provider of ['claude', 'codex']) {
      const fallback = {
        ...file('jupiter.alpha.one@example.test', 12, provider),
        email: undefined,
      };
      expect(getQuotaDisplayName(fallback)).toBe('jupiter.alpha.one@example.test');
      expect(getQuotaDisplayLabel(fallback)).toBe('jupi…one@example.test');
      expect(getQuotaDisplayLabel(fallback, true)).toBe('jupiter.alpha.one@example.test');
    }
    expect(
      getQuotaDisplayName({ name: 'codex-real-person@example.test.json', provider: 'codex' })
    ).toBe('codex-real-person@example.test');
    expect(
      getQuotaDisplayName({ name: 'codex-12-person@example.test.json', provider: 'claude' })
    ).toBe('codex-12-person@example.test');
    expect(getQuotaDisplayName({ name: 'person@example.test.json' })).toBe('person@example.test');
  });

  test.each([
    ['a@example.test', '…@example.test'],
    ['ab@example.test', 'a…@example.test'],
    ['abc@example.test', 'a…c@example.test'],
    ['alex@example.test', 'a…x@example.test'],
    ['alice@example.test', 'al…e@example.test'],
    ['abcdefgh@example.test', 'ab…h@example.test'],
    ['abcdefghi@example.test', 'abcd…ghi@example.test'],
    ['josé@exämple.test', 'j…é@exämple.test'],
  ])('keeps the domain and always hides local text for %s', (email, expected) => {
    const label = getQuotaDisplayLabel(file(email));
    expect(label).toBe(expected);
    expect(label).not.toContain(email);
    expect(label.match(/…/g)).toHaveLength(1);
  });

  test('distinguishes similar same-domain accounts with scoped, minimally expanded masks', () => {
    const files = [
      file('jupiter.alpha.one@example.test', 1),
      file('jupiter.beta.one@example.test', 2),
      file('jupiter.gamma.two@example.test', 3),
    ];
    const label = createQuotaLabelResolver(files);
    expect(files.map(label)).toEqual([
      'jupiter.a…one@example.test',
      'jupiter.b…one@example.test',
      'jupi…two@example.test',
    ]);
    const reversed = createQuotaLabelResolver([...files].reverse());
    expect(files.map(reversed)).toEqual(files.map(label));
    expect(files.map(createQuotaLabelResolver(files, true))).toEqual(
      files.map((item) => item.email!)
    );
    expect(createQuotaLabelResolver(files, true).masked(files[0])).toBe(
      'jupiter.a…one@example.test'
    );
    expect(
      createQuotaLabelResolver([files[0], file('jupiter.beta.one@example.test', 2, 'claude')])(
        files[0]
      )
    ).toBe('jupi…one@example.test');
  });

  test('handles short collisions without revealing an entire local part or attaching identifiers', () => {
    const files = [file('ab@example.test', 1), file('ac@example.test', 2)];
    expect(files.map(createQuotaLabelResolver(files))).toEqual([
      '…b@example.test',
      '…c@example.test',
    ]);
    const tiny = [file('a@example.test', 1), file('b@example.test', 2)];
    expect(tiny.map(createQuotaLabelResolver(tiny))).toEqual(['…@example.test', '…@example.test']);
    const duplicate = file('jupiter.alpha.one@example.test', 2);
    expect(
      createQuotaLabelResolver([duplicate, { ...duplicate, name: 'other.json' }])(duplicate)
    ).toBe('jupi…one@example.test');
  });

  test('every supported local length and a deterministic collision set keep at least one character hidden', () => {
    for (let length = 1; length <= 64; length++) {
      const local = 'x'.repeat(length);
      const label = getQuotaDisplayLabel(file(`${local}@example.test`));
      const maskedLocal = label.split('@')[0];
      expect(maskedLocal.match(/…/g)).toHaveLength(1);
      expect(Array.from(maskedLocal.replace('…', '')).length).toBeLessThan(length);
    }
    const examples = Array.from({ length: 26 }, (_, index) =>
      file(`abcd${String.fromCharCode(97 + index)}xghi@example.test`, index + 1)
    );
    const labels = examples.map(createQuotaLabelResolver(examples));
    expect(new Set(labels).size).toBe(26);
    for (const label of labels) expect(label.split('@')[0].replace('…', '').length).toBeLessThan(9);
  });

  test('does not fabricate addresses from malformed metadata or non-email names', () => {
    expect(getQuotaDisplayLabel({ name: 'codex-1-private@invalid.json', provider: 'codex' })).toBe(
      '…@…'
    );
    expect(getQuotaDisplayName(file('codex-2-legitimate@example.json'))).toBe(
      'codex-2-legitimate@example.json'
    );
    expect(
      getQuotaDisplayLabel({
        name: 'personal-account.json',
        email: 'not an email',
        account: 'do-not-render',
      })
    ).toBe('personal-account.json');
    expect(
      getQuotaDisplayName({ name: 'personal-account.json', email: 42 as unknown as string })
    ).toBe('personal-account.json');
    expect(
      getQuotaDisplayLabel({ name: 'codex-1-private@.json', provider: 'codex' })
    ).not.toContain('private');
    expect(
      getQuotaDisplayName({ name: 'personal-account.json', email: 'Name <person@example.test>' })
    ).toBe('personal-account.json');
  });

  test('is display-only: immutable credentials, cache keys and native auth indexes stay exact', () => {
    const credential = Object.freeze(file('jupiter.alpha.one@example.test', 12));
    const key = getQuotaCacheKey(credential);
    const label = createQuotaLabelResolver([credential]);
    expect(label(credential)).toBe('jupi…one@example.test');
    expect(getQuotaCacheKey(credential)).toBe(key);
    expect(key).toBe('codex-12-jupiter.alpha.one@example.test.json');
    expect(credential.authIndex).toBe('fixture-12');
    expect(credential.email).toBe('jupiter.alpha.one@example.test');
    for (const provider of ['devin', 'kiro']) {
      const shared = Object.freeze({
        ...credential,
        name: 'shared.json',
        provider,
        type: provider,
        supportsQuota: true,
        quotaProvider: provider,
      });
      expect(createQuotaLabelResolver([shared])(shared)).toBe('jupi…one@example.test');
      expect(getQuotaCacheKey(shared)).toBe('shared.json\0fixture-12');
    }
  });
});
