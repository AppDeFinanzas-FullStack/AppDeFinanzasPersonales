import { PALETTE, type GoalDto } from '@finanzas/contracts';
import type { CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';

import { useCurrencySymbol } from '@/features/accounts/hooks/use-accounts';
import { useFormatters } from '@/features/settings/hooks/use-settings';

type RingGoal = Pick<GoalDto, 'color' | 'pct' | 'name'>;

/** Progress ring: the percentage is text and `aria-valuenow`, never only color (design). */
export function ProgressRing({
  goal,
  size,
  stroke,
}: {
  goal: RingGoal;
  size: number;
  stroke: number;
}) {
  const { t } = useTranslation('goals');
  const value = Math.max(0, Math.min(100, Math.round(goal.pct)));
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  return (
    <div
      role="progressbar"
      aria-label={t('ring.label', { name: goal.name })}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={value}
      className="relative inline-flex shrink-0 items-center justify-center"
      style={
        {
          width: size,
          height: size,
          '--swatch-light': PALETTE[goal.color].light,
          '--swatch-dark': PALETTE[goal.color].dark,
        } as CSSProperties
      }
    >
      <svg width={size} height={size} className="-rotate-90" aria-hidden="true">
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          strokeWidth={stroke}
          className="stroke-muted"
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          strokeWidth={stroke}
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - value / 100)}
          className="stroke-[var(--swatch-light)] dark:stroke-[var(--swatch-dark)]"
        />
      </svg>
      <span className="absolute text-sm font-medium tabular-nums">{value}%</span>
    </div>
  );
}

/** The big progress of a goal: amount reached, target and ring. */
export function GoalProgress({ goal }: { goal: GoalDto }) {
  const { t } = useTranslation('goals');
  const formatters = useFormatters();
  const symbol = useCurrencySymbol()(goal.currencyCode);
  const until =
    goal.targetDate === undefined
      ? ''
      : ` · ${t('progress.until', { date: formatters.date(goal.targetDate) })}`;
  return (
    <section aria-labelledby="goal-title" className="flex items-center gap-4">
      <ProgressRing goal={goal} size={96} stroke={8} />
      <div className="flex flex-col gap-1">
        <h2 id="goal-title" className="text-2xl font-semibold">
          {goal.name}
        </h2>
        <p className="text-3xl font-semibold tabular-nums" data-testid="goal-progress">
          {formatters.money(goal.progress, symbol)}
        </p>
        <p className="text-sm text-muted-foreground tabular-nums">
          {t('progress.of', { target: formatters.money(goal.target, symbol) })}
        </p>
        <p className="text-sm text-muted-foreground">
          {t(`status.${goal.status}`)}
          {until}
        </p>
      </div>
    </section>
  );
}
