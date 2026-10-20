import { ManualUsdInput, type RatesCurrentDto } from '@finanzas/contracts';
import { parseAmountInput } from '@finanzas/domain';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ApiError, call, type Endpoint } from '@/lib/api-client';
import { messageForError } from '@/lib/i18n-errors';

import { ManualValueBanner } from './manual-value-banner';

const setManualEndpoint: Endpoint<ManualUsdInput, void> = {
  method: 'PUT',
  path: '/api/fx/manual',
  input: ManualUsdInput,
  output: z.void(),
};

const clearManualEndpoint: Endpoint<undefined, void> = {
  method: 'DELETE',
  path: '/api/fx/manual',
  input: z.undefined(),
  output: z.void(),
};

/** What the user typed as a rate, or null when it is not a valid one. */
function toManualInput(raw: string): ManualUsdInput | null {
  const amount = parseAmountInput(raw.trim());
  if (amount === null) return null;
  const parsed = ManualUsdInput.safeParse({ value: amount.toFixed(2) });
  return parsed.success ? parsed.data : null;
}

/** The manual USD value, which has priority over any reference (RF-M3-03). */
export function ManualValueCard({ inUse, now }: { inUse: RatesCurrentDto['inUse']; now: number }) {
  const { t } = useTranslation('fx');
  const queryClient = useQueryClient();
  const [raw, setRaw] = useState('');
  const [invalid, setInvalid] = useState(false);

  // Plan §4.3.4: every M3 mutation refreshes every query.
  const refresh = () => queryClient.invalidateQueries();
  const activate = useMutation({
    mutationFn: (input: ManualUsdInput) => call(setManualEndpoint, input),
    onSuccess: async () => {
      setRaw('');
      await refresh();
    },
  });
  const clear = useMutation({
    mutationFn: () => call(clearManualEndpoint, undefined),
    onSuccess: refresh,
  });
  const pending = activate.isPending || clear.isPending;
  const error = activate.error ?? clear.error;
  const manual = inUse.kind === 'manual';

  return (
    <section aria-labelledby="fx-manual" className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 id="fx-manual" className="text-lg font-semibold">
          {t('manual.title')}
        </h2>
        <p className="text-sm text-muted-foreground">{t('manual.hint')}</p>
      </div>
      <ManualValueBanner inUse={inUse} now={now} />
      <form
        noValidate
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          const input = toManualInput(raw);
          setInvalid(input === null);
          if (input !== null) activate.mutate(input);
        }}
      >
        <div className="flex flex-col gap-2">
          <Label htmlFor="fx-manual-value">{t('manual.label')}</Label>
          <Input
            id="fx-manual-value"
            inputMode="decimal"
            autoComplete="off"
            className="h-11 tabular-nums"
            value={raw}
            aria-invalid={invalid}
            aria-describedby={invalid ? 'fx-manual-error' : undefined}
            onChange={(event) => {
              setRaw(event.target.value);
            }}
          />
          {invalid && (
            <p id="fx-manual-error" className="text-sm text-destructive">
              {t('manual.errors.value')}
            </p>
          )}
        </div>
        {error !== null && (
          <p role="alert" className="text-sm text-destructive">
            {messageForError(error instanceof ApiError ? error : { code: '' })}
          </p>
        )}
        <Button type="submit" className="h-11" disabled={pending}>
          {activate.isPending ? t('manual.submitting') : t('manual.submit')}
        </Button>
        {manual && (
          <Button
            type="button"
            variant="outline"
            className="h-11"
            disabled={pending}
            onClick={() => {
              clear.mutate();
            }}
          >
            {clear.isPending ? t('manual.clearing') : t('manual.clear')}
          </Button>
        )}
      </form>
    </section>
  );
}
