import { ResetSettingsInput } from '@finanzas/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { CurrenciesList } from '@/features/fx/components/currencies-list';
import { ManualValueCard } from '@/features/fx/components/manual-value-card';
import { ReferenceSelector } from '@/features/fx/components/reference-selector';
import { useCurrentRate } from '@/features/fx/hooks/use-current-rate';
import { call, type Endpoint } from '@/lib/api-client';

import { BaseCurrencySelect } from './base-currency-select';

const resetCurrenciesEndpoint: Endpoint<ResetSettingsInput, void> = {
  method: 'POST',
  path: '/api/settings/reset',
  input: ResetSettingsInput,
  output: z.void(),
};

/**
 * "Restablecer valores por defecto" of the section: the reference goes back to the parallel median
 * and the manual value is turned off. It refreshes every query, since the rate in use changes
 * (plan §4.3.4, §4.9.4).
 */
function ResetCurrenciesButton() {
  const { t } = useTranslation('settings');
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);

  const reset = useMutation({
    mutationFn: () => call(resetCurrenciesEndpoint, { section: 'currencies' }),
    onSuccess: async () => {
      await queryClient.invalidateQueries();
      setOpen(false);
    },
  });

  return (
    <>
      <Button
        type="button"
        variant="outline"
        className="h-11 self-start"
        onClick={() => {
          reset.reset();
          setOpen(true);
        }}
      >
        {t('reset.button')}
      </Button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('reset.title')}</AlertDialogTitle>
            <AlertDialogDescription>{t('currencies.resetDescription')}</AlertDialogDescription>
          </AlertDialogHeader>
          {reset.isError && (
            <p role="alert" className="text-sm text-destructive">
              {t('reset.error')}
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel className="h-11">{t('reset.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              className="h-11"
              disabled={reset.isPending}
              onClick={(event) => {
                event.preventDefault();
                reset.mutate();
              }}
            >
              {t('reset.confirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

/** `/ajustes/monedas`: the base currency and the panel of the exchange rate (plan §4.3.4). */
export function CurrencySettings() {
  const { t } = useTranslation('settings');
  const rates = useCurrentRate();

  if (rates.isError && rates.data === undefined) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {t('currencies.loadError')}
      </p>
    );
  }
  if (rates.data === undefined) return null;
  const { base, inUse } = rates.data;

  return (
    <div className="flex flex-col gap-8">
      <h1 className="text-2xl font-semibold">{t('sections.currencies.title')}</h1>
      <BaseCurrencySelect base={base} />
      <Separator />
      <ReferenceSelector inUse={inUse} />
      <Separator />
      <ManualValueCard inUse={inUse} now={rates.dataUpdatedAt} />
      <Separator />
      <CurrenciesList />
      <Separator />
      <ResetCurrenciesButton />
    </div>
  );
}
