/**
 * DEV-only preview: provider availability, calm usage-limit states and manual-reset
 * explanations, rendered with synthetic accounts. No request leaves the browser and
 * every confirm handler is a no-op.
 */

import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { AuthFileCard } from '@/features/authFiles/components/AuthFileCard';
import { VaultHeader } from '@/features/authFiles/components/VaultHeader';
import { VaultPulse } from '@/features/authFiles/components/VaultPulse';
import { summarizeAvailability } from '@/features/authFiles/availability';
import { ProviderSubscriptionSummary } from '@/features/providers/components/ProviderSubscriptionSummary';
import { buildProviderGroups } from '@/features/providers/useProviderWorkbench';
import { useNotificationStore, useThemeStore } from '@/stores';
import type { AuthFileItem, CodexQuotaState } from '@/types';
import { ClaudeResetGrantDialog } from '../providers/claude/ClaudeResetGrantDialog';
import type { AnthropicResetGrant } from '@/services/api/claudeResetGrants';
import { CodexResetConfirmation } from '../reset/CodexResetConfirmation';
import { automaticRenewals } from '../reset/resetSemantics';
import pageStyles from '@/features/authFiles/AuthFilesPage.module.scss';

const HOUR = 3600_000;
const DAY = 24 * HOUR;

function fixtures(now: number): AuthFileItem[] {
  const limitBody = (resetsAt: number | null) =>
    JSON.stringify({
      error: {
        type: 'usage_limit_reached',
        message: 'The usage limit has been reached',
        ...(resetsAt ? { resets_at: Math.floor(resetsAt / 1000) } : {}),
      },
    });
  const base = (name: string, type: string, patch: Partial<AuthFileItem> = {}): AuthFileItem => ({
    name,
    type,
    provider: type,
    account_type: 'oauth',
    email: `${name}@example.test`,
    authIndex: `preview-${name}`,
    status: 'active',
    successCount: 120,
    failureCount: 1,
    ...patch,
  });
  return [
    base('codex-team', 'codex', {
      unavailable: true,
      status: 'error',
      statusMessage: limitBody(now + 2 * HOUR + 14 * 60_000),
    }),
    base('codex-plus', 'codex'),
    base('codex-pro', 'codex', {
      unavailable: true,
      status: 'error',
      statusMessage: limitBody(null),
    }),
    base('claude-max', 'claude'),
    base('claude-work', 'claude', {
      unavailable: true,
      status: 'error',
      cooldownSnapshot: {
        receivedAtMs: now,
        records: [
          {
            scope: 'credential',
            reason: 'quota',
            retryAt: new Date(now + 5 * HOUR).toISOString(),
            remainingSeconds: 5 * 3600,
          },
        ],
      },
    }),
    base('claude-old', 'claude', { status: 'error', statusMessage: 'unauthorized' }),
  ];
}

const codexQuota = (now: number): CodexQuotaState => ({
  status: 'success',
  observedAt: new Date(now - 3 * 60_000).toISOString(),
  planType: 'plus',
  windows: [
    {
      id: 'primary',
      label: '5-hour limit',
      usedPercent: 100,
      resetLabel: '-',
      resetAtMs: now + 52 * 60_000,
    },
    {
      id: 'secondary',
      label: 'Weekly limit',
      usedPercent: 87,
      resetLabel: '-',
      resetAtMs: now + 2 * DAY + 3 * HOUR,
    },
  ],
  rateLimitResetCreditsAvailableCount: 2,
  rateLimitResetCredits: [
    {
      id: 'a',
      status: 'available',
      grantedAt: '',
      expiresAt: new Date(now + 14 * DAY).toISOString(),
    },
    {
      id: 'b',
      status: 'available',
      grantedAt: '',
      expiresAt: new Date(now + 25 * DAY).toISOString(),
    },
  ],
  rateLimitResetCreditsError: '',
});

