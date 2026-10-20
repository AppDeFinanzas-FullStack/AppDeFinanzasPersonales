import { AdjustInput, type AccountDto } from '@finanzas/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
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
import { ApiError, call, type Endpoint } from '@/lib/api-client';
import { messageForError } from '@/lib/i18n-errors';

import { parseSignedAmount } from './account-form';

const AdjustResult = z.object({ created: z.boolean(), transactionId: z.string().optional() });

function adjustEndpoint(id: string): Endpoint<AdjustInput, z.infer<typeof AdjustResult>> {
  return {
    method: 'POST',
    path: `/api/accounts/${encodeURIComponent(id)}/adjust`,
    input: AdjustInput,
    output: AdjustResult,
  };
}

const NOTE_MAX = 140;

/**
 * "Ajustar saldo" (RF-M4-05): the user gives the real balance, or the real debt of a card, and an
 * adjustment for the difference is created. The same balance creates nothing (EC-M4-08).
 */
export function AdjustBalanceDialog({
  account,
  open,
  onOpenChange,
}: {
  account: AccountDto;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation('accounts');
  const queryClient = useQueryClient();
  const card = account.type === 'credit_card';
  const [transactionId, setTransactionId] = useState(() => uuidv7());
  const [raw, setRaw] = useState('');
  const [kind, setKind] = useState<'debt' | 'credit'>('debt');
  const [note, setNote] = useState('');
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [matches, setMatches] = useState(false);

  const close = () => {
    setRaw('');
    setNote('');
    setFieldError(null);
    setMatches(false);
    setTransactionId(uuidv7());
    adjust.reset();
    onOpenChange(false);
  };

  const adjust = useMutation({
    mutationFn: (input: AdjustInput) => call(adjustEndpoint(account.id), input),
    onSuccess: async (result) => {
      if (!result.created) {
        setMatches(true);
        return;
      }
      // The new balance shows in every list, chart and total.
      await queryClient.invalidateQueries();
      close();
    },
  });

  const submit = () => {
    setMatches(false);
    const amount = parseSignedAmount(raw);
    if (amount === null || (card && amount.startsWith('-'))) {
      setFieldError(t(card ? 'form.errors.cardAmount' : 'adjust.errors.amount'));
      return;
    }
    setFieldError(null);
    const trimmed = note.trim();
    adjust.mutate({
      transactionId,
      realBalance: card ? { kind, amount } : amount,
      ...(trimmed === '' ? {} : { note: trimmed }),
    });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) onOpenChange(true);
        else close();
      }}
    >
      <DialogContent closeLabel={t('detail.close')}>
        <DialogHeader>
          <DialogTitle>{t('adjust.title')}</DialogTitle>
          <DialogDescription>{t('adjust.description')}</DialogDescription>
        </DialogHeader>
        <form
          noValidate
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          {card && (
            <div
              role="radiogroup"
              aria-label={t('card.balanceKind')}
              className="flex flex-col gap-2"
            >
              {(['debt', 'credit'] as const).map((option) => (
                <label key={option} className="flex min-h-11 items-center gap-3">
                  <input
                    type="radio"
                    name="adjust-kind"
                    value={option}
                    checked={kind === option}
                    className="h-4 w-4 accent-[hsl(var(--primary))]"
                    onChange={() => {
                      setKind(option);
                    }}
                  />
                  {t(`adjust.kinds.${option}`)}
                </label>
              ))}
            </div>
          )}
          <div className="flex flex-col gap-2">
            <Label htmlFor="adjust-amount">
              {t(card ? 'adjust.realDebt' : 'adjust.realBalance')}
            </Label>
            <Input
              id="adjust-amount"
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
          <div className="flex flex-col gap-2">
            <Label htmlFor="adjust-note">{t('adjust.note')}</Label>
            <Input
              id="adjust-note"
              autoComplete="off"
              maxLength={NOTE_MAX}
              className="h-11"
              value={note}
              onChange={(event) => {
                setNote(event.target.value);
              }}
            />
          </div>
          {matches && (
            <p role="status" className="text-sm font-medium">
              {t('adjust.matches')}
            </p>
          )}
          {adjust.isError && (
            <p role="alert" className="text-sm text-destructive">
              {messageForError(adjust.error instanceof ApiError ? adjust.error : { code: '' })}
            </p>
          )}
          <DialogFooter className="gap-2">
            <Button type="button" variant="outline" className="h-11" onClick={close}>
              {t('detail.cancel')}
            </Button>
            <Button type="submit" className="h-11" disabled={adjust.isPending}>
              {adjust.isPending ? t('form.saving') : t('adjust.submit')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
