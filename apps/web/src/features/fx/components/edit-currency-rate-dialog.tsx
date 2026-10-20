import { UpdateCurrencyInput, type CurrencyDto } from '@finanzas/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
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
import { call, type Endpoint } from '@/lib/api-client';

import { activateCurrencyEndpoint, checkRate, currencyErrorMessage } from './add-currency-dialog';

function updateCurrencyEndpoint(code: string): Endpoint<UpdateCurrencyInput, void> {
  return {
    method: 'PATCH',
    path: `/api/currencies/${encodeURIComponent(code)}`,
    input: UpdateCurrencyInput,
    output: z.void(),
  };
}

export type RateDialogMode = 'edit' | 'activate';

/**
 * A new rate in Bs for an added currency: edits it, or reactivates a deactivated one, which
 * always needs a new rate (RF-M3-02, plan §4.3.3).
 */
export function EditCurrencyRateDialog({
  currency,
  mode,
  onClose,
  onDone,
}: {
  currency: CurrencyDto;
  mode: RateDialogMode;
  onClose: () => void;
  onDone: () => void;
}) {
  const { t } = useTranslation('fx');
  const queryClient = useQueryClient();
  const [raw, setRaw] = useState(mode === 'edit' ? currency.rate.replace('.', ',') : '');
  const [fieldError, setFieldError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: (rate: string) =>
      mode === 'edit'
        ? call(updateCurrencyEndpoint(currency.code), { rate })
        : call(activateCurrencyEndpoint(currency.code), { rate }),
    // Plan §4.3.4: every M3 mutation refreshes every query.
    onSuccess: async () => {
      await queryClient.invalidateQueries();
      onDone();
    },
  });

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent closeLabel={t('currencies.close')}>
        <DialogHeader>
          <DialogTitle>
            {t(mode === 'edit' ? 'currencies.edit.title' : 'currencies.activate.title', {
              code: currency.code,
            })}
          </DialogTitle>
          <DialogDescription>
            {t(mode === 'edit' ? 'currencies.edit.description' : 'currencies.activate.description')}
          </DialogDescription>
        </DialogHeader>
        <form
          noValidate
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            const rate = checkRate(raw);
            if (!rate.ok) {
              setFieldError(
                rate.error === 'belowMinimum'
                  ? t('currencies.errors.belowMinimum')
                  : t('currencies.errors.rate'),
              );
              return;
            }
            setFieldError(null);
            save.mutate(rate.rate);
          }}
        >
          <div className="flex flex-col gap-2">
            <Label htmlFor="currency-new-rate">{t('currencies.fields.rate')}</Label>
            <Input
              id="currency-new-rate"
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
          {save.isError && (
            <p role="alert" className="text-sm text-destructive">
              {currencyErrorMessage(save.error)}
            </p>
          )}
          <DialogFooter className="gap-2">
            <Button type="button" variant="outline" className="h-11" onClick={onClose}>
              {t('currencies.cancel')}
            </Button>
            <Button type="submit" className="h-11" disabled={save.isPending}>
              {save.isPending
                ? t('currencies.saving')
                : t(mode === 'edit' ? 'currencies.edit.submit' : 'currencies.activate.submit')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
