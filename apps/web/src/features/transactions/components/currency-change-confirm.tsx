import { parseAmountInput } from '@finanzas/domain';
import { Decimal } from 'decimal.js';
import type { UseFormRegisterReturn } from 'react-hook-form';
import { useTranslation } from 'react-i18next';

import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

/** The largest amount of a movement (RF-M6-01). */
export const MAX_AMOUNT = new Decimal('999999999.99');

/**
 * The amount in `to` with the rates the movement stored (RF-M6-07): its currency to Bs with
 * `rateCurBob`, then Bs to `to`. `null` when it did not store the rate of `to`.
 */
export function convertWithStoredRates(
  amount: string,
  rateCurBob: string,
  rateUsdBob: string | null | undefined,
  to: string,
): string | null {
  const value = parseAmountInput(amount);
  const rateTo =
    to === 'BOB'
      ? new Decimal(1)
      : to === 'USD' && rateUsdBob !== null && rateUsdBob !== undefined
        ? new Decimal(rateUsdBob)
        : null;
  if (value === null || rateTo === null) return null;
  return new Decimal(value.toString())
    .times(rateCurBob)
    .dividedBy(rateTo)
    .toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
    .toFixed(2);
}

interface CurrencyChangeConfirmProps {
  id: string;
  /** The currency of the new account. */
  code: string;
  /** Whether the amount came prefilled with a stored rate. */
  prefilled: boolean;
  field: UseFormRegisterReturn;
  error?: string | undefined;
}

/**
 * The amount in the currency of the new account, prefilled with the stored rate for the user to
 * confirm or correct (RF-M6-07, RF-M3-10); over the maximum it is rejected (EC-M6-07).
 */
export function CurrencyChangeConfirm({
  id,
  code,
  prefilled,
  field,
  error,
}: CurrencyChangeConfirmProps) {
  const { t } = useTranslation('transactions');
  const helpId = `${id}-help`;
  const errorId = `${id}-error`;
  return (
    <fieldset className="flex flex-col gap-2 rounded-md border border-border p-4">
      <legend className="px-1 text-sm font-medium">{t('currencyChange.title', { code })}</legend>
      <Label htmlFor={id}>{t('currencyChange.amount', { code })}</Label>
      <Input
        id={id}
        inputMode="decimal"
        autoComplete="off"
        className="h-11 tabular-nums"
        aria-invalid={error !== undefined}
        aria-describedby={error === undefined ? helpId : `${helpId} ${errorId}`}
        {...field}
      />
      <p id={helpId} className="text-sm text-muted-foreground">
        {prefilled ? t('currencyChange.help') : t('currencyChange.helpNoRate', { code })}
      </p>
      {error !== undefined && (
        <p id={errorId} role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </fieldset>
  );
}
