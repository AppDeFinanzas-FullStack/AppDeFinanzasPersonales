import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { z } from 'zod';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useCurrencySymbol } from '@/features/accounts/hooks/use-accounts';
import { useFormatters } from '@/features/settings/hooks/use-settings';
import { ApiError, call, type Endpoint } from '@/lib/api-client';

import { TransactionItem } from '../api';
import { TRANSACTIONS_KEY } from '../hooks/use-transactions';

import { useSignedMoney } from './transaction-row';

/** A movement with its fee and its origin for "Ir a…" (`GET /api/transactions/:id`). */
export const TransactionDetailData = TransactionItem.extend({ fee: TransactionItem.optional() });
export type TransactionDetailData = z.infer<typeof TransactionDetailData>;

export const transactionEndpoint = (id: string): Endpoint<undefined, TransactionDetailData> => ({
  method: 'GET',
  path: `/api/transactions/${encodeURIComponent(id)}`,
  input: z.undefined(),
  output: TransactionDetailData,
});

export const isGone = (error: unknown): boolean =>
  error instanceof ApiError && error.code === 'NOT_FOUND';

/** The movement of `/movimientos/:id`; a deleted or foreign one is not retried (EC-M6-02). */
export function useTransaction(id: string) {
  return useQuery({
    queryKey: [...TRANSACTIONS_KEY, 'detail', id],
    queryFn: ({ signal }) => call(transactionEndpoint(id), undefined, { signal }),
    retry: (count, error) => !isGone(error) && count < 3,
  });
}

/** The origins whose amount, account and date are edited elsewhere (RF-M6-09). */
const LINKED_ORIGINS = ['debt_initial', 'debt_payment', 'goal_transfer', 'fee'] as const;
type LinkedOrigin = (typeof LINKED_ORIGINS)[number];

const isLinkedOrigin = (origin: string): origin is LinkedOrigin =>
  (LINKED_ORIGINS as readonly string[]).includes(origin);

/** Where "Ir a…" goes; a debt payment opens the debts, since it points to the payment. */
function originPath(origin: LinkedOrigin, originId: string | null | undefined): string | null {
  if (origin === 'fee' || originId === null || originId === undefined) return null;
  if (origin === 'goal_transfer') return `/metas/${originId}`;
  return origin === 'debt_initial' ? `/deudas/${originId}` : '/deudas';
}

/** The amount without its sign. */
const unsigned = (amount: string): string => (amount.startsWith('-') ? amount.slice(1) : amount);

interface TransactionDetailProps {
  transaction: TransactionDetailData;
  /** The user's base currency. */
  base: string;
  accountNames: ReadonlyMap<string, string>;
  onEdit: () => void;
}

