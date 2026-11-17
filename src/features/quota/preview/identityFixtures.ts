import type { AuthFileItem } from '@/types';

const EMAILS = [
  'jupiter.alpha.one@example.test',
  'jupiter.beta.one@example.test',
  'jupiter.gamma.two@example.test',
];

/** Synthetic identities only, with no native auth index to permit provider probes. */
export function identityPreviewFile(provider: 'claude' | 'codex', index: number): AuthFileItem {
  const email = EMAILS[index];
  if (!email) throw new Error('Invalid identity fixture index');
  return { name: `${provider}-${index + 1}-${email}.json`, provider, type: provider, email };
}
