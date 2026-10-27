import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { uuidv7 } from 'uuidv7';

import { i18n, LANGUAGE } from '@/app/providers/i18n';
import { Button } from '@/components/ui/button';
import { ConfirmPendingDialog } from '@/features/recurring/components/confirm-pending-dialog';
import {
  useConfirmOccurrence,
  useRecurring,
  useSkipOccurrence,
} from '@/features/recurring/hooks/use-recurring';
import { ApiError } from '@/lib/api-client';
import { messageForError } from '@/lib/i18n-errors';
import recurringMessages from '@/locales/es-BO/recurring.json';

import { NOTIFICATIONS_KEY } from '../hooks/use-notifications';

// The inbox decides pending occurrences outside Recurrentes, so it brings their texts along.
i18n.addResourceBundle(LANGUAGE, 'recurring', recurringMessages, true, true);

/**
 * Confirmar and Omitir of a pending occurrence, with the same endpoints as Recurrentes (plan §4.15.4,
 * EC-M15-01). An occurrence with its amount is confirmed as scheduled; one without amount, or one the
 * server rejects (an archived account or category), opens the same dialog as Recurrentes to adjust
 * it. Once decided, the inbox refreshes and the notice shows as resolved.
 *
 * Loaded on demand by the inbox item, so Recurrentes stays out of the app shell (RNF-01).
 */
export function PendingDecision({ occurrenceId }: { occurrenceId: string }) {
  const { t } = useTranslation('recurring');
  const queryClient = useQueryClient();
  const recurring = useRecurring();
  const skip = useSkipOccurrence();
  const confirm = useConfirmOccurrence(occurrenceId);
  const [transactionId] = useState(() => uuidv7());
  const [confirming, setConfirming] = useState(false);
  const occurrence = recurring.data?.pending.find((p) => p.transactionId === occurrenceId);
  const rule = recurring.data?.rules.find((r) => r.id === occurrence?.ruleId);
  const refresh = () => queryClient.invalidateQueries({ queryKey: NOTIFICATIONS_KEY });

  if (occurrence === undefined) return null;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex gap-2">
        <Button
          type="button"
          variant="outline"
          className="h-11"
          disabled={confirm.isPending}
          onClick={() => {
            if (occurrence.amount === undefined) {
              setConfirming(true);
              return;
            }
            confirm.mutate(
              { transactionId, date: occurrence.date },
              {
                onSuccess: () => void refresh(),
                onError: () => {
                  setConfirming(true);
                },
              },
            );
          }}
        >
          {t('pending.confirm')}
        </Button>
        <Button
          type="button"
          variant="ghost"
          className="h-11"
          disabled={skip.isPending}
          onClick={() => {
            skip.mutate(occurrenceId, { onSuccess: () => void refresh() });
          }}
        >
          {t('pending.skip')}
        </Button>
      </div>
      {skip.isError && (
        <p role="alert" className="text-sm text-destructive">
          {messageForError(skip.error instanceof ApiError ? skip.error : { code: '' })}
        </p>
      )}
      {confirming && (
        <ConfirmPendingDialog
          occurrence={occurrence}
          rule={rule}
          onClose={() => {
            setConfirming(false);
            void refresh();
          }}
        />
      )}
    </div>
  );
}
