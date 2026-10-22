import type { GoalDto } from '@finanzas/contracts';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import { useCurrencySymbol } from '@/features/accounts/hooks/use-accounts';
import { useFormatters } from '@/features/settings/hooks/use-settings';

import { ProgressRing } from './goal-progress';

/** Cards of the goals, each with its progress ring and its status (plan §4.12.4). */
export function GoalCards({ goals }: { goals: readonly GoalDto[] }) {
  const { t } = useTranslation('goals');
  const formatters = useFormatters();
  const symbolOf = useCurrencySymbol();
  return (
    <ul className="flex flex-col gap-3">
      {goals.map((goal) => (
        <li key={goal.id}>
          <Link
            to={`/metas/${goal.id}`}
            className="flex min-h-11 items-center gap-4 rounded-lg border border-border p-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ProgressRing goal={goal} size={56} stroke={4} />
            <span className="flex flex-1 flex-col gap-1">
              <span className="font-medium">{goal.name}</span>
              <span className="text-sm text-muted-foreground tabular-nums">
                {t('progress.reachedOf', {
                  progress: formatters.money(goal.progress, symbolOf(goal.currencyCode)),
                  target: formatters.money(goal.target, symbolOf(goal.currencyCode)),
                })}
              </span>
            </span>
            <span className="rounded-[calc(var(--radius)-2px)] border border-border px-2 py-1 text-sm">
              {t(`status.${goal.status}`)}
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
