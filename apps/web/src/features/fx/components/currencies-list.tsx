import { CurrencyDto } from '@finanzas/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';

import { Button } from '@/components/ui/button';
import { useFormatters } from '@/features/settings/hooks/use-settings';
import { ApiError, call, type Endpoint } from '@/lib/api-client';

import { AddCurrencyDialog, currencyErrorMessage } from './add-currency-dialog';
import { EditCurrencyRateDialog, type RateDialogMode } from './edit-currency-rate-dialog';

const CurrencyList = z.object({ items: z.array(CurrencyDto) });
type CurrencyList = z.infer<typeof CurrencyList>;

const listCurrenciesEndpoint: Endpoint<undefined, CurrencyList> = {
  method: 'GET',
  path: '/api/currencies',
  input: z.undefined(),
  output: CurrencyList,
};

function deactivateCurrencyEndpoint(code: string): Endpoint<undefined, void> {
  return {
    method: 'POST',
    path: `/api/currencies/${encodeURIComponent(code)}/deactivate`,
    input: z.undefined(),
    output: z.void(),
  };
}

const UsedBy = z.array(z.string());

interface Failure {
  code: string;
  message: string;
}

/** The added currencies with their rate in Bs: add, edit the rate, deactivate (RF-M3-02). */
export function CurrenciesList() {
  const { t } = useTranslation('fx');
  const formatters = useFormatters();
  const queryClient = useQueryClient();
  const currencies = useQuery({
    queryKey: ['currencies'],
    queryFn: ({ signal }) => call(listCurrenciesEndpoint, undefined, { signal }),
  });
  const [adding, setAdding] = useState(false);
  const [dialog, setDialog] = useState<{ currency: CurrencyDto; mode: RateDialogMode } | null>(
    null,
  );
  // The list does not say which currencies are inactive; this one remembers the ones
  // deactivated here so they can be reactivated right away.
  const [deactivated, setDeactivated] = useState<ReadonlySet<string>>(new Set());
  const [failure, setFailure] = useState<Failure | null>(null);

  /** EC-M3-05: a currency in use says what uses it. */
  const failureMessage = (error: unknown): string => {
    if (error instanceof ApiError && error.code === 'CURRENCY_IN_USE') {
      const usedBy = UsedBy.safeParse(error.data?.usedBy);
      const names = (usedBy.success ? usedBy.data : [])
        .map((module) => t(`currencies.usedBy.${module}`, { defaultValue: '' }))
        .filter((name) => name !== '');
      if (names.length > 0) return t('currencies.errors.inUseBy', { modules: names.join(', ') });
    }
    return currencyErrorMessage(error);
  };

  const deactivate = useMutation({
    mutationFn: (code: string) => call(deactivateCurrencyEndpoint(code), undefined),
    onMutate: () => {
      setFailure(null);
    },
    // Plan §4.3.4: every M3 mutation refreshes every query.
    onSuccess: async (_data, code) => {
      setDeactivated((current) => new Set(current).add(code));
      await queryClient.invalidateQueries();
    },
    onError: (error, code) => {
      setFailure({ code, message: failureMessage(error) });
    },
  });

  const items = currencies.data?.items ?? [];

  return (
    <section aria-labelledby="fx-currencies" className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-4">
        <h2 id="fx-currencies" className="text-lg font-semibold">
          {t('currencies.title')}
        </h2>
        <Button
          type="button"
          variant="outline"
          className="h-11"
          onClick={() => {
            setAdding(true);
          }}
        >
          {t('currencies.add.open')}
        </Button>
      </div>
      {currencies.isError && currencies.data === undefined ? (
        <p role="alert" className="text-sm text-destructive">
          {t('currencies.loadError')}
        </p>
      ) : items.length === 0 ? (
        currencies.isSuccess && (
          <p className="text-sm text-muted-foreground">{t('currencies.empty')}</p>
        )
      ) : (
        <ul className="flex flex-col divide-y divide-border rounded-lg border border-border">
          {items.map((currency) => {
            const inactive = deactivated.has(currency.code);
            return (
              <li
                key={currency.code}
                data-testid={`currency-${currency.code}`}
                className="flex flex-col gap-2 px-4 py-3"
              >
                <div className="flex items-baseline justify-between gap-4">
                  <span className="font-medium">
                    {currency.code} · {currency.symbol}
                    {inactive && (
                      <span className="ml-2 text-sm font-normal text-muted-foreground">
                        {t('currencies.inactive')}
                      </span>
                    )}
                  </span>
                  <span className="text-right font-semibold tabular-nums">
                    {formatters.money(currency.rate, 'Bs')}
                  </span>
                </div>
                <div className="flex flex-wrap gap-2">
                  {inactive ? (
                    <Button
                      type="button"
                      variant="ghost"
                      className="h-11"
                      onClick={() => {
                        setDialog({ currency, mode: 'activate' });
                      }}
                    >
                      {t('currencies.activate.open', { code: currency.code })}
                    </Button>
                  ) : (
                    <>
                      <Button
                        type="button"
                        variant="ghost"
                        className="h-11"
                        onClick={() => {
                          setDialog({ currency, mode: 'edit' });
                        }}
                      >
                        {t('currencies.edit.open', { code: currency.code })}
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        className="h-11"
                        disabled={deactivate.isPending}
                        onClick={() => {
                          deactivate.mutate(currency.code);
                        }}
                      >
                        {t('currencies.deactivate', { code: currency.code })}
                      </Button>
                    </>
                  )}
                </div>
                {failure?.code === currency.code && (
                  <p role="alert" className="text-sm text-destructive">
                    {failure.message}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <AddCurrencyDialog open={adding} onOpenChange={setAdding} />
      {dialog !== null && (
        <EditCurrencyRateDialog
          currency={dialog.currency}
          mode={dialog.mode}
          onClose={() => {
            setDialog(null);
          }}
          onDone={() => {
            if (dialog.mode === 'activate') {
              setDeactivated((current) => {
                const next = new Set(current);
                next.delete(dialog.currency.code);
                return next;
              });
            }
            setDialog(null);
          }}
        />
      )}
    </section>
  );
}
