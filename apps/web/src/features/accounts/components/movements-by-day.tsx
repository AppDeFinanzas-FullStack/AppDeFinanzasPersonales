import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { DayGroups } from '@/features/transactions/components/day-groups';
import { useTransactions } from '@/features/transactions/hooks/use-transactions';

import { useAccounts } from '../hooks/use-accounts';

/**
 * The movements of the account by day, with the M6 list and the same `from`–`to` as the balance
 * chart (plan §4.4.4); transfers of the account are included.
 */
export function MovementsByDay({
  accountId,
  range,
  base,
  today,
}: {
  accountId: string;
  range: { from: string; to: string };
  base: string;
  today: string;
}) {
  const { t } = useTranslation('transactions');
  const active = useAccounts('active');
  const archived = useAccounts('archived');
  const list = useTransactions({ accountId, from: range.from, to: range.to });
  const { fetchNextPage, hasNextPage, isFetchingNextPage } = list;

  const accountNames = new Map(
    [...(active.data?.items ?? []), ...(archived.data?.items ?? [])].map((account) => [
      account.id,
      account.name,
    ]),
  );
  const pages = list.data?.pages ?? [];
  const items = pages.flatMap((page) => page.items);
  const dayNets = pages.flatMap((page) => page.dayNets);

  return (
    <section aria-labelledby="account-movements" className="flex flex-col gap-4">
      <h2 id="account-movements" className="text-lg font-semibold">
        {t('title')}
      </h2>
      {list.isError && list.data === undefined ? (
        <p role="alert" className="text-sm text-destructive">
          {t('loadError')}
        </p>
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
            <div className="flex justify-center">
              <Button
                type="button"
                variant="outline"
                className="h-11"
                disabled={isFetchingNextPage}
                onClick={() => {
                  void fetchNextPage();
                }}
              >
                {isFetchingNextPage ? t('loading') : t('loadMore')}
              </Button>
            </div>
          )}
        </>
      )}
    </section>
  );
}
