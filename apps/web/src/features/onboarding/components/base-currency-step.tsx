import { Step1Input, type OnboardingDto } from '@finanzas/contracts';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { useFormatters } from '@/features/settings/hooks/use-settings';

type BaseCurrency = Step1Input['baseCurrency'];

/** The base currencies of step 1, BOB first because it is the default (spec §2.10.1). */
const BASE_CURRENCIES = Step1Input.shape.baseCurrency.options;
const DEFAULT_BASE: BaseCurrency = 'BOB';

/** The USD rate is in bolivianos (RF-M3-01). */
const BOB_SYMBOL = 'Bs';

export interface BaseCurrencyStepProps {
  /** The USD rate in use, or `null` when there is none yet. */
  rate: OnboardingDto['rate'];
  busy: boolean;
  onContinue: (baseCurrency: BaseCurrency) => void;
}

/**
 * Step 1: the base currency, BOB by default, and the dollar the app will use, or that it has none
 * yet (spec §2.10.1).
 */
export function BaseCurrencyStep({ rate, busy, onContinue }: BaseCurrencyStepProps) {
  const { t } = useTranslation('onboarding');
  const formatters = useFormatters();
  const [base, setBase] = useState<BaseCurrency>(DEFAULT_BASE);
  const value = rate?.value ?? null;

  return (
    <form
      noValidate
      className="flex flex-col gap-6"
      onSubmit={(event) => {
        event.preventDefault();
        onContinue(base);
      }}
    >
      <div role="radiogroup" aria-label={t('baseCurrency.label')} className="flex flex-col gap-2">
        {BASE_CURRENCIES.map((code) => (
          <label
            key={code}
            className="flex min-h-11 items-center gap-3 rounded-md border border-border px-4"
          >
            <input
              type="radio"
              name="onboarding-base-currency"
              value={code}
              checked={base === code}
              className="h-4 w-4 accent-[hsl(var(--primary))]"
              onChange={() => {
                setBase(code);
              }}
            />
            {t(`baseCurrency.options.${code}`)}
          </label>
        ))}
      </div>
      <div className="flex flex-col gap-2">
        <p>{t('baseCurrency.bothCurrencies')}</p>
        <p>
          {value === null
            ? t('baseCurrency.noRate')
            : t('baseCurrency.rate', { value: formatters.money(value, BOB_SYMBOL) })}
        </p>
      </div>
      <Button type="submit" className="h-11" disabled={busy}>
        {t('baseCurrency.continue')}
      </Button>
    </form>
  );
}
