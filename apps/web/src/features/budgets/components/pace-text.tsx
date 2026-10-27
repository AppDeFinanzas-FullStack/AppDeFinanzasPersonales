import type { BudgetDto } from '@finanzas/contracts';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';

type Pace = NonNullable<BudgetDto['current']>['pace'];

/** "Puedes gastar … por día durante … días", "Vas … por encima del ritmo" or "Superado por …". */
export function PaceText({
  pace,
  symbol,
  money,
  className,
}: {
  pace: Pace;
  symbol: string;
  money: (amount: string, symbol: string) => string;
  className?: string;
}) {
  const { t } = useTranslation('budgets');
  const amount = money(pace.amount, symbol);
  const text =
    pace.kind === 'daily'
      ? t('pace.daily', { amount, count: pace.days ?? 1 })
      : t(`pace.${pace.kind}`, { amount });
  return <p className={cn('tabular-nums', className)}>{text}</p>;
}
