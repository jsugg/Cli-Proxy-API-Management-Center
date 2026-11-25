import type { AuthFileItem } from '@/types';
import { normalizeRecentRequestAuthIndex } from '@/utils/recentRequests';
import { isDevinFile, isPluginQuotaFile } from './validators';

const QUOTA_IDENTITY_SEPARATOR = '\0';

/** An email, or a GitHub login (no domain) for Copilot credentials. */
interface DisplayEmail {
  address: string;
  local: string[];
  domain: string | null;
}

/** Optional live identity, e.g. the GitHub login reported by a Copilot quota reading. */
export type QuotaLoginHint = (file: AuthFileItem) => string | null | undefined;

interface EmailMask {
  prefix: number;
  suffix: number;
}
export interface QuotaLabelResolver {
  (file: AuthFileItem): string;
  readonly masked: (file: AuthFileItem) => string;
}

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
const providerFor = (file: AuthFileItem): string =>
  (text(file.provider) || text(file.type)).toLowerCase();

const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9_-]{0,98}[A-Za-z0-9])?$/;

/**
 * GitHub Copilot credentials have a login, not an email. Read only `username`, the
 * GitHub-reported login and a login-shaped `label`, never `account` (for API-key
 * credentials it is the key). The server's provider-name fallback label is not an identity.
 */
export const readCopilotLogin = (file: AuthFileItem, reportedLogin?: string | null): string => {
  if (providerFor(file) !== 'copilot') return '';
  for (const [value, isLabel] of [
    [file.username, false],
    [reportedLogin, false],
    [file.label, true],
  ] as const) {
    const login = text(value);
    if (GITHUB_LOGIN.test(login) && !(isLabel && login.toLowerCase() === 'copilot')) return login;
  }
  return '';
};

