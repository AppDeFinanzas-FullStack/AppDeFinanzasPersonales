import { useTranslation } from 'react-i18next';

import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { useCurrencySymbol } from '@/features/accounts/hooks/use-accounts';
import { useFormatters } from '@/features/settings/hooks/use-settings';

import type { RegisterAccount } from '../api';

import type { RegisterKind } from './kind-toggle';

const unsigned = (amount: string): string => (amount.startsWith('-') ? amount.slice(1) : amount);

const selectClass =
  'flex h-11 w-full rounded-md border border-input bg-background px-3 py-2 text-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:text-sm';

interface AccountChipProps {
  account: RegisterAccount | undefined;
  /** Every active account, to change the one the movement uses right here. */
  accounts: readonly RegisterAccount[];
  onChange: (id: string) => void;
  kind: RegisterKind;
  loading: boolean;
}

/**
 * `<AccountChip>` (plan §4.7.4): the account of the movement, preselected and changeable on the
 * spot, with its free balance; a card shows its available credit when it has a limit, or its debt
 * (RF-M7-11). An expense from an account dedicated to a goal warns that it takes from the goal
 * (RF-M7-14).
 */
export function AccountChip({ account, accounts, onChange, kind, loading }: AccountChipProps) {
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
    <div className="flex flex-col gap-2 rounded-md border border-border px-3 py-2">
      <Label htmlFor="register-account" className="text-sm text-muted-foreground">
        {t('account.label')}
      </Label>
      <select
        id="register-account"
        className={selectClass}
        value={account.id}
        onChange={(event) => {
          onChange(event.target.value);
        }}
      >
        {accounts.map((item) => (
          <option key={item.id} value={item.id}>
            {item.name} ({item.currencyCode})
          </option>
        ))}
      </select>
      <span className="text-sm tabular-nums text-muted-foreground">{balance}</span>
      {kind === 'expense' && account.dedicatedGoal !== undefined && (
        <span className="text-sm text-muted-foreground">
          {t('account.goal', { name: account.dedicatedGoal.name })}
        </span>
      )}
    </div>
  );
}
