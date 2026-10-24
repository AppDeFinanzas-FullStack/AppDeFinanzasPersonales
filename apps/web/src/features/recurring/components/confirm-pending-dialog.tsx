import type {
  CategoryNode,
  ConfirmOccurrenceInput,
  OccurrenceDto,
  RuleDto,
} from '@finanzas/contracts';
import { BOLIVIA_TIME_ZONE, parseAmountInput, todayFor } from '@finanzas/domain';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { uuidv7 } from 'uuidv7';

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
import { useAccounts } from '@/features/accounts/hooks/use-accounts';
import { useMe } from '@/features/auth/hooks/use-me';
import { useCategories } from '@/features/categories/hooks/use-categories';
import { ApiError } from '@/lib/api-client';
import { messageForError } from '@/lib/i18n-errors';

import { useConfirmOccurrence } from '../hooks/use-recurring';

const LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/;
const SELECT_CLASS = 'flex h-11 w-full rounded-md border border-input bg-background px-3 text-base';

type Field = 'amount' | 'date' | 'rate' | 'account' | 'category';

function flatten(nodes: CategoryNode[]): CategoryNode[] {
  return nodes.flatMap((node) => [node, ...flatten(node.children)]);
}

/** A positive decimal typed by the user as text with 2 decimals, or `null` (ADR-03). */
function positiveDecimal(raw: string): string | null {
  const value = parseAmountInput(raw.trim());
  return value === null || value.lte(0) ? null : value.toFixed(2);
}

/**
 * Confirms a pending occurrence (RF-M14-08): the amount, the date and the rate can be adjusted, a
 * rule without amount asks for it, the date cannot be in the future in the user's time zone, and an
 * archived account or category must be replaced.
 */
