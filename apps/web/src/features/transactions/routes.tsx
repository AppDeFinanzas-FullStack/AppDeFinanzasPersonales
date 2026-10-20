import { LocalDate, TransactionKind, Uuid } from '@finanzas/contracts';
import { BOLIVIA_TIME_ZONE, todayFor } from '@finanzas/domain';
import { useCallback, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { RouteObject } from 'react-router';
import { z } from 'zod';

import { i18n, LANGUAGE } from '@/app/providers/i18n';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { useAccounts } from '@/features/accounts/hooks/use-accounts';
import { useMe } from '@/features/auth/hooks/use-me';
import { useCurrentRate } from '@/features/fx/hooks/use-current-rate';
import { useValidatedSearch } from '@/lib/search-params';
import transactions from '@/locales/es-BO/transactions.json';

import type { TransactionFilters } from './api';
import { DayGroups } from './components/day-groups';
import { FiltersBar, type ListFiltersValue } from './components/filters-bar';
import { MonthSelector } from './components/month-selector';
import { TotalsBar } from './components/totals-bar';
import { useTransactions } from './hooks/use-transactions';

// The feature registers its own namespace (RNF-07).
i18n.addResourceBundle(LANGUAGE, 'transactions', transactions, true, true);

/**
 * The month and the filters of `/movimientos` live in the URL, so going back to the tab keeps
 * them (ADR-16, RF-M2-04). A date or range replaces the month.
 */
const ListSearch = z.object({
  mes: z
    .string()
    .regex(/^\d{4}-\d{2}$/)
    .optional(),
  desde: LocalDate.optional(),
  hasta: LocalDate.optional(),
  cuenta: Uuid.optional(),
  categoria: Uuid.optional(),
  tipo: TransactionKind.optional(),
  q: z.string().max(60).optional(),
});
type ListSearch = z.output<typeof ListSearch>;

/** The URL keys of the filters that changed. */
function searchOf(next: ListFiltersValue): Partial<ListSearch> {
  const search: Partial<ListSearch> = {};
  if ('from' in next) search.desde = next.from;
  if ('to' in next) search.hasta = next.to;
  if ('accountId' in next) search.cuenta = next.accountId;
  if ('categoryId' in next) search.categoria = next.categoryId;
  if ('kind' in next) search.tipo = next.kind;
  if ('q' in next) search.q = next.q;
  return search;
}

/** Loads the next page when the end of the list comes into view (plan §4.6.4). */
function useLoadMoreOnView(enabled: boolean, loadMore: () => void) {
  const sentinel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = sentinel.current;
    if (!enabled || node === null || typeof IntersectionObserver === 'undefined') return undefined;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) loadMore();
    });
    observer.observe(node);
    return () => {
      observer.disconnect();
    };
  }, [enabled, loadMore]);
  return sentinel;
}

/** `/movimientos`: the list of the month with its filters, totals and days (plan §4.6.4). */
export function TransactionsPage() {
  const { t } = useTranslation('transactions');
  const me = useMe();
  const today = todayFor(me.data?.timezone ?? BOLIVIA_TIME_ZONE, new Date());
  const currentMonth = today.slice(0, 7);
  const [search, setSearch] = useValidatedSearch(ListSearch);
  const base = useCurrentRate().data?.base ?? 'BOB';
  const active = useAccounts('active');
  const archived = useAccounts('archived');

  const ranged = search.desde !== undefined || search.hasta !== undefined;
  const month = search.mes ?? currentMonth;
  const q = search.q?.trim() ?? '';
  const filters: TransactionFilters = {
    ...(ranged ? { from: search.desde, to: search.hasta } : { month }),
    accountId: search.cuenta,
    categoryId: search.categoria,
    kind: search.tipo,
    q: q === '' ? undefined : q,
  };

  const list = useTransactions(filters);
  const { fetchNextPage, hasNextPage, isFetchingNextPage } = list;
  const loadMore = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [fetchNextPage, hasNextPage, isFetchingNextPage]);
  const sentinel = useLoadMoreOnView(hasNextPage, loadMore);

  const accounts = [...(active.data?.items ?? []), ...(archived.data?.items ?? [])];
  const accountNames = new Map(accounts.map((account) => [account.id, account.name]));
  const pages = list.data?.pages ?? [];
  const items = pages.flatMap((page) => page.items);
  const dayNets = pages.flatMap((page) => page.dayNets);
  const categoryName =
    search.categoria === undefined
      ? undefined
      : items.find((item) => item.category?.id === search.categoria)?.category?.name;

  return (
    <div className="flex flex-col gap-6">
      {!ranged && (
        <MonthSelector
          month={month}
          currentMonth={currentMonth}
          onChange={(next) => {
            setSearch({ mes: next });
          }}
        />
      )}
      <FiltersBar
        value={{
          from: search.desde,
          to: search.hasta,
          accountId: search.cuenta,
          categoryId: search.categoria,
          kind: search.tipo,
          q: search.q,
        }}
        accounts={accounts}
        categoryName={categoryName}
        today={today}
        onChange={(next) => {
          // Typing a search replaces the entry, so Back does not walk through each letter.
          setSearch(searchOf(next), { replace: 'q' in next });
        }}
      />
      <TotalsBar filters={filters} base={base} />
      <Separator />
      {list.isError && list.data === undefined ? (
        <div className="flex flex-col items-start gap-3">
          <p role="alert" className="text-sm text-destructive">
            {t('loadError')}
          </p>
          <Button
            type="button"
            variant="outline"
            className="h-11"
            onClick={() => {
              void list.refetch();
            }}
          >
            {t('retry')}
          </Button>
        </div>
      ) : list.data === undefined ? (
        <p className="text-sm text-muted-foreground" aria-busy="true">
          {t('loading')}
        </p>
      ) : items.length === 0 ? (
        <p className="text-muted-foreground">{t('empty')}</p>
      ) : (
        <>
          <DayGroups
            items={items}
            dayNets={dayNets}
            base={base}
            today={today}
            accountNames={accountNames}
          />
          {hasNextPage && (
            <div ref={sentinel} className="flex justify-center">
              <Button
                type="button"
                variant="outline"
                className="h-11"
                disabled={isFetchingNextPage}
                onClick={loadMore}
              >
                {isFetchingNextPage ? t('loading') : t('loadMore')}
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** Private routes of the movements (plan §4.6.4). */
export const transactionsRoutes: RouteObject[] = [
  { path: 'movimientos', element: <TransactionsPage /> },
];