/** Recognize ordinary account emails, not display names, paths or credential secrets. */
function displayEmail(value: string): DisplayEmail | null {
  if (value.length > 254) return null;
  const parts = value.split('@');
  if (parts.length !== 2) return null;
  const [local, domain] = parts;
  const points = Array.from(local);
  if (
    !points.length ||
    points.length > 64 ||
    local.startsWith('.') ||
    local.endsWith('.') ||
    local.includes('..') ||
    !/^[\p{L}\p{M}\p{N}.!#$%&'*+=?^_`{|}~-]+$/u.test(local)
  )
    return null;
  const labels = domain.split('.');
  if (
    labels.length < 2 ||
    labels.some(
      (label) =>
        !label.length ||
        label.length > 63 ||
        !/^[\p{L}\p{N}](?:[\p{L}\p{M}\p{N}-]*[\p{L}\p{N}])?$/u.test(label)
    )
  )
    return null;
  return { address: value, local: points, domain };
}

function baseMask(email: DisplayEmail): EmailMask {
  const size = email.local.length;
  if (size >= 9) return { prefix: 4, suffix: 3 };
  if (size <= 2) return { prefix: size - 1, suffix: 0 };
  return { prefix: Math.min(2, Math.floor((size - 1) / 2)), suffix: 1 };
}

function maskedEmail(email: DisplayEmail, mask = baseMask(email)): string {
  return `${email.local.slice(0, mask.prefix).join('')}…${mask.suffix ? email.local.slice(-mask.suffix).join('') : ''}${email.domain === null ? '' : `@${email.domain}`}`;
}

/** Mask local text only; filename cleanup belongs to the metadata-aware resolver. */
export function maskQuotaIdentity(value: string): string {
  const direct = displayEmail(value);
  if (direct) return maskedEmail(direct);
  return value.replace(/[^\s@<>/]+@[^\s@<>/]*/g, (match) => {
    const email = displayEmail(match);
    return email ? maskedEmail(email) : '…@…';
  });
}

/**
 * Devin and backend quota providers can expose multiple credential identities
 * from one physical file, distinguished by auth_index.
 */
export function getQuotaCacheKey(file: AuthFileItem): string {
  if (!isDevinFile(file) && !isPluginQuotaFile(file)) return file.name;
  const authIndex = normalizeRecentRequestAuthIndex(file.authIndex);
  return `${file.name}${QUOTA_IDENTITY_SEPARATOR}${authIndex ?? ''}`;
}

function quotaEmail(file: AuthFileItem, loginFor?: QuotaLoginHint): DisplayEmail | null {
  const metadata = displayEmail(text(file.email));
  if (metadata) return metadata;
  const login = readCopilotLogin(file, loginFor?.(file));
  if (login) return { address: login, local: Array.from(login), domain: null };
  const name = text(file.name);
  const base = name.replace(/\.json$/i, '');
  const prefix = /\.json$/i.test(name) ? /^(claude|codex)-\d+-/i.exec(base) : null;
  const candidate =
    prefix && prefix[1].toLowerCase() === providerFor(file) ? base.slice(prefix[0].length) : base;
  return displayEmail(candidate);
}

/** Prefer safe email metadata; strip only our known provider-number filename convention. */
export function getQuotaDisplayName(file: AuthFileItem, loginFor?: QuotaLoginHint): string {
  const email = quotaEmail(file, loginFor);
  if (email) return email.address;
  if (!isDevinFile(file) && !isPluginQuotaFile(file)) return file.name;
  const identity = normalizeRecentRequestAuthIndex(file.authIndex);
  return identity ? `${file.name} · ${identity}` : file.name;
}

/** Return a clean email alone, masked by default, without changing any credential identifier. */
export function getQuotaDisplayLabel(
  file: AuthFileItem,
  showEmails = false,
  loginFor?: QuotaLoginHint
): string {
  const email = quotaEmail(file, loginFor);
  if (email) return showEmails ? email.address : maskedEmail(email);
  const identity = getQuotaDisplayName(file);
  return showEmails || !identity.includes('@') ? identity : '…@…';
}

/** Resolve collection-local collisions without persistent aliases or exposing a whole local part. */
export function createQuotaLabelResolver(
  files: readonly AuthFileItem[],
  showEmails = false,
  loginFor?: QuotaLoginHint
): QuotaLabelResolver {
  const keyFor = (file: AuthFileItem, email: DisplayEmail) =>
    JSON.stringify([providerFor(file), email.local.join(''), email.domain?.toLowerCase() ?? null]);
  const groups = new Map<string, Map<string, DisplayEmail>>();
  for (const file of files) {
    const email = quotaEmail(file, loginFor);
    if (!email) continue;
    const groupKey = JSON.stringify([providerFor(file), maskedEmail(email).toLowerCase()]);
    const group = groups.get(groupKey) ?? new Map<string, DisplayEmail>();
    group.set(keyFor(file, email), email);
    groups.set(groupKey, group);
  }
  const masks = new Map<string, EmailMask>();
  for (const group of groups.values()) {
    const emails = [...group.values()];
    let mask = baseMask(emails[0]);
    if (emails.length > 1) {
      const maxVisible = Math.min(...emails.map((email) => email.local.length)) - 1;
      const distinct = (candidate: EmailMask) =>
        new Set(emails.map((email) => maskedEmail(email, candidate).toLowerCase())).size ===
        emails.length;
      let found = false;
      for (let prefix = mask.prefix; prefix + mask.suffix <= maxVisible; prefix++) {
        const candidate = { prefix, suffix: mask.suffix };
        if (distinct(candidate)) {
          mask = candidate;
          found = true;
          break;
        }
      }
      if (!found) {
        search: for (let visible = 0; visible <= maxVisible; visible++) {
          for (let prefix = visible; prefix >= 0; prefix--) {
            const candidate = { prefix, suffix: visible - prefix };
            if (distinct(candidate)) {
              mask = candidate;
              break search;
            }
          }
        }
      }
    }
    for (const key of group.keys()) masks.set(key, mask);
  }
  const masked = (file: AuthFileItem): string => {
    const email = quotaEmail(file, loginFor);
    return email ? maskedEmail(email, masks.get(keyFor(file, email))) : getQuotaDisplayLabel(file);
  };
  return Object.assign(
    (file: AuthFileItem) => (showEmails ? getQuotaDisplayName(file, loginFor) : masked(file)),
    { masked }
  );
}

/** Resolve a cache identity back to the physical filename used by file mutations. */
export function getQuotaCacheFileName(key: string): string {
  const separatorIndex = key.indexOf(QUOTA_IDENTITY_SEPARATOR);
  return separatorIndex === -1 ? key : key.slice(0, separatorIndex);
}
