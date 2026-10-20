import type { UseFormReturn } from 'react-hook-form';
import { useTranslation } from 'react-i18next';

import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

import type { AccountFormValues } from './account-form';

/**
 * The card subform (RF-M4-08): whether the amount is the current debt or a balance in favor, and
 * the optional cut day, pay day and limit.
 */
export function CardFields({
  form,
  showBalanceKind,
  showDetails = true,
}: {
  form: UseFormReturn<AccountFormValues>;
  showBalanceKind: boolean;
  showDetails?: boolean;
}) {
  const { t } = useTranslation('accounts');
  const {
    register,
    formState: { errors },
  } = form;

  return (
    <fieldset className="flex flex-col gap-4 rounded-lg border border-border p-4">
      <legend className="px-1 text-sm font-medium">{t('card.title')}</legend>
      {showBalanceKind && (
        <div role="radiogroup" aria-label={t('card.balanceKind')} className="flex flex-col gap-2">
          {(['debt', 'credit'] as const).map((kind) => (
            <label key={kind} className="flex min-h-11 items-center gap-3">
              <input
                type="radio"
                value={kind}
                className="h-4 w-4 accent-[hsl(var(--primary))]"
                {...register('cardBalanceKind')}
              />
              {t(`card.kinds.${kind}`)}
            </label>
          ))}
        </div>
      )}
      {showDetails && (
        <>
          <div className="grid grid-cols-2 gap-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor="card-cut-day">{t('card.cutDay')}</Label>
              <Input
                id="card-cut-day"
                inputMode="numeric"
                autoComplete="off"
                className="h-11 tabular-nums"
                aria-invalid={errors.cutDay !== undefined}
                {...register('cutDay')}
              />
              {errors.cutDay?.message !== undefined && (
                <p className="text-sm text-destructive">{errors.cutDay.message}</p>
              )}
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="card-pay-day">{t('card.payDay')}</Label>
              <Input
                id="card-pay-day"
                inputMode="numeric"
                autoComplete="off"
                className="h-11 tabular-nums"
                aria-invalid={errors.payDay !== undefined}
                {...register('payDay')}
              />
              {errors.payDay?.message !== undefined && (
                <p className="text-sm text-destructive">{errors.payDay.message}</p>
              )}
            </div>
          </div>
          <p className="text-sm text-muted-foreground">{t('card.daysHint')}</p>
          <div className="flex flex-col gap-2">
            <Label htmlFor="card-limit">{t('card.limit')}</Label>
            <Input
              id="card-limit"
              inputMode="decimal"
              autoComplete="off"
              className="h-11 tabular-nums"
              aria-invalid={errors.limit !== undefined}
              {...register('limit')}
            />
            {errors.limit?.message !== undefined && (
              <p className="text-sm text-destructive">{errors.limit.message}</p>
            )}
          </div>
        </>
      )}
    </fieldset>
  );
}
