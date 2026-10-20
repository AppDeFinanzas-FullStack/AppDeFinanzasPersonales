import type { AccountDto } from '@finanzas/contracts';
import { useTranslation } from 'react-i18next';
import { Link, useSearchParams, type RouteObject } from 'react-router';

import { i18n, LANGUAGE } from '@/app/providers/i18n';
import { Separator } from '@/components/ui/separator';
import { useCurrentRate } from '@/features/fx/hooks/use-current-rate';
import { ApiError } from '@/lib/api-client';
import { messageForError } from '@/lib/i18n-errors';
import accounts from '@/locales/es-BO/accounts.json';

import { AccountGroups } from './components/account-groups';
import { NetWorthSummary } from './components/net-worth-summary';
import { useAccounts, useReorderAccounts } from './hooks/use-accounts';

// The feature registers its own namespace (RNF-07).
i18n.addResourceBundle(LANGUAGE, 'accounts', accounts, true, true);

/** While a new order is being saved, the list already shows it. */
function inOrder(items: readonly AccountDto[], ids: readonly string[] | undefined): AccountDto[] {
  if (ids === undefined) return [...items];
  const position = new Map(ids.map((id, index) => [id, index]));
  return items.map((account) => ({
    ...account,
    sortOrder: position.get(account.id) ?? account.sortOrder,
  }));
}

function ActiveAccounts() {
  const { t } = useTranslation('accounts');
  const active = useAccounts('active');
  const archived = useAccounts('archived');
  const rates = useCurrentRate();
  const reorder = useReorderAccounts();

  if (active.isError && active.data === undefined) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {t('loadError')}
      </p>
    );
  }
  if (active.data === undefined) return null;

  const base = rates.data?.base ?? 'BOB';
  const other = rates.data?.other ?? 'USD';
  const archivedIds = archived.data?.items.map((account) => account.id);
  const items = inOrder(active.data.items, reorder.isPending ? reorder.variables : undefined);

  return (
    <div className="flex flex-col gap-8">
      <NetWorthSummary summary={active.data.summary} base={base} other={other} />
      <Separator />
      {items.length === 0 ? (
        <p className="text-muted-foreground">{t('empty')}</p>
      ) : (
        <AccountGroups
          accounts={items}
          base={base}
          // The order covers every account of the user, archived ones at the end (RF-M4-11).
          {...(archivedIds === undefined
            ? {}
            : {
                onReorder: (ids: string[]) => {
                  reorder.mutate([...ids, ...archivedIds]);
                },
              })}
        />
      )}
      {reorder.isError && (
        <p role="alert" className="text-sm text-destructive">
          {messageForError(reorder.error instanceof ApiError ? reorder.error : { code: '' })}
        </p>
      )}
      <Link to="/cuentas?archivadas=1" className="text-sm text-primary underline">
        {t('archived.link')}
      </Link>
    </div>
  );
}

function ArchivedAccounts() {
  const { t } = useTranslation('accounts');
  const archived = useAccounts('archived');
  const rates = useCurrentRate();

  return (
    <div className="flex flex-col gap-6">
      <h2 className="text-lg font-semibold">{t('archived.title')}</h2>
      {archived.isError && archived.data === undefined ? (
        <p role="alert" className="text-sm text-destructive">
          {t('loadError')}
        </p>
      ) : archived.data === undefined ? null : archived.data.items.length === 0 ? (
        <p className="text-muted-foreground">{t('archived.empty')}</p>
      ) : (
        <AccountGroups accounts={archived.data.items} base={rates.data?.base ?? 'BOB'} />
      )}
      <Link to="/cuentas" className="text-sm text-primary underline">
        {t('archived.back')}
      </Link>
    </div>
  );
}

/** `/cuentas` and `/cuentas?archivadas=1` (plan §4.4.4). */
export function AccountsPage() {
  const [params] = useSearchParams();
  return params.get('archivadas') === '1' ? <ArchivedAccounts /> : <ActiveAccounts />;
}

/** Private routes of the accounts (plan §4.4.4). */
export const accountsRoutes: RouteObject[] = [{ path: 'cuentas', element: <AccountsPage /> }];
