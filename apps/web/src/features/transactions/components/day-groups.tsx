import { useTranslation } from 'react-i18next';

import { useCurrencySymbol } from '@/features/accounts/hooks/use-accounts';
import { useFormatters } from '@/features/settings/hooks/use-settings';

import type { DayNet, TransactionItem } from '../api';

import { TransactionRow, useSignedMoney } from './transaction-row';

interface DayGroup {
  date: string;
  items: TransactionItem[];
}

/** The movements by day, in the order the list gives them (RF-M6-02). */
function groupByDay(items: readonly TransactionItem[]): DayGroup[] {
  const groups: DayGroup[] = [];
  for (const item of items) {
    const last = groups.at(-1);
    if (last?.date === item.date) {
      last.items.push(item);
    } else {
      groups.push({ date: item.date, items: [item] });
    }
  }
  return groups;
}

interface DayGroupsProps {
  items: readonly TransactionItem[];
  dayNets: readonly DayNet[];
  /** The user's base currency. */
  base: string;
  /** The user's today, for "Hoy", "Ayer" and "Lun 13" (RF-M9-03). */
  today: string;
  accountNames: ReadonlyMap<string, string>;
}

/** The days of the list, each with its net without what RN-02 leaves out (RF-M6-12). */
export function DayGroups({ items, dayNets, base, today, accountNames }: DayGroupsProps) {
  const { t } = useTranslation('transactions');
  const formatters = useFormatters();
  const symbolOf = useCurrencySymbol();
  const signed = useSignedMoney();
  const nets = new Map(dayNets.map((day) => [day.date, day.net]));

  return (
    <div className="flex flex-col gap-6">
      {groupByDay(items).map((group) => {
        const net = nets.get(group.date);
        const headingId = `day-${group.date}`;
        return (
          <section key={group.date} aria-labelledby={headingId}>
            <div className="flex items-baseline justify-between gap-4 border-b border-border pb-2">
              <h3 id={headingId} className="text-sm font-medium">
                {formatters.relativeDay(group.date, today)}
              </h3>
              {net !== undefined && (
                <p className="text-sm tabular-nums text-muted-foreground">
                  <span className="sr-only">{t('day.net')} </span>
                  {signed(net, symbolOf(base))}
                </p>
              )}
            </div>
            <ul className="divide-y divide-border">
              {group.items.map((item) => (
                <li key={item.id}>
                  <TransactionRow item={item} base={base} accountNames={accountNames} />
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
