import { RateHistoryQuery, type UsdReference } from '@finanzas/contracts';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useFormatters } from '@/features/settings/hooks/use-settings';

import { useRateHistory, type RateHistory, type RateHistoryRange } from '../hooks/use-rate-history';

const RANGES = RateHistoryQuery.shape.range.options;

interface ChartPoint {
  date: string;
  /** ADR-03: the only place a rate becomes a `number`, to draw it. */
  y: number;
  value: string;
}

function toChartPoints(history: RateHistory): ChartPoint[] {
  return history.points.map((point) => ({
    date: point.date,
    y: Number(point.value),
    value: point.value,
  }));
}

function isRange(value: string): value is RateHistoryRange {
  return (RANGES as readonly string[]).includes(value);
}

/** Daily evolution of one USD reference, with 7d/30d/90d/1a tabs (plan §4.3.4). */
export function RateHistoryChart({ kind }: { kind: UsdReference }) {
  const { t } = useTranslation('fx');
  const formatters = useFormatters();
  const [range, setRange] = useState<RateHistoryRange>('30d');
  const history = useRateHistory(kind, range);
  const points = history.data === undefined ? [] : toChartPoints(history.data);
  const last = points.at(-1);
  const kindName = t(`kinds.${kind}`);
  const rangeName = t(`history.ranges.${range}`);
  const description =
    last === undefined
      ? t('history.altEmpty', { kind: kindName, range: rangeName })
      : t('history.alt', {
          kind: kindName,
          range: rangeName,
          value: formatters.money(last.value, 'Bs'),
          date: formatters.date(last.date),
        });

  return (
    <section aria-labelledby="fx-history" className="flex flex-col gap-4">
      <h2 id="fx-history" className="text-lg font-semibold">
        {t('history.title', { kind: kindName })}
      </h2>
      <Tabs
        value={range}
        onValueChange={(value) => {
          if (isRange(value)) setRange(value);
        }}
      >
        <TabsList aria-label={t('history.rangesLabel')}>
          {RANGES.map((option) => (
            <TabsTrigger
              key={option}
              value={option}
              // The range changes the chart below; there is no tab panel to point at.
              aria-controls={undefined}
              className="min-h-11 px-4"
            >
              {t(`history.ranges.${option}`)}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      {history.isError && history.data === undefined ? (
        <p role="alert" className="text-sm text-destructive">
          {t('history.loadError')}
        </p>
      ) : (
        <div role="img" aria-label={description} data-testid="rate-history-chart" className="h-56">
          {points.length > 0 && (
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={points} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                <XAxis
                  dataKey="date"
                  tickFormatter={(date: string) => formatters.date(date)}
                  tick={{ fontSize: 12, fill: 'hsl(var(--muted-foreground))' }}
                  stroke="hsl(var(--border))"
                  minTickGap={24}
                />
                <YAxis
                  dataKey="y"
                  domain={['auto', 'auto']}
                  width={48}
                  tick={{ fontSize: 12, fill: 'hsl(var(--muted-foreground))' }}
                  stroke="hsl(var(--border))"
                />
                <Tooltip
                  formatter={(_y, _name, item) => [
                    formatters.money((item.payload as ChartPoint).value, 'Bs'),
                    kindName,
                  ]}
                  labelFormatter={(date) => (typeof date === 'string' ? formatters.date(date) : '')}
                  contentStyle={{
                    background: 'hsl(var(--popover))',
                    border: '1px solid hsl(var(--border))',
                    borderRadius: 'var(--radius)',
                  }}
                />
                <Line
                  type="monotone"
                  dataKey="y"
                  stroke="hsl(var(--primary))"
                  strokeWidth={2}
                  dot={false}
                  isAnimationActive={false}
                />
              </LineChart>
            </ResponsiveContainer>
          )}
        </div>
      )}
      <p aria-hidden="true" className="text-sm text-muted-foreground">
        {description}
      </p>
    </section>
  );
}
