import { useTranslation } from 'react-i18next';

import { Skeleton } from '@/components/ui/skeleton';
import { useCurrencySymbol } from '@/features/accounts/hooks/use-accounts';
import { useFormatters } from '@/features/settings/hooks/use-settings';

import type { RegisterAccount } from '../api';

import type { RegisterKind } from './kind-toggle';

const unsigned = (amount: string): string => (amount.startsWith('-') ? amount.slice(1) : amount);

interface AccountChipProps {
  account: RegisterAccount | undefined;
  kind: RegisterKind;
  loading: boolean;
}

/**
 * `<AccountChip>` (plan §4.7.4): the preselected account with its free balance; a card shows its
 * available credit when it has a limit, or its debt (RF-M7-11). An expense from an account
 * dedicated to a goal warns that it takes from the goal (RF-M7-14).
 */
export function AccountChip({ account, kind, loading }: AccountChipProps) {
  const { t } = useTranslation('register');
  const formatters = useFormatters();
  const symbolOf = useCurrencySymbol();

  if (account === undefined) {
    return loading ? <Skeleton className="h-14 w-full" /> : null;
  }

  const symbol = symbolOf(account.currencyCode);
  const balance =
    account.card === undefined
      ? t('account.free', { amount: formatters.money(account.free, symbol) })
      : account.card.creditAvailable !== null
        ? t('account.creditAvailable', {
            amount: formatters.money(account.card.creditAvailable, symbol),
          })
        : t('account.debt', {
            amount: formatters.money(
              account.free.startsWith('-') ? unsigned(account.free) : '0.00',
              symbol,
            ),
          });

  return (
    <div className="flex flex-col gap-1 rounded-md border border-border px-3 py-2">
      <span className="text-sm text-muted-foreground">{t('account.label')}</span>
      <span className="flex flex-wrap items-baseline justify-between gap-x-4">
        <span className="text-base font-medium">{account.name}</span>
        <span className="text-sm tabular-nums text-muted-foreground">{balance}</span>
      </span>
      {kind === 'expense' && account.dedicatedGoal !== undefined && (
        <span className="text-sm text-muted-foreground">
          {t('account.goal', { name: account.dedicatedGoal.name })}
        </span>
      )}
    </div>
  );
}
