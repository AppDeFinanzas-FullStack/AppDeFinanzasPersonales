import type { DashboardDto } from '@finanzas/contracts';
import { useTranslation } from 'react-i18next';
import { CartesianGrid, Legend, Line, LineChart, XAxis, YAxis } from 'recharts';

interface Props {
  data: DashboardDto['pace'];
}

interface Point {
  day: number;
  current?: number;
  previous?: number;
}

function merge(pace: DashboardDto['pace']): Point[] {
  const byDay = new Map<number, Point>();
  for (const row of pace.previous) {
    byDay.set(row.day, { day: row.day, previous: Number(row.cumulative) });
  }
  for (const row of pace.current) {
    byDay.set(row.day, { ...byDay.get(row.day), day: row.day, current: Number(row.cumulative) });
  }
  return [...byDay.values()].sort((a, b) => a.day - b.day);
}

/** "Ritmo del gasto": cumulative spending of the month against the previous one (RF-M8-06). */
export function PaceChart({ data }: Props) {
  const { t } = useTranslation('dashboard');
  const points = merge(data);

  return (
    <section className="flex flex-col gap-3" aria-labelledby="dashboard-pace">
      <h2 id="dashboard-pace" className="text-base font-semibold">
        {t('pace.title')}
      </h2>
      {points.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('pace.empty')}</p>
      ) : (
        <div className="overflow-x-auto">
          <LineChart width={320} height={200} data={points} role="img" aria-label={t('pace.title')}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis dataKey="day" />
            <YAxis width={48} />
            <Legend />
            <Line
              type="monotone"
              dataKey="current"
              name={t('pace.current')}
              stroke="hsl(var(--primary))"
              dot={false}
              isAnimationActive={false}
            />
            <Line
              type="monotone"
              dataKey="previous"
              name={t('pace.previous')}
              stroke="hsl(var(--muted-foreground))"
              strokeDasharray="4 4"
              dot={false}
              isAnimationActive={false}
            />
          </LineChart>
        </div>
      )}
    </section>
  );
}
