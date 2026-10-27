import type { DedicateInput, GoalDto } from '@finanzas/contracts';
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
import { useAccounts } from '@/features/accounts/hooks/use-accounts';
import { ApiError, call, type Endpoint } from '@/lib/api-client';
import { messageForError } from '@/lib/i18n-errors';

import { useInvalidateGoals } from './goal-form';

function dedicateEndpoint(goalId: string): Endpoint<DedicateInput, unknown> {
  return {
    method: 'POST',
    path: `/api/goals/${encodeURIComponent(goalId)}/dedicate`,
    input: z.custom<DedicateInput>(),
    output: z.unknown(),
  };
}

/** "Dedicar": a card is never offered (RF-M12-03, EC-M12-08). */
export function DedicateDialog({
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
  const invalidate = useInvalidateGoals();
  const [accountId, setAccountId] = useState('');

  const eligible = (accounts.data?.items ?? []).filter(
    (account) =>
      account.type !== 'credit_card' &&
      account.currencyCode === goal.currencyCode &&
      account.dedicatedGoal === undefined &&
      /^0(\.0+)?$/.test(account.earmarked),
  );

  const close = () => {
    setAccountId('');
    dedicate.reset();
    onOpenChange(false);
  };

  const dedicate = useMutation({
    mutationFn: (input: DedicateInput) => call(dedicateEndpoint(goal.id), input),
    onSuccess: async () => {
      await invalidate();
      close();
    },
  });

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
          <DialogTitle>{t('dedicate.title')}</DialogTitle>
          <DialogDescription>{t('dedicate.description')}</DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (accountId !== '') dedicate.mutate({ accountId });
          }}
        >
          {eligible.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('dedicate.none')}</p>
          ) : (
            <div role="radiogroup" aria-label={t('dedicate.title')} className="flex flex-col gap-2">
              {eligible.map((account) => (
                <label key={account.id} className="flex min-h-11 items-center gap-3">
                  <input
                    type="radio"
                    name="dedicate-account"
                    value={account.id}
                    checked={accountId === account.id}
                    className="h-4 w-4 accent-[hsl(var(--primary))]"
                    onChange={() => {
                      setAccountId(account.id);
                    }}
                  />
                  <span>{account.name}</span>
                </label>
              ))}
            </div>
          )}
          {dedicate.isError && (
            <p role="alert" className="text-sm text-destructive">
              {messageForError(dedicate.error instanceof ApiError ? dedicate.error : { code: '' })}
            </p>
          )}
          <DialogFooter className="gap-2">
            <Button type="button" variant="outline" className="h-11" onClick={close}>
              {t('actions.cancel')}
            </Button>
            <Button
              type="submit"
              className="h-11"
              disabled={dedicate.isPending || accountId === ''}
            >
              {t('dedicate.submit')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
