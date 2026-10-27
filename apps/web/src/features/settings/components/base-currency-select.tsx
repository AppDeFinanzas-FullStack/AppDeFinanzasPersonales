import { CurrencyCode, CurrencyListItemDto, FxSettingsInput } from '@finanzas/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';

import { Label } from '@/components/ui/label';
import { ApiError, call, type Endpoint } from '@/lib/api-client';
import { messageForError } from '@/lib/i18n-errors';

const CurrencyList = z.object({ items: z.array(CurrencyListItemDto) });
type CurrencyList = z.infer<typeof CurrencyList>;

const listCurrenciesEndpoint: Endpoint<undefined, CurrencyList> = {
  method: 'GET',
  path: '/api/currencies',
  input: z.undefined(),
  output: CurrencyList,
};

const updateBaseEndpoint: Endpoint<FxSettingsInput, void> = {
  method: 'PATCH',
  path: '/api/fx-settings',
  input: FxSettingsInput,
  output: z.void(),
};

/** BOB and USD are always active and have no rate of their own (RF-M3-01). */
const SYSTEM_CURRENCIES = [
  { code: 'BOB', symbol: 'Bs' },
  { code: 'USD', symbol: '$' },
] as const;

interface Option {
  code: string;
  symbol: string;
}

/** The currencies the base can be: BOB, USD and the added ones that are still active. */
function optionsFor(base: string, list: CurrencyList | undefined): Option[] {
  const options: Option[] = [
    ...SYSTEM_CURRENCIES,
    ...(list?.items ?? []).filter((currency) => currency.status === 'active'),
  ];
  // If the list failed to load, the current base is still shown as chosen.
  if (!options.some((option) => option.code === base)) options.push({ code: base, symbol: base });
  return options;
}

/** The base currency of the totals and balances; changing it re-expresses them (RF-M3-11). */
export function BaseCurrencySelect({ base }: { base: string }) {
  const { t } = useTranslation('settings');
  const queryClient = useQueryClient();
  const currencies = useQuery({
    // Apart from `['currencies']`, whose cache does not keep the status.
    queryKey: ['currencies', 'with-status'],
    queryFn: ({ signal }) => call(listCurrenciesEndpoint, undefined, { signal }),
  });
  const update = useMutation({
    mutationFn: (baseCurrency: string) => call(updateBaseEndpoint, { baseCurrency }),
    // Plan §4.3.4: every M3 mutation refreshes every query.
    onSuccess: () => queryClient.invalidateQueries(),
  });
  const selected = update.isPending && update.variables !== undefined ? update.variables : base;

  // The choices appear together with the added currencies, so none is missing when picking.
  if (currencies.isPending) return null;

  return (
    <section className="flex flex-col gap-2">
      <Label htmlFor="settings-base-currency">{t('currencies.base.label')}</Label>
      <select
        id="settings-base-currency"
        className="flex h-11 w-full rounded-md border border-input bg-background px-3 py-2 text-base ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:opacity-50 md:text-sm"
        value={selected}
        disabled={update.isPending}
        aria-describedby="settings-base-currency-hint"
        onChange={(event) => {
          const parsed = CurrencyCode.safeParse(event.target.value);
          if (parsed.success) update.mutate(parsed.data);
        }}
      >
        {optionsFor(base, currencies.data).map((option) => (
          <option key={option.code} value={option.code}>
            {option.code} · {option.symbol}
          </option>
        ))}
      </select>
      <p id="settings-base-currency-hint" className="text-sm text-muted-foreground">
        {t('currencies.base.hint')}
      </p>
      {update.isError && (
        <p role="alert" className="text-sm text-destructive">
          {messageForError(update.error instanceof ApiError ? update.error : { code: '' })}
        </p>
      )}
    </section>
  );
}
