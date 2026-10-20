import type { AccountDto } from '@finanzas/contracts';
import { BOLIVIA_TIME_ZONE, monthRange, todayFor } from '@finanzas/domain';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams, useSearchParams, type RouteObject } from 'react-router';

import { i18n, LANGUAGE } from '@/app/providers/i18n';
import { Separator } from '@/components/ui/separator';
import { useMe } from '@/features/auth/hooks/use-me';
import { useCurrentRate } from '@/features/fx/hooks/use-current-rate';
import { ApiError } from '@/lib/api-client';
import { messageForError } from '@/lib/i18n-errors';
import accounts from '@/locales/es-BO/accounts.json';

import { AccountActions } from './components/account-actions';
import { AccountForm } from './components/account-form';
import { AccountGroups } from './components/account-groups';
import { AccountHeader } from './components/account-header';
import { BalanceChart } from './components/balance-chart';
import { NetWorthSummary } from './components/net-worth-summary';
import { useAccounts, useCurrencySymbol, useReorderAccounts } from './hooks/use-accounts';

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
      <Link
        to="/cuentas/nueva"
        className="inline-flex h-11 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      >
        {t('form.newAccount')}
      </Link>
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

/** The account of any status, found among both lists; `undefined` while loading. */
function useAccount(id: string | undefined) {
  const active = useAccounts('active');
  const archived = useAccounts('archived');
  const loaded = active.data !== undefined && archived.data !== undefined;
  const account = loaded
    ? [...active.data.items, ...archived.data.items].find((item) => item.id === id)
    : undefined;
  return { loaded, failed: active.isError || archived.isError, account };
}

/**
 * `/cuentas/:id` (plan §4.4.4): header, balance chart over `?from&to` (the current month by
 * default) and actions; `?ajustar=1` opens "Ajustar saldo". The movements arrive in TASK-133.
 */
export function AccountDetailPage() {
  const { t } = useTranslation('accounts');
  const { id } = useParams();
  const me = useMe();
  const rates = useCurrentRate();
  const symbolOf = useCurrencySymbol();
  const [params, setParams] = useSearchParams();
  const [today] = useState(() => todayFor(me.data?.timezone ?? BOLIVIA_TIME_ZONE, new Date()));
  const { loaded, failed, account } = useAccount(id);

  if (!loaded) {
    return failed ? (
      <p role="alert" className="text-sm text-destructive">
        {t('loadError')}
      </p>
    ) : null;
  }
  if (account === undefined) {
    return <p className="text-muted-foreground">{t('form.notFound')}</p>;
  }

  const month = monthRange(today.slice(0, 7));
  const range = { from: params.get('from') ?? month.from, to: params.get('to') ?? month.to };
  const update = (changes: Record<string, string | null>) => {
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        for (const [key, value] of Object.entries(changes)) {
          if (value === null) next.delete(key);
          else next.set(key, value);
        }
        return next;
      },
      { replace: true },
    );
  };

  return (
    <div className="flex flex-col gap-8">
      <AccountHeader account={account} base={rates.data?.base ?? 'BOB'} />
      <AccountActions
        account={account}
        adjustOpen={params.get('ajustar') === '1' && account.status === 'active'}
        onAdjustOpenChange={(open) => {
          update({ ajustar: open ? '1' : null });
        }}
      />
      <Separator />
      <BalanceChart
        accountId={account.id}
        symbol={symbolOf(account.currencyCode)}
        range={range}
        onRangeChange={(next) => {
          update({ from: next.from, to: next.to });
        }}
      />
      <Link to="/cuentas" className="text-sm text-primary underline">
        {t('archived.back')}
      </Link>
    </div>
  );
}

/** `/cuentas/nueva` (plan §4.4.4). */
export function NewAccountPage() {
  const { t } = useTranslation('accounts');
  const navigate = useNavigate();
  return (
    <div className="flex flex-col gap-6">
      <h2 className="text-lg font-semibold">{t('form.newTitle')}</h2>
      <AccountForm
        onDone={() => {
          void navigate('/cuentas');
        }}
      />
    </div>
  );
}

/** `/cuentas/:id/editar`; an account of any status is found among both lists (plan §4.4.4). */
export function EditAccountPage() {
  const { t } = useTranslation('accounts');
  const navigate = useNavigate();
  const { id } = useParams();
  const active = useAccounts('active');
  const archived = useAccounts('archived');
  if (active.data === undefined || archived.data === undefined) {
    return active.isError || archived.isError ? (
      <p role="alert" className="text-sm text-destructive">
        {t('loadError')}
      </p>
    ) : null;
  }
  const account = [...active.data.items, ...archived.data.items].find((item) => item.id === id);
  if (account === undefined) {
    return <p className="text-muted-foreground">{t('form.notFound')}</p>;
  }
  return (
    <div className="flex flex-col gap-6">
      <h2 className="text-lg font-semibold">{t('form.editTitle', { name: account.name })}</h2>
      <AccountForm
        account={account}
        onDone={() => {
          void navigate('/cuentas');
        }}
      />
    </div>
  );
}

/** `/cuentas` and `/cuentas?archivadas=1` (plan §4.4.4). */
export function AccountsPage() {
  const [params] = useSearchParams();
  return params.get('archivadas') === '1' ? <ArchivedAccounts /> : <ActiveAccounts />;
}

/** Private routes of the accounts (plan §4.4.4). */
export const accountsRoutes: RouteObject[] = [
  { path: 'cuentas', element: <AccountsPage /> },
  { path: 'cuentas/nueva', element: <NewAccountPage /> },
  { path: 'cuentas/:id', element: <AccountDetailPage /> },
  { path: 'cuentas/:id/editar', element: <EditAccountPage /> },
];
