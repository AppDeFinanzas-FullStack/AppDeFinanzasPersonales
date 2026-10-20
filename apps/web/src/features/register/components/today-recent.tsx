import { useTranslation } from 'react-i18next';

import { TransactionRow } from '@/features/transactions/components/transaction-row';

import type { RegisterAccount, RegisterContext } from '../api';

/** How many of today's movements Registrar shows (RF-M7-07). */
const SHOWN = 3;

interface TodayRecentProps {
  items: RegisterContext['todayRecent'];
  accounts: readonly RegisterAccount[];
  /** The user's base currency. */
  base: string;
}

/**
 * The last 3 movements created today, whatever their date, below the form (RF-M7-07). It comes
 * from the context, which saving updates with its answer, so it makes no request of its own.
 */
export function TodayRecent({ items, accounts, base }: TodayRecentProps) {
  const { t } = useTranslation('register');
  if (items.length === 0) return null;
  const names = new Map(accounts.map((account) => [account.id, account.name]));

  return (
    <section aria-labelledby="register-today-title" className="flex flex-col gap-2">
      <h2 id="register-today-title" className="text-base font-medium">
        {t('recent.title')}
      </h2>
      <ul className="flex flex-col divide-y divide-border">
        {items.slice(0, SHOWN).map((item) => (
          <li key={item.id}>
            <TransactionRow item={item} base={base} accountNames={names} />
          </li>
        ))}
      </ul>
    </section>
  );
}
