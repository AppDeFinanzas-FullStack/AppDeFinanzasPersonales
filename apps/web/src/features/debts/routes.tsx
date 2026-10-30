import type { DebtDto } from '@finanzas/contracts';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams } from 'react-router';

import { i18n, LANGUAGE } from '@/app/providers/i18n';
import { ResourceNotFound } from '@/components/resource-not-found';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Separator } from '@/components/ui/separator';
import { useCurrentRate } from '@/features/fx/hooks/use-current-rate';
import { ApiError } from '@/lib/api-client';
import { messageForError } from '@/lib/i18n-errors';
import debts from '@/locales/es-BO/debts.json';
import goals from '@/locales/es-BO/goals.json';

import type { DebtsView } from './api';
import { DebtForm } from './components/debt-form';
import { DebtHeader } from './components/debt-header';
import { DebtList, PersonList } from './components/debt-list';
import { DebtsSummary } from './components/debts-summary';
import { DeleteDebtDialog } from './components/delete-debt-dialog';
import { PaymentForm } from './components/payment-form';
import { PaymentsList } from './components/payments-list';
import { ViewToggle } from './components/view-toggle';
import { useDebt, useDebts, useDeleteDebt, useForgiveDebt } from './hooks/use-debts';

// The feature registers its own namespace (RNF-07).
i18n.addResourceBundle(LANGUAGE, 'debts', debts, true, true);
// The confirmation of the earmarks of a payment (EC-M13-04) reads the texts of the goals.
i18n.addResourceBundle(LANGUAGE, 'goals', goals, true, true);

/** `/deudas` (plan §4.13.4). */
export function DebtsPage() {
  const { t } = useTranslation('debts');
  const [view, setView] = useState<DebtsView>('debt');
  const [formOpen, setFormOpen] = useState(false);
  const query = useDebts(view);
  const rates = useCurrentRate();
  const base = rates.data?.base ?? 'BOB';

  if (query.isError && query.data === undefined) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {t('loadError')}
      </p>
    );
  }
  if (query.data === undefined) return null;
  const { debts: items, summary } = query.data;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-2xl font-semibold">{t('title')}</h2>
        <Button
          className="h-11"
          onClick={() => {
            setFormOpen(true);
          }}
        >
          {t('actions.newDebt')}
        </Button>
      </div>
      <DebtForm open={formOpen} onOpenChange={setFormOpen} />
      <DebtsSummary summary={summary} base={base} />
      <ViewToggle value={view} onChange={setView} />
      {items.length === 0 ? (
        <p className="text-muted-foreground">{t('empty')}</p>
      ) : view === 'person' ? (
        <PersonList people={summary.byPerson ?? []} base={base} />
      ) : (
        <DebtList debts={items} />
      )}
    </div>
  );
}

/** "Condonar saldo": closes the debt as Condonada without movements (RF-M13-12). */
function ForgiveDialog({
  debt,
  open,
  onOpenChange,
}: {
  debt: DebtDto;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation('debts');
  const forgive = useForgiveDebt(debt.id);
  const close = () => {
    forgive.reset();
    onOpenChange(false);
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) onOpenChange(true);
        else close();
      }}
    >
      <DialogContent closeLabel={t('actions.close')}>
        <DialogHeader>
          <DialogTitle>{t('forgive.title')}</DialogTitle>
          <DialogDescription>{t('forgive.description', { person: debt.person })}</DialogDescription>
        </DialogHeader>
        {forgive.isError && (
          <p role="alert" className="text-sm text-destructive">
            {messageForError(forgive.error instanceof ApiError ? forgive.error : { code: '' })}
          </p>
        )}
        <DialogFooter className="gap-2">
          <Button type="button" variant="outline" className="h-11" onClick={close}>
            {t('actions.cancel')}
          </Button>
          <Button
            type="button"
            className="h-11"
            disabled={forgive.isPending}
            onClick={() => {
              forgive.mutate(undefined, { onSuccess: close });
            }}
          >
            {t('forgive.submit')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Movements linked to the debt, as the API reports them when it asks for the choice. */
function movementsCount(error: unknown): number | null {
  if (!(error instanceof ApiError) || error.code !== 'MOVEMENTS_CHOICE_REQUIRED') return null;
  const count = error.data?.['count'];
  return typeof count === 'number' ? count : null;
}

/** `/deudas/:id` (plan §4.13.4). */
export function DebtDetailPage() {
  const { t } = useTranslation('debts');
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const query = useDebt(id);
  const remove = useDeleteDebt(id);
  const [dialog, setDialog] = useState<'forgive' | 'delete' | 'payment' | null>(null);
  const [movements, setMovements] = useState(0);

  if (query.isError && query.data === undefined) {
    if (query.error instanceof ApiError && query.error.code === 'NOT_FOUND') {
      return <ResourceNotFound />;
    }
    return (
      <p role="alert" className="text-sm text-destructive">
        {t('loadError')}
      </p>
    );
  }
  if (query.data === undefined) return null;
  const debt = query.data;
  const open = debt.status === 'active' || debt.status === 'overdue';

  // A debt without movements is deleted at once; with them, the user chooses (RF-M13-11).
  const startDelete = () => {
    remove.mutate(undefined, {
      onSuccess: () => {
        void navigate('/deudas');
      },
      onError: (error) => {
        const count = movementsCount(error);
        if (count !== null) {
          setMovements(count);
          setDialog('delete');
        }
      },
    });
  };

  return (
    <div className="flex flex-col gap-8">
      <DebtHeader debt={debt} />
      <div className="flex flex-wrap gap-2">
        {open && (
          <Button
            className="h-11"
            onClick={() => {
              setDialog('payment');
            }}
          >
            {t('actions.registerPayment')}
          </Button>
        )}
        {open && (
          <Button
            variant="outline"
            className="h-11"
            onClick={() => {
              setDialog('forgive');
            }}
          >
            {t('actions.forgive')}
          </Button>
        )}
        <Button
          variant="outline"
          className="h-11"
          disabled={remove.isPending}
          onClick={startDelete}
        >
          {t('actions.delete')}
        </Button>
      </div>
      {remove.isError && movementsCount(remove.error) === null && dialog === null && (
        <p role="alert" className="text-sm text-destructive">
          {messageForError(remove.error instanceof ApiError ? remove.error : { code: '' })}
        </p>
      )}
      <Separator />
      <PaymentsList debt={debt} />
      <PaymentForm
        debt={debt}
        open={dialog === 'payment'}
        onOpenChange={(next) => {
          if (!next) setDialog(null);
        }}
      />
      <ForgiveDialog
        debt={debt}
        open={dialog === 'forgive'}
        onOpenChange={(next) => {
          if (!next) setDialog(null);
        }}
      />
      <DeleteDebtDialog
        count={movements}
        open={dialog === 'delete'}
        pending={remove.isPending}
        error={remove.error}
        onConfirm={(choice) => {
          remove.mutate(choice, {
            onSuccess: () => {
              setDialog(null);
              void navigate('/deudas');
            },
          });
        }}
        onOpenChange={(next) => {
          if (!next) setDialog(null);
        }}
      />
    </div>
  );
}
