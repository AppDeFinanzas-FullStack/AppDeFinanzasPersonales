import type { AccountDto } from '@finanzas/contracts';
import { useTranslation } from 'react-i18next';

import { useFormatters } from '@/features/settings/hooks/use-settings';

import { useCurrencySymbol } from '../hooks/use-accounts';

/**
 * Balance of the account and its equivalent in the base currency. A card shows "Debes X" or "A favor
 * X", its limit, the credit available and a non-blocking notice over the limit (RF-M4-08).
 */
export function AccountHeader({ account, base }: { account: AccountDto; base: string }) {
  const { t } = useTranslation('accounts');
  const formatters = useFormatters();
  const symbolOf = useCurrencySymbol();
  const symbol = symbolOf(account.currencyCode);
  const card = account.type === 'credit_card' ? account.card : undefined;
  const debt = account.balance.startsWith('-');
  const balance =
    account.type !== 'credit_card'
      ? formatters.money(account.balance, symbol)
      : t(debt ? 'card.debt' : 'card.credit', {
          amount: formatters.money(debt ? account.balance.slice(1) : account.balance, symbol),
        });

  return (
    <section aria-labelledby="account-title" className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 id="account-title" className="text-lg font-semibold">
          {account.name}
          {account.status === 'archived' && (
            <span className="ml-2 text-sm font-normal text-muted-foreground">
              {t('detail.archived')}
            </span>
          )}
        </h2>
        <p className="text-3xl font-semibold tabular-nums" data-testid="account-balance">
          {balance}
        </p>
        {account.currencyCode !== base && (
          <p className="text-sm text-muted-foreground tabular-nums">
            {account.balanceInBase === null
              ? t('noRate')
              : t('summary.equivalent', {
                  amount: formatters.money(account.balanceInBase, symbolOf(base)),
                })}
          </p>
        )}
      </div>
      {card !== undefined && (
        <dl className="flex flex-col divide-y divide-border rounded-lg border border-border">
          <div className="flex items-baseline justify-between gap-4 px-4 py-3">
            <dt>{t('card.limit')}</dt>
            <dd className="text-right tabular-nums">
              {card.limit === null ? t('detail.noLimit') : formatters.money(card.limit, symbol)}
            </dd>
          </div>
          {card.creditAvailable !== null && (
            <div className="flex items-baseline justify-between gap-4 px-4 py-3">
              <dt>{t('detail.creditAvailable')}</dt>
              <dd className="text-right font-medium tabular-nums" data-testid="credit-available">
                {formatters.money(card.creditAvailable, symbol)}
              </dd>
            </div>
          )}
          <div className="flex items-baseline justify-between gap-4 px-4 py-3">
            <dt>{t('card.cutDay')}</dt>
            <dd className="text-right tabular-nums">{card.cutDay ?? t('detail.noDay')}</dd>
          </div>
          <div className="flex items-baseline justify-between gap-4 px-4 py-3">
            <dt>{t('card.payDay')}</dt>
            <dd className="text-right tabular-nums">{card.payDay ?? t('detail.noDay')}</dd>
          </div>
        </dl>
      )}
      {card?.overLimit === true && (
        <p role="status" className="rounded-lg border border-border px-4 py-3 font-medium">
          {t('detail.overLimit')}
        </p>
      )}
    </section>
  );
}
