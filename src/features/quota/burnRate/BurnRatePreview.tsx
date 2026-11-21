import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Select';
import { useThemeStore } from '@/stores';
import { BurnRateView } from './BurnRateView';
import {
  burnRateFixture,
  BURN_PREVIEW_MODES,
  BURN_PREVIEW_NOW,
  type BurnPreviewMode,
} from './fixtures';
import styles from './BurnRate.module.scss';

export function BurnRatePreview() {
  const { t } = useTranslation();
  const [mode, setMode] = useState<BurnPreviewMode>('ready');
  const [connected, setConnected] = useState(true);
  const theme = useThemeStore((s) => s.resolvedTheme);
  const setTheme = useThemeStore((s) => s.setTheme);
  const state = useMemo(() => burnRateFixture(mode), [mode]);
  return (
    <main className={styles.preview}>
      <div className={styles.previewControls}>
        <Select
          value={mode}
          onChange={(value) => setMode(value as BurnPreviewMode)}
          fullWidth={false}
          ariaLabel={t('burn_rate.preview_state')}
          options={BURN_PREVIEW_MODES.map((value) => ({
            value,
            label: t(`burn_rate.preview_${value}`),
          }))}
        />
        <Button variant="secondary" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>
          {t('burn_rate.toggle_theme')}
        </Button>
        <Button variant="secondary" onClick={() => setConnected((value) => !value)}>
          {t('burn_rate.toggle_connection')}
        </Button>
      </div>
      <BurnRateView
        state={state}
        connected={connected}
        now={BURN_PREVIEW_NOW}
        onRefresh={() => setMode('ready')}
      />
    </main>
  );
}
