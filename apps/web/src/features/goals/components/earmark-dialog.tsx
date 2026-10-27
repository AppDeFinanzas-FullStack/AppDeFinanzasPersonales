import type { EarmarkInput, GoalDto } from '@finanzas/contracts';
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { uuidv7 } from 'uuidv7';
import { z } from 'zod';

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
import { parseSignedAmount } from '@/features/accounts/components/account-form';
import { useAccounts, useCurrencySymbol } from '@/features/accounts/hooks/use-accounts';
import { useFormatters } from '@/features/settings/hooks/use-settings';
import { ApiError, call, type Endpoint } from '@/lib/api-client';
import { messageForError } from '@/lib/i18n-errors';

import { useInvalidateGoals } from './goal-form';

function earmarkEndpoint(goalId: string): Endpoint<EarmarkInput, unknown> {
  return {
    method: 'POST',
    path: `/api/goals/${encodeURIComponent(goalId)}/earmarks`,
    input: z.custom<EarmarkInput>(),
    output: z.unknown(),
  };
}

/** "Apartar": earmarks part of the free balance of an account for the goal (EC-M12-01). */
export function EarmarkDialog({
  goal,
  open,
  onOpenChange,
}: {
  goal: GoalDto;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation('goals');
  const accounts = useAccounts('active');
  const formatters = useFormatters();
  const symbol = useCurrencySymbol()(goal.currencyCode);
  const invalidate = useInvalidateGoals();
  const [earmarkId, setEarmarkId] = useState(() => uuidv7());
  const [accountId, setAccountId] = useState('');
  const [raw, setRaw] = useState('');
  const [fieldError, setFieldError] = useState<string | null>(null);

  const eligible = (accounts.data?.items ?? []).filter(
    (account) =>
      account.type !== 'credit_card' &&
      account.currencyCode === goal.currencyCode &&
      (account.dedicatedGoal === undefined || account.dedicatedGoal.id === goal.id),
  );
  const selected = eligible.find((account) => account.id === accountId) ?? eligible[0];

  const close = () => {
    setRaw('');
    setFieldError(null);
    setEarmarkId(uuidv7());
    save.reset();
    onOpenChange(false);
  };

  const save = useMutation({
    mutationFn: (input: EarmarkInput) => call(earmarkEndpoint(goal.id), input),
    onSuccess: async () => {
      await invalidate();
      close();
    },
  });

  const submit = () => {
    const amount = parseSignedAmount(raw);
    if (selected === undefined || amount === null || amount.startsWith('-') || amount === '0.00') {
      setFieldError(t('amount.error'));
      return;
    }
    setFieldError(null);
    save.mutate({ id: earmarkId, accountId: selected.id, amount });
  };

  const free = selected === undefined ? undefined : formatters.money(selected.free, symbol);

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
          <DialogTitle>{t('earmark.title')}</DialogTitle>
          <DialogDescription>{t('earmark.description')}</DialogDescription>
        </DialogHeader>
        <form
          noValidate
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          {eligible.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('earmark.noAccounts')}</p>
          ) : (
            <>
              <div className="flex flex-col gap-2">
                <Label htmlFor="earmark-account">{t('earmark.account')}</Label>
                <select
                  id="earmark-account"
                  className="flex h-11 w-full rounded-md border border-input bg-background px-3 text-base"
                  value={selected?.id ?? ''}
                  onChange={(event) => {
                    setAccountId(event.target.value);
                  }}
                >
                  {eligible.map((account) => (
                    <option key={account.id} value={account.id}>
                      {account.name}
                    </option>
                  ))}
                </select>
                {free !== undefined && (
                  <p className="text-sm text-muted-foreground tabular-nums">
                    {t('earmark.free', { free })}
                  </p>
                )}
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="earmark-amount">{t('amount.label')}</Label>
                <Input
                  id="earmark-amount"
                  inputMode="decimal"
                  autoComplete="off"
                  className="h-11 tabular-nums"
                  value={raw}
                  aria-invalid={fieldError !== null}
                  onChange={(event) => {
                    setRaw(event.target.value);
                  }}
                />
                {fieldError !== null && <p className="text-sm text-destructive">{fieldError}</p>}
              </div>
            </>
          )}
          {save.isError && (
            <p role="alert" className="text-sm text-destructive">
              {messageForError(
                save.error instanceof ApiError
                  ? {
                      code: save.error.code,
                      ...(free === undefined ? {} : { data: { free } }),
                    }
                  : { code: '' },
              )}
            </p>
          )}
          <DialogFooter className="gap-2">
            <Button type="button" variant="outline" className="h-11" onClick={close}>
              {t('actions.cancel')}
            </Button>
            <Button
              type="submit"
              className="h-11"
              disabled={save.isPending || selected === undefined}
            >
              {t('earmark.submit')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