/** `<TransactionDetail>`: the movement with its fee, its marks and "Ir a…" (plan §4.6.4). */
export function TransactionDetail({ transaction, base, accountNames, onEdit }: TransactionDetailProps) {
  const { t } = useTranslation('transactions');
  const formatters = useFormatters();
  const symbolOf = useCurrencySymbol();
  const signed = useSignedMoney();
  const nameOf = (accountId: string) => accountNames.get(accountId) ?? '';

  const transfer = transaction.kind === 'transfer';
  const out = transfer
    ? transaction.entries.find((entry) => entry.amount.startsWith('-'))
    : undefined;
  const arrival = transfer ? transaction.entries.find((entry) => entry !== out) : undefined;
  const main = out ?? transaction.entries[0];
  const title =
    transaction.category?.name ?? (transfer ? t('row.transfer') : t('row.adjustment'));
  const amount =
    main === undefined
      ? ''
      : transfer
        ? formatters.money(unsigned(main.amount), symbolOf(main.currencyCode))
        : signed(main.amount, symbolOf(main.currencyCode));
  const inBase =
    main === undefined || main.currencyCode === base
      ? null
      : transaction.amountInBase === null
        ? t('row.noRate')
        : t('row.inBase', {
            amount: transfer
              ? formatters.money(unsigned(transaction.amountInBase), symbolOf(base))
              : signed(transaction.amountInBase, symbolOf(base)),
          });
  const crossCurrency =
    out !== undefined && arrival !== undefined && out.currencyCode !== arrival.currencyCode;
  const rate = crossCurrency
    ? transaction.declaredRate
    : main?.currencyCode === 'BOB'
      ? transaction.rateUsdBob
      : transaction.rateCurBob;
  // Bs per unit, except between two currencies that are not BOB: units of the arrival (plan §4.6.1).
  const rateSymbol =
    crossCurrency && out.currencyCode !== 'BOB' && arrival.currencyCode !== 'BOB'
      ? symbolOf(arrival.currencyCode)
      : symbolOf('BOB');
  const linked = isLinkedOrigin(transaction.origin) ? transaction.origin : null;
  const goTo = linked === null ? null : originPath(linked, transaction.originId);
  const feeEntry = transaction.fee?.entries[0];

  const rows: { label: string; value: string }[] = [
    { label: t('detail.date'), value: formatters.date(transaction.date) },
    ...(out !== undefined && arrival !== undefined
      ? [
          { label: t('detail.from'), value: nameOf(out.accountId) },
          { label: t('detail.to'), value: nameOf(arrival.accountId) },
        ]
      : main === undefined
        ? []
        : [{ label: t('detail.account'), value: nameOf(main.accountId) }]),
    ...(transaction.category === null || transaction.category === undefined
      ? []
      : [{ label: t('detail.category'), value: transaction.category.name }]),
    ...(transaction.note === null ? [] : [{ label: t('detail.note'), value: transaction.note }]),
    ...(rate === null || rate === undefined
      ? []
      : [{ label: t('detail.rate'), value: formatters.money(rate, rateSymbol) }]),
    ...(feeEntry === undefined
      ? []
      : [
          {
            label: t('detail.fee'),
            value: formatters.money(unsigned(feeEntry.amount), symbolOf(feeEntry.currencyCode)),
          },
        ]),
  ];

  return (
    <article className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <p className="text-base font-medium">{title}</p>
        <p className="text-[2rem] font-semibold leading-tight tabular-nums">{amount}</p>
        {inBase !== null && (
          <p className="text-sm tabular-nums text-muted-foreground">{inBase}</p>
        )}
        {(transaction.beforeInitialBalance ||
          (transaction.recurringLabel !== undefined && transaction.recurringLabel !== null)) && (
          <p className="flex flex-wrap gap-1 pt-1">
            {transaction.beforeInitialBalance && (
              <Badge variant="outline" className="font-normal">
                {t('row.beforeInitialBalance')}
              </Badge>
            )}
            {transaction.recurringLabel !== undefined && transaction.recurringLabel !== null && (
              <Badge variant="outline" className="font-normal">
                {t('row.recurring', { name: transaction.recurringLabel })}
              </Badge>
            )}
          </p>
        )}
      </header>

      <dl className="flex flex-col divide-y divide-border border-y border-border">
        {rows.map((row) => (
          <div key={row.label} className="flex justify-between gap-4 py-3">
            <dt className="text-sm text-muted-foreground">{row.label}</dt>
            <dd className="text-right text-base">{row.value}</dd>
          </div>
        ))}
      </dl>

      {linked !== null && (
        <div className="flex flex-col items-start gap-2">
          <p className="text-sm text-muted-foreground">{t(`detail.linked.${linked}`)}</p>
          {goTo !== null && linked !== 'fee' && (
            <Link to={goTo} className="text-sm font-medium text-primary underline">
              {t(`detail.goTo.${linked}`)}
            </Link>
          )}
        </div>
      )}

      <Button type="button" className="h-11 self-start" onClick={onEdit}>
        {t('detail.edit')}
      </Button>
    </article>
  );
}