export function ConfirmPendingDialog({
  occurrence,
  rule,
  onClose,
}: {
  occurrence: OccurrenceDto;
  rule: RuleDto | undefined;
  onClose: () => void;
}) {
  const { t } = useTranslation('recurring');
  const me = useMe();
  const timezone = me.data?.timezone ?? BOLIVIA_TIME_ZONE;
  const today = useMemo(() => todayFor(timezone, new Date()), [timezone]);
  const kind = rule?.kind ?? 'expense';
  const categoryKind = kind === 'income' ? 'income' : 'expense';
  const accounts = useAccounts('active');
  const categories = useCategories({ kind: categoryKind, status: 'active' });
  const confirm = useConfirmOccurrence(occurrence.transactionId);
  const [transactionId] = useState(() => uuidv7());
  const [amount, setAmount] = useState(occurrence.amount ?? '');
  const [date, setDate] = useState(occurrence.date);
  const [rate, setRate] = useState('');
  const [accountId, setAccountId] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [errors, setErrors] = useState<Partial<Record<Field, string>>>({});

  const activeAccounts = accounts.data?.items ?? [];
  const accountArchived =
    accounts.data !== undefined &&
    !activeAccounts.some((account) => account.id === occurrence.accountId);
  const activeCategories = flatten(categories.data ?? []).filter(
    (category) => category.status === 'active',
  );
  const categoryArchived =
    kind !== 'transfer' &&
    occurrence.categoryId !== undefined &&
    categories.data !== undefined &&
    !activeCategories.some((category) => category.id === occurrence.categoryId);

  const submit = () => {
    const next: Partial<Record<Field, string>> = {};
    const input: ConfirmOccurrenceInput = { transactionId, date };
    const parsedAmount = positiveDecimal(amount);
    if (parsedAmount === null) next.amount = t('confirm.amountError');
    else input.amount = parsedAmount;
    if (!LOCAL_DATE.test(date) || date > today) next.date = t('confirm.dateError');
    if (rate.trim() !== '') {
      const parsedRate = positiveDecimal(rate);
      if (parsedRate === null) next.rate = t('confirm.rateError');
      else if (kind === 'transfer') input.declaredRate = parsedRate;
      else input.rateUsdBob = parsedRate;
    }
    if (accountArchived) {
      if (accountId === '') next.account = t('confirm.accountError');
      else input.accountId = accountId;
    }
    if (categoryArchived) {
      if (categoryId === '') next.category = t('confirm.categoryError');
      else input.categoryId = categoryId;
    }
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    confirm.mutate(input, { onSuccess: onClose });
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent closeLabel={t('confirm.close')}>
        <DialogHeader>
          <DialogTitle>{t('confirm.title', { name: occurrence.ruleName })}</DialogTitle>
          <DialogDescription>{t('confirm.description')}</DialogDescription>
        </DialogHeader>
        <form
          noValidate
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <div className="flex flex-col gap-2">
            <Label htmlFor="confirm-amount">{t('confirm.amount')}</Label>
            <Input
              id="confirm-amount"
              inputMode="decimal"
              autoComplete="off"
              className="h-11 tabular-nums"
              value={amount}
              aria-invalid={errors.amount !== undefined}
              onChange={(event) => {
                setAmount(event.target.value);
              }}
            />
            {errors.amount !== undefined && (
              <p className="text-sm text-destructive">{errors.amount}</p>
            )}
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="confirm-date">{t('confirm.date')}</Label>
            <Input
              id="confirm-date"
              type="date"
              max={today}
              className="h-11 tabular-nums"
              value={date}
              aria-invalid={errors.date !== undefined}
              onChange={(event) => {
                setDate(event.target.value);
              }}
            />
            {errors.date !== undefined && <p className="text-sm text-destructive">{errors.date}</p>}
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="confirm-rate">{t('confirm.rate')}</Label>
            <Input
              id="confirm-rate"
              inputMode="decimal"
              autoComplete="off"
              className="h-11 tabular-nums"
              value={rate}
              aria-invalid={errors.rate !== undefined}
              onChange={(event) => {
                setRate(event.target.value);
              }}
            />
            {errors.rate !== undefined && <p className="text-sm text-destructive">{errors.rate}</p>}
          </div>
          {accountArchived && (
            <div className="flex flex-col gap-2">
              <Label htmlFor="confirm-account">{t('confirm.account')}</Label>
              <p className="text-sm text-muted-foreground">{t('confirm.accountArchived')}</p>
              <select
                id="confirm-account"
                className={SELECT_CLASS}
                value={accountId}
                aria-invalid={errors.account !== undefined}
                onChange={(event) => {
                  setAccountId(event.target.value);
                }}
              >
                <option value="">{t('confirm.choose')}</option>
                {activeAccounts.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.name}
                  </option>
                ))}
              </select>
              {errors.account !== undefined && (
                <p className="text-sm text-destructive">{errors.account}</p>
              )}
            </div>
          )}
          {categoryArchived && (
            <div className="flex flex-col gap-2">
              <Label htmlFor="confirm-category">{t('confirm.category')}</Label>
              <p className="text-sm text-muted-foreground">{t('confirm.categoryArchived')}</p>
              <select
                id="confirm-category"
                className={SELECT_CLASS}
                value={categoryId}
                aria-invalid={errors.category !== undefined}
                onChange={(event) => {
                  setCategoryId(event.target.value);
                }}
              >
                <option value="">{t('confirm.choose')}</option>
                {activeCategories.map((category) => (
                  <option key={category.id} value={category.id}>
                    {category.name}
                  </option>
                ))}
              </select>
              {errors.category !== undefined && (
                <p className="text-sm text-destructive">{errors.category}</p>
              )}
            </div>
          )}
          {confirm.isError && (
            <p role="alert" className="text-sm text-destructive">
              {messageForError(confirm.error instanceof ApiError ? confirm.error : { code: '' })}
            </p>
          )}
          <DialogFooter className="gap-2">
            <Button type="button" variant="outline" className="h-11" onClick={onClose}>
              {t('confirm.cancel')}
            </Button>
            <Button type="submit" className="h-11" disabled={confirm.isPending}>
              {t('confirm.submit')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
