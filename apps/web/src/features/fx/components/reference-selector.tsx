import { FxSettingsInput, UsdReference, type RatesCurrentDto } from '@finanzas/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';

import { Label } from '@/components/ui/label';
import { ApiError, call, type Endpoint } from '@/lib/api-client';
import { messageForError } from '@/lib/i18n-errors';

const updateFxSettingsEndpoint: Endpoint<FxSettingsInput, void> = {
  method: 'PATCH',
  path: '/api/fx-settings',
  input: FxSettingsInput,
  output: z.void(),
};

/** The USD reference used to convert balances and totals (RF-M3-03, RF-M3-11). */
export function ReferenceSelector({ inUse }: { inUse: RatesCurrentDto['inUse'] }) {
  const { t } = useTranslation('fx');
  const queryClient = useQueryClient();
  const update = useMutation({
    mutationFn: (usdReference: UsdReference) => call(updateFxSettingsEndpoint, { usdReference }),
    // Plan §4.3.4: every M3 mutation refreshes every query.
    onSuccess: () => queryClient.invalidateQueries(),
  });
  const manual = inUse.kind === 'manual';
  const selected = update.isPending ? update.variables : manual ? '' : inUse.kind;

  return (
    <section aria-labelledby="fx-reference" className="flex flex-col gap-4">
      <h2 id="fx-reference" className="text-lg font-semibold">
        {t('reference.title')}
      </h2>
      <div className="flex flex-col gap-2">
        <Label htmlFor="fx-reference-select">{t('reference.label')}</Label>
        <select
          id="fx-reference-select"
          className="flex h-11 w-full rounded-md border border-input bg-background px-3 py-2 text-base ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:opacity-50 md:text-sm"
          value={selected}
          disabled={update.isPending}
          aria-describedby="fx-reference-hint"
          onChange={(event) => {
            const parsed = UsdReference.safeParse(event.target.value);
            if (parsed.success) update.mutate(parsed.data);
          }}
        >
          {manual && (
            <option value="" disabled>
              {t('reference.placeholder')}
            </option>
          )}
          {UsdReference.options.map((kind) => (
            <option key={kind} value={kind}>
              {t(`kinds.${kind}`)}
            </option>
          ))}
        </select>
        <p id="fx-reference-hint" className="text-sm text-muted-foreground">
          {manual ? t('reference.manualHint') : t('reference.hint')}
        </p>
      </div>
      {update.isError && (
        <p role="alert" className="text-sm text-destructive">
          {messageForError(update.error instanceof ApiError ? update.error : { code: '' })}
        </p>
      )}
    </section>
  );
}
