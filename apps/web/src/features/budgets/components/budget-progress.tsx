import { PALETTE, type BudgetDto } from '@finanzas/contracts';
import { isGreaterThan, parseMoney } from '@finanzas/domain';
import type { CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';

import { useCurrencySymbol } from '@/features/accounts/hooks/use-accounts';
import { useFormatters } from '@/features/settings/hooks/use-settings';

import { PaceText } from './pace-text';

type Current = NonNullable<BudgetDto['current']>;

const FULL = 100;

/** Share of `part` in `whole` as a whole percentage; nothing available counts as full (EC-M11-01). */
function percentOf(part: string, whole: string): number {
  const total = parseMoney(whole);
  if (!isGreaterThan(total, parseMoney('0'))) return FULL;
  return parseMoney(part).div(total).times(FULL).toDecimalPlaces(0).toNumber();
}

/** Name of a budget: its category or the general budget. */
export function useBudgetName(): (budget: Pick<BudgetDto, 'category'>) => string {
  const { t } = useTranslation('budgets');
  return (budget) => budget.category?.name ?? t('general');
}

/**
 * Bar of 8 px over `--muted`, in the color of the category (`--primary` for the general budget),
 * with the thresholds and, in the detail, the mark of "hoy deberías llevar" (design, M11). Past
 * 100 % it stays full and the text says "Superado por …"; the percentage is always text too.
 */
export function BudgetBar({
  budget,
  current,
  showToday = false,
}: {
  budget: Pick<BudgetDto, 'category' | 'thresholds' | 'currencyCode'>;
  current: Current;
  showToday?: boolean;
}) {
  const { t } = useTranslation('budgets');
  const formatters = useFormatters();
  const symbol = useCurrencySymbol()(budget.currencyCode);
  const name = useBudgetName()(budget);
  const pct = percentOf(current.spent, current.available);
  const filled = Math.max(0, Math.min(FULL, pct));
  const today = Math.min(FULL, percentOf(current.todayShouldBe, current.available));
  const text = t('progress.spentOf', {
    pct,
    spent: formatters.money(current.spent, symbol),
    available: formatters.money(current.available, symbol),
  });
  const color = budget.category === undefined ? undefined : PALETTE[budget.category.color];
  const style = (
    color === undefined ? {} : { '--swatch-light': color.light, '--swatch-dark': color.dark }
  ) as CSSProperties;
  return (
    <div className="flex flex-col gap-1">
      <div
        role="progressbar"
        aria-label={t('progress.label', { name })}
        aria-valuemin={0}
        aria-valuemax={FULL}
        aria-valuenow={filled}
        aria-valuetext={text}
        className="relative h-2 w-full rounded-full bg-muted"
        style={style}
      >
        <div
          className={
            color === undefined
              ? 'h-2 rounded-full bg-primary'
              : 'h-2 rounded-full bg-[var(--swatch-light)] dark:bg-[var(--swatch-dark)]'
          }
          style={{ width: `${String(filled)}%` }}
        />
        {budget.thresholds
          .filter((threshold) => threshold < FULL)
          .map((threshold) => (
            <span
              key={threshold}
              aria-hidden="true"
              className="absolute -top-1 h-4 w-px bg-muted-foreground"
              style={{ left: `${String(threshold)}%` }}
            />
          ))}
        {showToday && pct < FULL && (
          <span
            aria-hidden="true"
            className="absolute -top-1.5 h-5 w-0.5 bg-foreground"
            style={{ left: `${String(today)}%` }}
          />
        )}
      </div>
      <p className="text-sm text-muted-foreground tabular-nums">{text}</p>
    </div>
  );
}

/** The detail's main figure: the available in 32 px, the pace and the bar with "hoy deberías llevar". */
export function BudgetProgress({ budget, current }: { budget: BudgetDto; current: Current }) {
  const { t } = useTranslation('budgets');
  const formatters = useFormatters();
  const symbol = useCurrencySymbol()(budget.currencyCode);
  return (
    <section aria-labelledby="budget-available" className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h3 id="budget-available" className="text-sm text-muted-foreground">
          {t('progress.available')}
        </h3>
        <p className="text-3xl font-semibold tabular-nums">
          {formatters.money(current.available, symbol)}
        </p>
        <PaceText pace={current.pace} symbol={symbol} money={formatters.money} />
      </div>
      <BudgetBar budget={budget} current={current} showToday />
      <p className="text-sm text-muted-foreground tabular-nums">
        {t('progress.todayShouldBe', { amount: formatters.money(current.todayShouldBe, symbol) })}
      </p>
      <p className="text-sm text-muted-foreground">
        {t('period', {
          start: formatters.date(current.start),
          end: formatters.date(current.end),
        })}
      </p>
    </section>
  );
}
