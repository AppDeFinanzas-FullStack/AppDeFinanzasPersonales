import { CreateCurrencyInput, CurrencyCode, CurrencyDto } from '@finanzas/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Decimal } from 'decimal.js';
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
import { i18n } from '@/app/providers/i18n';
import { ApiError, call, type Endpoint } from '@/lib/api-client';
import { messageForError } from '@/lib/i18n-errors';

const createCurrencyEndpoint: Endpoint<CreateCurrencyInput, CurrencyDto> = {
  method: 'POST',
  path: '/api/currencies',
  input: CreateCurrencyInput,
  output: CurrencyDto,
};

const ActivateCurrencyInput = z.object({ rate: z.string() });
type ActivateCurrencyInput = z.infer<typeof ActivateCurrencyInput>;

export function activateCurrencyEndpoint(code: string): Endpoint<ActivateCurrencyInput, void> {
  return {
    method: 'POST',
    path: `/api/currencies/${encodeURIComponent(code)}/activate`,
    input: ActivateCurrencyInput,
    output: z.void(),
  };
}

const RATE_INPUT = /^\d+(?:[.,]\d+)?$/;
const RATE_DECIMALS = 2;
const MIN_RATE = '0.01';

export type RateCheck =
  { ok: true; rate: string } | { ok: false; error: 'format' | 'belowMinimum' };

/**
 * What the user typed as a rate in Bs: a value under Bs 0.01 is told apart from a malformed one,
 * so it gets its own explanation (RF-M3-02, EC-M3-07).
 */
export function checkRate(raw: string): RateCheck {
  const text = raw.trim();
  if (!RATE_INPUT.test(text)) return { ok: false, error: 'format' };
  const value = new Decimal(text.replace(',', '.'));
  if (value.lt(MIN_RATE)) return { ok: false, error: 'belowMinimum' };
  if (value.decimalPlaces() > RATE_DECIMALS) return { ok: false, error: 'format' };
  return { ok: true, rate: value.toFixed(RATE_DECIMALS) };
}

/** Catalog text of an API error; a rate under the minimum keeps the explanation of EC-M3-07. */
export function currencyErrorMessage(error: unknown): string {
  if (error instanceof ApiError && error.code === 'RATE_BELOW_MINIMUM') {
    return i18n.t('currencies.errors.belowMinimum', { ns: 'fx' });
  }
  return messageForError(error instanceof ApiError ? error : { code: '' });
}

interface Fields {
  code: string;
  symbol: string;
  rate: string;
}

type FieldErrors = Partial<Record<keyof Fields, string>>;

const EMPTY: Fields = { code: '', symbol: '', rate: '' };

/** Adds a currency with its code, symbol and rate in Bs (RF-M3-02). */
export function AddCurrencyDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation('fx');
  const queryClient = useQueryClient();
  const [fields, setFields] = useState<Fields>(EMPTY);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [taken, setTaken] = useState<CreateCurrencyInput | null>(null);

  const close = () => {
    setFields(EMPTY);
    setErrors({});
    setTaken(null);
    create.reset();
    activate.reset();
    onOpenChange(false);
  };
  // Plan §4.3.4: every M3 mutation refreshes every query.
  const done = async () => {
    await queryClient.invalidateQueries();
    close();
  };
  const create = useMutation({
    mutationFn: (input: CreateCurrencyInput) => call(createCurrencyEndpoint, input),
    onSuccess: done,
    onError: (error, input) => {
      if (error instanceof ApiError && error.code === 'CURRENCY_CODE_TAKEN') setTaken(input);
    },
  });
  // A taken code may belong to a deactivated currency, which comes back with the new rate.
  const activate = useMutation({
    mutationFn: (input: CreateCurrencyInput) =>
      call(activateCurrencyEndpoint(input.code), { rate: input.rate }),
    onSuccess: done,
  });
  const pending = create.isPending || activate.isPending;
  const error = taken === null ? create.error : activate.error;

  const set = (name: keyof Fields, value: string) => {
    setFields((current) => ({ ...current, [name]: value }));
    if (taken !== null) {
      setTaken(null);
      create.reset();
    }
  };

  const submit = () => {
    const next: FieldErrors = {};
    const code = fields.code.trim().toUpperCase();
    if (!CurrencyCode.safeParse(code).success) next.code = t('currencies.errors.code');
    const symbol = fields.symbol.trim();
    if (symbol === '' || symbol.length > 5) next.symbol = t('currencies.errors.symbol');
    const rate = checkRate(fields.rate);
    if (!rate.ok) {
      next.rate =
        rate.error === 'belowMinimum'
          ? t('currencies.errors.belowMinimum')
          : t('currencies.errors.rate');
    }
    setErrors(next);
    if (rate.ok && Object.keys(next).length === 0) create.mutate({ code, symbol, rate: rate.rate });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) onOpenChange(true);
        else close();
      }}
    >
      <DialogContent closeLabel={t('currencies.close')}>
        <DialogHeader>
          <DialogTitle>{t('currencies.add.title')}</DialogTitle>
          <DialogDescription>{t('currencies.add.description')}</DialogDescription>
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
            <Label htmlFor="currency-code">{t('currencies.fields.code')}</Label>
            <Input
              id="currency-code"
              autoComplete="off"
              autoCapitalize="characters"
              maxLength={3}
              className="h-11 uppercase"
              value={fields.code}
              aria-invalid={errors.code !== undefined}
              aria-describedby="currency-code-hint"
              onChange={(event) => {
                set('code', event.target.value);
              }}
            />
            <p id="currency-code-hint" className="text-sm text-muted-foreground">
              {t('currencies.fields.codeHint')}
            </p>
            {errors.code !== undefined && <p className="text-sm text-destructive">{errors.code}</p>}
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="currency-symbol">{t('currencies.fields.symbol')}</Label>
            <Input
              id="currency-symbol"
              autoComplete="off"
              maxLength={5}
              className="h-11"
              value={fields.symbol}
              aria-invalid={errors.symbol !== undefined}
              onChange={(event) => {
                set('symbol', event.target.value);
              }}
            />
            {errors.symbol !== undefined && (
              <p className="text-sm text-destructive">{errors.symbol}</p>
            )}
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="currency-rate">{t('currencies.fields.rate')}</Label>
            <Input
              id="currency-rate"
              inputMode="decimal"
              autoComplete="off"
              className="h-11 tabular-nums"
              value={fields.rate}
              aria-invalid={errors.rate !== undefined}
              onChange={(event) => {
                set('rate', event.target.value);
              }}
            />
            {errors.rate !== undefined && <p className="text-sm text-destructive">{errors.rate}</p>}
          </div>
          {taken !== null && (
            <div role="alert" className="flex flex-col gap-3 rounded-lg border border-border p-4">
              <p className="text-sm">{t('currencies.add.taken', { code: taken.code })}</p>
              <Button
                type="button"
                variant="outline"
                className="h-11"
                disabled={pending}
                onClick={() => {
                  activate.mutate(taken);
                }}
              >
                {t('currencies.add.reactivate', { code: taken.code })}
              </Button>
            </div>
          )}
          {error !== null && (
            <p role="alert" className="text-sm text-destructive">
              {currencyErrorMessage(error)}
            </p>
          )}
          <DialogFooter className="gap-2">
            <Button type="button" variant="outline" className="h-11" onClick={close}>
              {t('currencies.cancel')}
            </Button>
            <Button type="submit" className="h-11" disabled={pending}>
              {create.isPending ? t('currencies.add.submitting') : t('currencies.add.submit')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
