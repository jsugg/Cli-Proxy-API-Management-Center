import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Card } from '@/components/ui/Card';
import type { ProviderGroup } from '../types';

interface ProviderSubscriptionSummaryProps {
  group: ProviderGroup;
  status: 'loading' | 'ready' | 'error';
}

export function ProviderSubscriptionSummary({ group, status }: ProviderSubscriptionSummaryProps) {
  const { t } = useTranslation();
  if (group.id !== 'claude' && group.id !== 'codex') return null;
  return (
    <Card
      title={`${t(`providersPage.providerNames.${group.id}`)} · ${t('providersPage.subscriptions.title')}`}
    >
      <p role={status === 'error' ? 'alert' : 'status'}>
        {status !== 'ready'
          ? t(status === 'error' ? 'providersPage.subscriptions.error' : 'common.loading')
          : t('providersPage.categories.activeCount', {
              active: group.subscriptions?.active ?? 0,
              total: group.subscriptions?.total ?? 0,
            })}
      </p>
      <Link to="/auth-files">{t('providersPage.subscriptions.manage')}</Link>
    </Card>
  );
}
