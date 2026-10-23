import type { GoalDto, ReleaseInput } from '@finanzas/contracts';
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
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
import { useCurrencySymbol } from '@/features/accounts/hooks/use-accounts';
import { useFormatters } from '@/features/settings/hooks/use-settings';
import { ApiError, call, type Endpoint } from '@/lib/api-client';
import { messageForError } from '@/lib/i18n-errors';

import { useInvalidateGoals } from './goal-form';

function releaseEndpoint(goalId: string): Endpoint<ReleaseInput, unknown> {
  return {
    method: 'POST',
    path: `/api/goals/${encodeURIComponent(goalId)}/earmarks/release`,
    input: z.custom<ReleaseInput>(),
    output: z.unknown(),
  };
}

/** "Liberar": returns earmarked money of one account to its free balance (RF-M12-03). */
export function ReleaseDialog({
  goal,
  open,
  onOpenChange,
}: {
  goal: GoalDto;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation('goals');
  const formatters = useFormatters();
  const symbol = useCurrencySymbol()(goal.currencyCode);
  const invalidate = useInvalidateGoals();
  const [accountId, setAccountId] = useState('');
  const [raw, setRaw] = useState('');
  const [fieldError, setFieldError] = useState<string | null>(null);

  const earmarked = goal.byAccount.filter((entry) => !/^0(\.0+)?$/.test(entry.amount));
  const selected = earmarked.find((entry) => entry.accountId === accountId) ?? earmarked[0];

  const close = () => {
    setRaw('');
    setFieldError(null);
    release.reset();
    onOpenChange(false);
  };

  const release = useMutation({
    mutationFn: (input: ReleaseInput) => call(releaseEndpoint(goal.id), input),
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
    release.mutate({ accountId: selected.accountId, amount });
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
          <DialogTitle>{t('release.title')}</DialogTitle>
          <DialogDescription>{t('release.description')}</DialogDescription>
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
            <Label htmlFor="release-account">{t('release.account')}</Label>
            <select
              id="release-account"
              className="flex h-11 w-full rounded-md border border-input bg-background px-3 text-base"
              value={selected?.accountId ?? ''}
              onChange={(event) => {
                setAccountId(event.target.value);
              }}
            >
              {earmarked.map((entry) => (
                <option key={entry.accountId} value={entry.accountId}>
                  {entry.name}
                </option>
              ))}
            </select>
            {selected !== undefined && (
              <p className="text-sm text-muted-foreground tabular-nums">
                {t('release.earmarked', { amount: formatters.money(selected.amount, symbol) })}
              </p>
            )}
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="release-amount">{t('amount.label')}</Label>
            <Input
              id="release-amount"
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
          {release.isError && (
            <p role="alert" className="text-sm text-destructive">
              {messageForError(release.error instanceof ApiError ? release.error : { code: '' })}
            </p>
          )}
          <DialogFooter className="gap-2">
            <Button type="button" variant="outline" className="h-11" onClick={close}>
              {t('actions.cancel')}
            </Button>
            <Button
              type="submit"
              className="h-11"
              disabled={release.isPending || selected === undefined}
            >
              {t('release.submit')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
