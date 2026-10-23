import type { BudgetDto } from '@finanzas/contracts';
import { MoreHorizontal } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useCurrencySymbol } from '@/features/accounts/hooks/use-accounts';
import { useFormatters } from '@/features/settings/hooks/use-settings';
import { ApiError } from '@/lib/api-client';
import { messageForError } from '@/lib/i18n-errors';

import { useBudgetAction, useDeleteBudget, useResetCarryover } from '../hooks/use-budgets';

import { signedMoney } from './carryover-breakdown';
import { useBudgetName } from './budget-progress';

type Confirm = 'reset' | 'delete' | null;

const errorText = (error: unknown) =>
  messageForError(error instanceof ApiError ? error : { code: '' });

/**
 * Pausar, Reanudar, Reiniciar arrastre (confirming the amount, RF-M11-12) and Eliminar, in a
 * secondary menu; only Eliminar uses the destructive button (design, M11).
 */
export function BudgetActions({ budget }: { budget: BudgetDto }) {
  const { t } = useTranslation('budgets');
  const navigate = useNavigate();
  const formatters = useFormatters();
  const symbol = useCurrencySymbol()(budget.currencyCode);
  const name = useBudgetName()(budget);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const action = useBudgetAction(budget.id);
  const reset = useResetCarryover(budget.id);
  const remove = useDeleteBudget(budget.id, async () => {
    setConfirm(null);
    await navigate('/presupuestos', { replace: true });
  });
  const pending = action.isPending || reset.isPending || remove.isPending;
  const carryover = budget.current?.carryover;
  const onOpenChange = (open: boolean) => {
    if (!open) setConfirm(null);
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-11 shrink-0"
            aria-label={t('actions.menu')}
            disabled={pending}
          >
            <MoreHorizontal aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {budget.status === 'active' && (
            <DropdownMenuItem
              className="min-h-11 text-base"
              onSelect={() => {
                action.mutate('pause');
              }}
            >
              {t('actions.pause')}
            </DropdownMenuItem>
          )}
          {budget.status === 'paused' && (
            <DropdownMenuItem
              className="min-h-11 text-base"
              onSelect={() => {
                action.mutate('resume');
              }}
            >
              {t('actions.resume')}
            </DropdownMenuItem>
          )}
          {carryover !== undefined && (
            <DropdownMenuItem
              className="min-h-11 text-base"
              onSelect={() => {
                setConfirm('reset');
              }}
            >
              {t('actions.resetCarryover')}
            </DropdownMenuItem>
          )}
          <DropdownMenuItem
            className="min-h-11 text-base"
            onSelect={() => {
              setConfirm('delete');
            }}
          >
            {t('actions.delete')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {action.isError && (
        <p role="alert" className="text-sm text-destructive">
          {errorText(action.error)}
        </p>
      )}

      <Dialog open={confirm === 'reset'} onOpenChange={onOpenChange}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('actions.resetTitle')}</DialogTitle>
            <DialogDescription className="tabular-nums">
              {t('actions.resetDescription', {
                amount: signedMoney(carryover ?? '0.00', symbol, formatters.money),
              })}
            </DialogDescription>
          </DialogHeader>
          {reset.isError && (
            <p role="alert" className="text-sm text-destructive">
              {errorText(reset.error)}
            </p>
          )}
          <DialogFooter className="gap-2">
            <Button
              type="button"
              variant="outline"
              className="h-11"
              onClick={() => onOpenChange(false)}
            >
              {t('actions.cancel')}
            </Button>
            <Button
              type="button"
              className="h-11"
              disabled={reset.isPending}
              onClick={() => {
                reset.mutate(undefined, {
                  onSuccess: () => {
                    setConfirm(null);
                  },
                });
              }}
            >
              {t('actions.resetCarryover')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={confirm === 'delete'} onOpenChange={onOpenChange}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('actions.deleteTitle', { name })}</DialogTitle>
            <DialogDescription>{t('actions.deleteDescription')}</DialogDescription>
          </DialogHeader>
          {remove.isError && (
            <p role="alert" className="text-sm text-destructive">
              {errorText(remove.error)}
            </p>
          )}
          <DialogFooter className="gap-2">
            <Button
              type="button"
              variant="outline"
              className="h-11"
              onClick={() => onOpenChange(false)}
            >
              {t('actions.cancel')}
            </Button>
            <Button
              type="button"
              variant="destructive"
              className="h-11"
              disabled={remove.isPending}
              onClick={() => {
                remove.mutate();
              }}
            >
              {t('actions.delete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
