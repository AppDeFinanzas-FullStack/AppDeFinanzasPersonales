import type { DebtDto } from '@finanzas/contracts';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { useCurrencySymbol } from '@/features/accounts/hooks/use-accounts';
import { useFormatters } from '@/features/settings/hooks/use-settings';
import { ApiError } from '@/lib/api-client';
import { messageForError } from '@/lib/i18n-errors';

import { useDeleteLastPayment } from '../hooks/use-debts';

/** The payments of a debt; only the last one can be deleted (EC-M13-05). */
export function PaymentsList({ debt }: { debt: DebtDto }) {
  const { t } = useTranslation('debts');
  const formatters = useFormatters();
  const symbol = useCurrencySymbol()(debt.currencyCode);
  const deleteLast = useDeleteLastPayment(debt.id);
  const lastId =
    debt.canDeleteLastPayment && debt.status !== 'forgiven' ? debt.payments.at(-1)?.id : undefined;
  return (
    <section aria-labelledby="payments-title" className="flex flex-col gap-3">
      <h3 id="payments-title" className="text-lg font-semibold">
        {t('payments.title')}
      </h3>
      {debt.payments.length === 0 ? (
        <p className="text-muted-foreground">{t('payments.empty')}</p>
      ) : (
        <ul className="flex flex-col divide-y divide-border">
          {debt.payments.map((payment) => (
            <li key={payment.id} className="flex flex-col gap-2 py-3">
              <div className="flex min-h-11 items-center justify-between gap-4">
                <span className="flex flex-col">
                  <span>{formatters.date(payment.date)}</span>
                  <span className="text-sm text-muted-foreground tabular-nums">
                    {t('payments.split', {
                      capital: formatters.money(payment.capitalPart, symbol),
                      interest: formatters.money(payment.interestPart, symbol),
                    })}
                  </span>
                </span>
                <span className="tabular-nums">{formatters.money(payment.amount, symbol)}</span>
              </div>
              {payment.id === lastId && (
                <Button
                  type="button"
                  variant="outline"
                  className="h-11 self-start"
                  disabled={deleteLast.isPending}
                  onClick={() => {
                    deleteLast.mutate();
                  }}
                >
                  {t('payments.deleteLast')}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {deleteLast.isError && (
        <p role="alert" className="text-sm text-destructive">
          {messageForError(deleteLast.error instanceof ApiError ? deleteLast.error : { code: '' })}
        </p>
      )}
    </section>
  );
}
