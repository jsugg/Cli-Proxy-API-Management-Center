import { memo, useId, useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { burnLimitLabel } from './labels';
import { BURN_FORWARD_MS, BURN_HISTORY_MS, type BurnGroup, type BurnPoint } from './model';
import styles from './BurnRate.module.scss';

interface ChartProps {
  groups: BurnGroup[];
  provider: string;
  now: number;
}

/** Null grid cells break paths; a missing measurement never becomes a zero. */
function segments(points: readonly BurnPoint[]): BurnPoint[][] {
  const result: BurnPoint[][] = [];
  let current: BurnPoint[] | null = null;
  for (const point of points) {
    if (point.remaining === null) {
      current = null;
      continue;
    }
    if (!current || point.boundary) {
      current = [];
      result.push(current);
    }
    current.push(point);
  }
  return result;
}
export function BurnRateChart({ groups, provider, now }: ChartProps) {
  const { t, i18n } = useTranslation();
  const id = useId();
  const from = now - BURN_HISTORY_MS;
  const to = now + BURN_FORWARD_MS;
  const x = (at: number) => Math.max(0, Math.min(100, ((at - from) / (to - from)) * 100));
  const ticks: number[] = [];
  const day = new Date(from);
  day.setHours(24, 0, 0, 0);
  while (day.getTime() < to) {
    ticks.push(day.getTime());
    day.setDate(day.getDate() + 1);
  }
  const label = (group: BurnGroup) => burnLimitLabel(t, provider, group, groups);
  const percent = (value: number | null) =>
    value === null
      ? t('quota_pool.unknown')
      : `${value.toLocaleString(i18n.language, { maximumFractionDigits: 1 })}%`;
  const date = (at: number) =>
    new Date(at).toLocaleString(i18n.language, {
      weekday: 'short',
      hour: 'numeric',
      minute: '2-digit',
    });
  const primary = groups[0];
  // Keep the geometry element stable when the surrounding chart renders.
  const geometry = useMemo(
    () => <ChartGeometry groups={groups} provider={provider} now={now} id={id} />,
    [groups, provider, now, id]
  );
  return (
    <div className={styles.chartBlock}>
      <div className={styles.chartLabels}>
        <span>{t('burn_rate.now', { value: percent(primary.remaining) })}</span>
        {groups.map((group) => (
          <span key={group.key}>
            {label(group)} {percent(group.remaining)}
          </span>
        ))}
        <span>
          {t('burn_rate.reset_label', { time: date(primary.nextReset) })}
          {primary.nextReset > to ? ' →' : ''}
        </span>
      </div>
      <HoverLayer groups={groups} provider={provider} now={now}>
        <div className={styles.yAxis} aria-hidden="true">
          {[100, 75, 50, 25, 0].map((n) => (
            <span key={n}>{n}%</span>
          ))}
        </div>
        {geometry}
      </HoverLayer>
      <div className={styles.xAxis} aria-hidden="true">
        {ticks.map((at) => (
          <span key={at} style={{ left: `${x(at)}%` }}>
            {new Date(at).toLocaleDateString(i18n.language, { weekday: 'short' })}
          </span>
        ))}
      </div>
      <RecordedValues groups={groups} provider={provider} />
    </div>
  );
}

function HoverLayer({ groups, provider, now, children }: ChartProps & { children: ReactNode }) {
  const { t, i18n } = useTranslation();
  const [hover, setHover] = useState<number | null>(null);
  const from = now - BURN_HISTORY_MS;
  const to = now + BURN_FORWARD_MS;
  const label = (group: BurnGroup) => burnLimitLabel(t, provider, group, groups);
  const percent = (value: number | null) =>
    value === null
      ? t('quota_pool.unknown')
      : `${value.toLocaleString(i18n.language, { maximumFractionDigits: 1 })}%`;
  const date = (at: number) =>
    new Date(at).toLocaleString(i18n.language, {
      weekday: 'short',
      hour: 'numeric',
      minute: '2-digit',
    });
  const hoveredAt = hover === null ? null : from + (hover / 100) * (to - from);
  const hoverValues = groups.map((group) => {
    if (hoveredAt === null) return null;
    if (hoveredAt <= now) {
      const right = group.history.findIndex((point) => point.at > hoveredAt);
      const index = right === -1 ? group.history.length - 1 : right - 1;
      return group.history[index]?.remaining ?? null;
    }
    const points = group.projection;
    if (!points || hoveredAt > group.nextReset) return null;
    const right = points.findIndex((point) => point.at >= hoveredAt);
    if (right <= 0) return points[0]?.remaining ?? null;
    const a = points[right - 1],
      b = points[right];
    return a.remaining! + ((b.remaining! - a.remaining!) * (hoveredAt - a.at)) / (b.at - a.at);
  });
  return (
    <div
      className={styles.plot}
      onPointerLeave={() => setHover(null)}
      onPointerMove={(event) => {
        const rect = event.currentTarget.getBoundingClientRect();
        setHover(Math.max(0, Math.min(100, ((event.clientX - rect.left) / rect.width) * 100)));
      }}
    >
      {children}
      {hoveredAt !== null && (
        <>
          <svg
            className={styles.hoverOverlay}
            viewBox="0 0 100 100"
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            <line
              x1={hover!}
              x2={hover!}
              y1="0"
              y2="100"
              className={styles.crosshair}
              vectorEffect="non-scaling-stroke"
            />
          </svg>
          <div className={styles.tooltip} style={{ left: `${Math.min(65, hover ?? 0)}%` }}>
            <strong>{date(hoveredAt)}</strong>
            {groups.map((group, i) => (
              <div key={group.key}>
                {label(group)}: {percent(hoverValues[i])}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// Hover state lives in a sibling layer; data changes alone rebuild the paths.
const ChartGeometry = memo(function ChartGeometry({
  groups,
  provider,
  now,
  id,
}: ChartProps & { id: string }) {
  const { t } = useTranslation();
  const from = now - BURN_HISTORY_MS;
  const to = now + BURN_FORWARD_MS;
  const x = (at: number) => Math.max(0, Math.min(100, ((at - from) / (to - from)) * 100));
  const ticks: number[] = [];
  const day = new Date(from);
  day.setHours(24, 0, 0, 0);
  while (day.getTime() < to) {
    ticks.push(day.getTime());
    day.setDate(day.getDate() + 1);
  }
  const path = (points: BurnPoint[]) =>
    points.map((p, i) => `${i ? 'L' : 'M'}${x(p.at)},${100 - p.remaining!}`).join(' ');
  return (
    <>
      <svg
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        role="img"
        aria-labelledby={`${id}-title ${id}-desc`}
      >
        <title id={`${id}-title`}>{t('burn_rate.chart_title', { provider })}</title>
        <desc id={`${id}-desc`}>{t('burn_rate.chart_description')}</desc>
        <defs>
          <clipPath id={`${id}-clip`}>
            <rect width="100" height="100" />
          </clipPath>
        </defs>
        <rect x={x(now)} width={100 - x(now)} height="100" className={styles.future} />
        {[0, 25, 50, 75, 100].map((y) => (
          <line
            key={y}
            x1="0"
            x2="100"
            y1={y}
            y2={y}
            className={styles.grid}
            vectorEffect="non-scaling-stroke"
          />
        ))}
        {ticks.map((at) => (
          <line
            key={at}
            x1={x(at)}
            x2={x(at)}
            y1="0"
            y2="100"
            className={styles.grid}
            vectorEffect="non-scaling-stroke"
          />
        ))}
        <g clipPath={`url(#${id}-clip)`}>
          {groups.map((group, index) => (
            <g key={group.key} style={{ color: `var(--series-${group.color})` }}>
              {segments(group.history).map((points, segment) => (
                <g key={segment}>
                  {index === 0 && (
                    <path
                      d={`${path(points)} L${x(points[points.length - 1].at)},100 L${x(points[0].at)},100 Z`}
                      fill="currentColor"
                      opacity=".12"
                    />
                  )}
                  <path
                    d={path(points)}
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    vectorEffect="non-scaling-stroke"
                  />
                </g>
              ))}
              {group.pastResets.map((at) => (
                <line
                  key={at}
                  x1={x(at)}
                  x2={x(at)}
                  y1="0"
                  y2="100"
                  stroke="currentColor"
                  opacity=".4"
                  strokeDasharray="3 4"
                  vectorEffect="non-scaling-stroke"
                />
              ))}
              {group.projection && (
                <path
                  data-projection="true"
                  d={path(
                    group.projection
                      .filter((p) => p.at <= to)
                      .concat(
                        group.projection.some((p) => p.at > to)
                          ? [
                              {
                                at: to,
                                remaining: (() => {
                                  const right = group.projection!.findIndex((p) => p.at > to);
                                  const a = group.projection![right - 1],
                                    b = group.projection![right];
                                  return (
                                    a.remaining! +
                                    ((b.remaining! - a.remaining!) * (to - a.at)) / (b.at - a.at)
                                  );
                                })(),
                              },
                            ]
                          : []
                      )
                  )}
                  fill="none"
                  stroke="currentColor"
                  strokeDasharray="3 4"
                  vectorEffect="non-scaling-stroke"
                />
              )}
              {group.refills
                .filter((p) => p.at <= to)
                .map((point) => (
                  <line
                    key={point.at}
                    x1={x(point.at)}
                    x2={x(point.at)}
                    y1="0"
                    y2="100"
                    stroke="currentColor"
                    strokeDasharray="4 4"
                    vectorEffect="non-scaling-stroke"
                  />
                ))}
            </g>
          ))}
          <line
            x1={x(now)}
            x2={x(now)}
            y1="0"
            y2="100"
            className={styles.nowLine}
            vectorEffect="non-scaling-stroke"
          />
        </g>
      </svg>
      {/* HTML dots keep a circular shape while the SVG scales to the available width. */}
      <div className={styles.markers} aria-hidden="true">
        {groups.flatMap((group) => [
          <i
            key={`${group.key}-now`}
            className={styles.dot}
            style={{
              left: `${x(now)}%`,
              top: `${100 - group.remaining}%`,
              background: `var(--series-${group.color})`,
            }}
          />,
          ...group.refills
            .filter((p) => p.at <= to && p.remaining !== null)
            .map((point) => (
              <i
                key={`${group.key}-${point.at}`}
                className={styles.dot}
                style={{
                  left: `${x(point.at)}%`,
                  top: `${100 - point.remaining!}%`,
                  borderColor: `var(--series-${group.color})`,
                }}
              />
            )),
        ])}
      </div>
    </>
  );
});

const RecordedValues = memo(function RecordedValues({ groups, provider }: Omit<ChartProps, 'now'>) {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState(false);
  const primary = groups[0];
  const label = (group: BurnGroup) => burnLimitLabel(t, provider, group, groups);
  const percent = (value: number | null) =>
    value === null
      ? t('quota_pool.unknown')
      : `${value.toLocaleString(i18n.language, { maximumFractionDigits: 1 })}%`;
  return (
    <details className={styles.details} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>{t('burn_rate.table')}</summary>
      {open && (
        <>
          <p className={styles.note}>{t('burn_rate.table_note')}</p>
          <div className={styles.tableScroll}>
            <table>
              <caption>{t('burn_rate.chart_title', { provider })}</caption>
              <thead>
                <tr>
                  <th scope="col">{t('quota_history.observed_at')}</th>
                  {groups.map((group) => (
                    <th scope="col" key={group.key}>
                      {label(group)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {primary.history.map((point, index) => (
                  <tr key={point.at}>
                    <th scope="row">{new Date(point.at).toLocaleString(i18n.language)}</th>
                    {groups.map((group) => (
                      <td key={group.key}>{percent(group.history[index]?.remaining ?? null)}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </details>
  );
});
