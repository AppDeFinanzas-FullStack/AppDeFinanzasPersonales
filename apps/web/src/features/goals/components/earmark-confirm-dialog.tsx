import type { EarmarkWithdrawals } from '@finanzas/contracts';
import { parseAmountInput } from '@finanzas/domain';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { i18n, LANGUAGE } from '@/app/providers/i18n';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useFormatters } from '@/features/settings/hooks/use-settings';

import { useGoals } from '../hooks/use-goals';

// The dialog is shared with Registrar, Movimientos and Cuentas, so it registers the text of `goals`
// itself (RNF-07). The bundle loads on its own, so the entry package of /registrar keeps its
// weight (RNF-01); the dialog rerenders when it arrives.
void import('@/locales/es-BO/goals.json').then((module) => {
  i18n.addResourceBundle(LANGUAGE, 'goals', module.default, true, true);
});

/** Renders again when a bundle is added, so the text that arrives late replaces any key shown. */
function useRerenderOnBundleAdded(): void {
  const [, setCount] = useState(0);
  useEffect(() => {
    const bump = () => setCount((count) => count + 1);
    i18n.on('added', bump);
    return () => {
      i18n.off('added', bump);
    };
  }, []);
}

export interface EarmarkTakeInput {
  goalId: string;
  amount: string;
}

interface EarmarkConfirmDialogProps {
  open: boolean;
  /** What the operation takes from earmarked money, as decimal text. */
  shortfall: string;
  /** The account the operation leaves, which holds the earmarks. */
  accountId: string;
  /** The proposal of the API: the goal with the farthest date first (RF-M12-05). */
  proposal: EarmarkTakeInput[];
  /** The symbol of the currency of the account. */
  symbol: string;
  pending: boolean;
  onConfirm: (withdrawals: EarmarkWithdrawals) => void;
  onCancel: () => void;
}

/**
 * `<EarmarkConfirmDialog>` (plan §4.12.4): "Este gasto usa X apartados" with the goals affected
 * and an editable proposal. Confirming resends the same operation with `earmarkWithdrawals`;
 * cancelling changes nothing (RF-M12-05, EC-M7-03).
 */
export function EarmarkConfirmDialog(props: EarmarkConfirmDialogProps) {
  const { open, onCancel } = props;
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
    >
      {open && <EarmarkConfirmContent {...props} />}
    </Dialog>
  );
}

interface EarmarkRow {
  goalId: string;
  name: string;
  /** What the goal holds in the account; `null` while the goals are not loaded. */
  cap: string | null;
}

function EarmarkConfirmContent({
  shortfall,
  accountId,
  proposal,
  symbol,
  pending,
  onConfirm,
  onCancel,
}: EarmarkConfirmDialogProps) {
  const { t } = useTranslation('goals');
  useRerenderOnBundleAdded();
  const formatters = useFormatters();
  const goals = useGoals();
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(proposal.map((take) => [take.goalId, take.amount])),
  );

  // Every non-dedicated goal with money earmarked in the account, so the user can pick
  // a different goal than the proposal (RF-M12-05).
  const rows: EarmarkRow[] = [];
  for (const goal of goals.data?.items ?? []) {
    const entry = goal.byAccount.find((item) => item.accountId === accountId && !item.dedicated);
    const held = entry ? parseAmountInput(entry.amount) : null;
    if (entry && held !== null && held.greaterThan(0)) {
      rows.push({ goalId: goal.id, name: goal.name, cap: entry.amount });
    }
  }
  for (const take of proposal) {
    if (!rows.some((row) => row.goalId === take.goalId)) {
      rows.push({ goalId: take.goalId, name: t('confirm.goal'), cap: null });
    }
  }

  const valueOf = (goalId: string): string => values[goalId] ?? '0';
  const amounts = rows.map((row) => parseAmountInput(valueOf(row.goalId)));
  const overCap = rows.map((row, index) => {
    const value = amounts[index];
    const cap = row.cap === null ? null : parseAmountInput(row.cap);
    return value !== null && value !== undefined && cap !== null && value.greaterThan(cap);
  });
  const enough = (() => {
    if (amounts.some((value) => value === null)) return false;
    if (overCap.some(Boolean)) return false;
    const needed = parseAmountInput(shortfall);
    if (needed === null) return false;
    let sum = needed.minus(needed);
    for (const value of amounts) {
      if (value !== null) sum = sum.plus(value);
    }
    return sum.greaterThanOrEqualTo(needed);
  })();

  const confirm = () => {
    const withdrawals: EarmarkWithdrawals = [];
    rows.forEach((row, index) => {
      const value = amounts[index];
      if (value !== null && value !== undefined && value.greaterThan(0)) {
        withdrawals.push({ goalId: row.goalId, accountId, amount: value.toFixed(2) });
      }
    });
    onConfirm(withdrawals);
  };

  return (
    <DialogContent closeLabel={t('actions.close')}>
      <DialogHeader>
        <DialogTitle>
          {t('confirm.title', { amount: formatters.money(shortfall, symbol) })}
        </DialogTitle>
        <DialogDescription>{t('confirm.description')}</DialogDescription>
      </DialogHeader>
      <form
        noValidate
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (enough) confirm();
        }}
      >
        {rows.map((row, index) => (
          <div key={row.goalId} className="flex flex-col gap-2">
            <Label htmlFor={`earmark-take-${row.goalId}`}>{row.name}</Label>
            <Input
              id={`earmark-take-${row.goalId}`}
              inputMode="decimal"
              autoComplete="off"
              className="h-11 tabular-nums"
              aria-invalid={overCap[index] || undefined}
              value={valueOf(row.goalId)}
              onChange={(event) => {
                const next = event.target.value;
                setValues((old) => ({ ...old, [row.goalId]: next }));
              }}
            />
            {overCap[index] && row.cap !== null && (
              <p className="text-sm text-destructive">
                {t('confirm.over', { amount: formatters.money(row.cap, symbol) })}
              </p>
            )}
          </div>
        ))}
        {!enough && (
          <p className="text-sm text-destructive">
            {t('confirm.short', { amount: formatters.money(shortfall, symbol) })}
          </p>
        )}
        <DialogFooter className="gap-2">
          <Button type="button" variant="outline" className="h-11" onClick={onCancel}>
            {t('actions.cancel')}
          </Button>
          <Button type="submit" className="h-11" disabled={!enough || pending}>
            {t('confirm.submit')}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}
