import { LocalDate } from '@finanzas/contracts';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { z } from 'zod';

import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useFormatters } from '@/features/settings/hooks/use-settings';
import { call, type Endpoint } from '@/lib/api-client';

const BalanceSeries = z.object({
  points: z.array(z.object({ date: z.string(), balance: z.string() })),
});
type BalanceSeries = z.infer<typeof BalanceSeries>;

const SeriesQuery = z.object({ from: LocalDate, to: LocalDate });
type SeriesQuery = z.infer<typeof SeriesQuery>;

function balanceSeriesEndpoint(id: string): Endpoint<SeriesQuery, BalanceSeries> {
  return {
    method: 'GET',
    path: `/api/accounts/${encodeURIComponent(id)}/balance-series`,
    input: SeriesQuery,
    output: BalanceSeries,
  };
}

interface ChartPoint {
  date: string;
  /** ADR-03: the only place a balance becomes a `number`, to draw it. */
  y: number;
  balance: string;
}

/**
 * Balance at the end of each day of `from`–`to` (plan §4.4.4); the range lives in the URL and the
 * caller passes it, the current month by default.
 */
export function BalanceChart({
  accountId,
  symbol,
  range,
  onRangeChange,
}: {
  accountId: string;
  symbol: string;
  range: SeriesQuery;
  onRangeChange: (range: SeriesQuery) => void;
}) {
  const { t } = useTranslation('accounts');
  const formatters = useFormatters();
  const valid = range.from <= range.to;
  const series = useQuery({
    queryKey: ['accounts', 'balance-series', accountId, range.from, range.to],
    queryFn: ({ signal }) => call(balanceSeriesEndpoint(accountId), range, { signal }),
    enabled: valid,
    placeholderData: keepPreviousData,
  });
  const points: ChartPoint[] = (series.data?.points ?? []).map((point) => ({
    date: point.date,
    y: Number(point.balance),
    balance: point.balance,
  }));
  const last = points.at(-1);
  const description =
    last === undefined
      ? t('chart.altEmpty')
      : t('chart.alt', {
          amount: formatters.money(last.balance, symbol),
          date: formatters.date(last.date),
        });

  return (
    <section aria-labelledby="balance-chart" className="flex flex-col gap-4">
      <h2 id="balance-chart" className="text-lg font-semibold">
        {t('chart.title')}
      </h2>
      <div className="grid grid-cols-2 gap-4">
        <div className="flex flex-col gap-2">
          <Label htmlFor="chart-from">{t('chart.from')}</Label>
          <Input
            id="chart-from"
            type="date"
            className="h-11"
            value={range.from}
            max={range.to}
            onChange={(event) => {
              if (event.target.value !== '') onRangeChange({ ...range, from: event.target.value });
            }}
          />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="chart-to">{t('chart.to')}</Label>
          <Input
            id="chart-to"
            type="date"
            className="h-11"
            value={range.to}
            min={range.from}
            onChange={(event) => {
              if (event.target.value !== '') onRangeChange({ ...range, to: event.target.value });
            }}
          />
        </div>
      </div>
      {!valid ? (
        <p className="text-sm text-destructive">{t('chart.invalidRange')}</p>
      ) : series.isError && series.data === undefined ? (
        <p role="alert" className="text-sm text-destructive">
          {t('chart.loadError')}
        </p>
      ) : (
        <div role="img" aria-label={description} className="h-56">
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
                  width={56}
                  tick={{ fontSize: 12, fill: 'hsl(var(--muted-foreground))' }}
                  stroke="hsl(var(--border))"
                />
                <Tooltip
                  formatter={(_y, _name, item) => [
                    formatters.money((item.payload as ChartPoint).balance, symbol),
                    t('chart.balance'),
                  ]}
                  labelFormatter={(date) => (typeof date === 'string' ? formatters.date(date) : '')}
                  contentStyle={{
                    background: 'hsl(var(--popover))',
                    border: '1px solid hsl(var(--border))',
                    borderRadius: 'var(--radius)',
                  }}
                />
                <Line
                  type="stepAfter"
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