const claudeGrants = (now: number): AnthropicResetGrant[] =>
  [
    'New model launch: one Fable reset',
    "One more Fable reset at 12 months' tenure",
    "One more Fable reset at 6 months' tenure",
  ].map((label, index) => ({
    id: `grant-${index}`,
    label,
    resetsTotal: 1,
    resetsLeft: 1,
    startsAt: null,
    endsAt: new Date(now + 111 * DAY).toISOString(),
    clears: index === 0 ? ['five_hour', 'seven_day'] : ['seven_day'],
    paused: false,
    usableNow: true,
    useRequiresLimit: true,
    percentUsed: {},
    resetType: index === 0 ? 'full' : 'weekly',
    givesBackWeekly: false,
  }));

export function AvailabilityPreview() {
  const [now] = useState(() => Date.now());
  const files = useMemo(() => fixtures(now), [now]);
  const resolvedTheme = useThemeStore((state) => state.resolvedTheme);
  const showConfirmation = useNotificationStore((state) => state.showConfirmation);
  const showNotification = useNotificationStore((state) => state.showNotification);
  const [claudeOpen, setClaudeOpen] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const groups = useMemo(
    () => buildProviderGroups({}, files).filter((g) => g.id === 'codex' || g.id === 'claude'),
    [files]
  );
  const summary = useMemo(() => summarizeAvailability(files, now), [files, now]);
  const quota = useMemo(() => codexQuota(now), [now]);
  const noop = () => undefined;

  return (
    <div className={pageStyles.page} style={{ padding: 24 }}>
      <VaultHeader
        totalCount={summary.total}
        activeCount={summary.available}
        limitedCount={summary.limited}
        nextAvailableAt={summary.nextAvailableAt}
        problemCount={summary.attention}
        loading={false}
        refreshing={false}
        uploading={false}
        disableControls
        onUpload={noop}
        onRefresh={noop}
      />
      <VaultPulse files={files} statusBarCache={new Map()} />
      <div style={{ display: 'grid', gap: 16, margin: '24px 0' }}>
        {groups.map((group) => (
          <ProviderSubscriptionSummary key={group.id} group={group} status="ready" />
        ))}
      </div>
      <div className={pageStyles.grid}>
        {files.map((file) => (
          <AuthFileCard
            key={file.name}
            file={file}
            compact={false}
            selected={false}
            resolvedTheme={resolvedTheme}
            disableControls
            deleting={null}
            statusUpdating={{}}
            manualRefreshing={{}}
            cooldownResetting={{}}
            quotaFilterType={null}
            statusBarCache={new Map()}
            onShowModels={noop}
            onDownload={noop}
            onManualRefresh={noop}
            onCooldownReset={noop}
            onOpenPrefixProxyEditor={noop}
            onDelete={noop}
            onToggleStatus={noop}
            onToggleSelect={noop}
          />
        ))}
      </div>
      <div style={{ display: 'flex', gap: 8, margin: '24px 0' }}>
        <Button
          variant="secondary"
          onClick={() =>
            showConfirmation({
              title: 'Use a Codex manual reset',
              message: <CodexResetConfirmation quota={quota} name="co…lus@example.test" />,
              confirmText: 'Spend 1 manual reset',
              variant: 'primary',
              onConfirm: () => showNotification('Preview only: nothing was spent.', 'info'),
            })
          }
        >
          Preview Codex reset confirmation
        </Button>
        <Button variant="secondary" onClick={() => setClaudeOpen(true)}>
          Preview Claude reset dialog
        </Button>
      </div>
      <ClaudeResetGrantDialog
        open={claudeOpen}
        grants={claudeGrants(now)}
        selected={selected}
        canRedeemGrant={(id) => id !== 'grant-2'}
        unavailableReason={(grant) => (grant.id === 'grant-2' ? 'not_limited' : null)}
        onSelect={setSelected}
        busy={false}
        loading={false}
        message=""
        name="cl…max@example.test"
        renewals={automaticRenewals(
          [
            { id: 'five', label: '5-hour limit', usedPercent: 100, resetAtMs: now + 40 * 60_000 },
            { id: 'week', label: 'Weekly limit', usedPercent: 97, resetAtMs: now + 5 * DAY },
          ],
          now
        )}
        onConfirm={() => {
          setClaudeOpen(false);
          showNotification('Preview only: nothing was spent.', 'info');
        }}
        onClose={() => setClaudeOpen(false)}
      />
    </div>
  );
}
