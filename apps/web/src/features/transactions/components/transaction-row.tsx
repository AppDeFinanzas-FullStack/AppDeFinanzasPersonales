import { useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import { Badge } from '@/components/ui/badge';
import { useCurrencySymbol } from '@/features/accounts/hooks/use-accounts';
import { useFormatters } from '@/features/settings/hooks/use-settings';

import type { TransactionItem } from '../api';

const ZERO = /^-?0(\.0+)?$/;

/**
 * "Bs +100,00" or "Bs −35,00": the sign always shows, so the amount never relies on color alone
 * (design direction, RF-M9-02).
 */
export function useSignedMoney(): (amount: string, symbol: string) => string {
  const formatters = useFormatters();
  return useCallback(
    (amount, symbol) => {
      const text = formatters.money(amount, symbol);
      return amount.startsWith('-') || ZERO.test(amount)
        ? text
        : text.replace(`${symbol} `, `${symbol} +`);
    },
    [formatters],
  );
}

/** The amount without its sign. */
const unsigned = (amount: string): string => (amount.startsWith('-') ? amount.slice(1) : amount);

/** How long a press must last on a phone to select a movement (plan §4.6.4). */
const LONG_PRESS_MS = 500;

interface RowSelection {
  selected: boolean;
  /** `true` once anything is selected: a tap then toggles instead of opening the detail. */
  active: boolean;
  onToggle: () => void;
}

interface TransactionRowProps {
  item: TransactionItem;
  /** The user's base currency. */
  base: string;
  accountNames: ReadonlyMap<string, string>;
  selection?: RowSelection;
}

/**
 * A movement of the list, with the "anterior al saldo inicial" and "De recurrente: X" marks
 * (RF-M4-03, RF-M6-10); it opens its detail. With `selection`, it is selected with its checkbox
 * on a desktop, a long press on a phone or the space key (RF-M6-13, RNF-06).
 */
export function TransactionRow({ item, base, accountNames, selection }: TransactionRowProps) {
  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressed = useRef(false);
  const cancelPress = () => {
    if (pressTimer.current !== null) clearTimeout(pressTimer.current);
    pressTimer.current = null;
  };
  const { t } = useTranslation('transactions');
  const formatters = useFormatters();
  const symbolOf = useCurrencySymbol();
  const signed = useSignedMoney();
  const nameOf = (accountId: string) => accountNames.get(accountId) ?? '';

  const transfer = item.kind === 'transfer';
  const out = transfer ? item.entries.find((entry) => entry.amount.startsWith('-')) : undefined;
  const arrival = transfer ? item.entries.find((entry) => entry !== out) : undefined;
  const main = out ?? item.entries[0];

  const title =
    item.category?.name ?? (transfer ? t('row.transfer') : t('row.adjustment'));
  const where =
    out !== undefined && arrival !== undefined
      ? t('row.transferAccounts', { from: nameOf(out.accountId), to: nameOf(arrival.accountId) })
      : main === undefined
        ? ''
        : nameOf(main.accountId);
  const detail = [item.note, where].filter((part) => part !== null && part !== '').join(' · ');

  // A transfer moves money between the user's accounts: it shows no sign.
  const amount =
    main === undefined
      ? ''
      : transfer
        ? formatters.money(unsigned(main.amount), symbolOf(main.currencyCode))
        : signed(main.amount, symbolOf(main.currencyCode));
  const inBase =
    main === undefined || main.currencyCode === base
      ? null
      : item.amountInBase === null
        ? t('row.noRate')
        : t('row.inBase', {
            amount: transfer
              ? formatters.money(unsigned(item.amountInBase), symbolOf(base))
              : signed(item.amountInBase, symbolOf(base)),
          });

  const link = (
    <Link
      to={`/movimientos/${item.id}`}
      aria-describedby={selection?.selected === true ? `selected-${item.id}` : undefined}
      onKeyDown={(event) => {
        if (selection !== undefined && event.key === ' ') {
          event.preventDefault();
          selection.onToggle();
        }
      }}
      onPointerDown={() => {
        if (selection === undefined) return;
        longPressed.current = false;
        pressTimer.current = setTimeout(() => {
          longPressed.current = true;
          selection.onToggle();
        }, LONG_PRESS_MS);
      }}
      onPointerUp={cancelPress}
      onPointerLeave={cancelPress}
      onContextMenu={(event) => {
        if (selection !== undefined) event.preventDefault();
      }}
      onClick={(event) => {
        if (selection === undefined) return;
        if (longPressed.current) {
          event.preventDefault();
          longPressed.current = false;
        } else if (selection.active) {
          event.preventDefault();
          selection.onToggle();
        }
      }}
      className="flex min-h-14 min-w-0 flex-1 items-start justify-between gap-4 py-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
    >
      <div className="flex min-w-0 flex-col gap-1">
        <span className="truncate text-base font-medium">{title}</span>
        {detail !== '' && <span className="truncate text-sm text-muted-foreground">{detail}</span>}
        {(item.beforeInitialBalance || (item.recurringLabel ?? null) !== null) && (
          <span className="flex flex-wrap gap-1">
            {item.beforeInitialBalance && (
              <Badge variant="outline" className="font-normal">
                {t('row.beforeInitialBalance')}
              </Badge>
            )}
            {item.recurringLabel !== undefined && item.recurringLabel !== null && (
              <Badge variant="outline" className="font-normal">
                {t('row.recurring', { name: item.recurringLabel })}
              </Badge>
            )}
          </span>
        )}
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1 text-right tabular-nums">
        <span className="text-base font-medium">{amount}</span>
        {inBase !== null && <span className="text-sm text-muted-foreground">{inBase}</span>}
      </div>
    </Link>
  );

  if (selection === undefined) return link;
  return (
    <div className={`flex items-center gap-3 ${selection.selected ? 'bg-muted' : ''}`}>
      <input
        type="checkbox"
        className="hidden h-4 w-4 shrink-0 lg:block"
        checked={selection.selected}
        aria-label={t('batch.select', { name: title })}
        onChange={selection.onToggle}
      />
      {link}
      {selection.selected && (
        <span id={`selected-${item.id}`} className="sr-only">
          {t('batch.selected')}
        </span>
      )}
    </div>
  );
}
