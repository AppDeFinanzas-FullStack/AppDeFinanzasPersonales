import type { OccurrenceDto, RuleDto } from '@finanzas/contracts';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { useFormatters } from '@/features/settings/hooks/use-settings';
import { ApiError } from '@/lib/api-client';
import { messageForError } from '@/lib/i18n-errors';

import { useSkipOccurrence } from '../hooks/use-recurring';

import { ConfirmPendingDialog } from './confirm-pending-dialog';
import { useRuleAmount } from './rules-list';

/** "Pendientes de confirmar", each with Confirmar and Omitir (RF-M14-13). */
export function PendingList({ pending, rules }: { pending: OccurrenceDto[]; rules: RuleDto[] }) {
  const { t } = useTranslation('recurring');
  const formatters = useFormatters();
  const amountOf = useRuleAmount();
  const skip = useSkipOccurrence();
  const [confirming, setConfirming] = useState<OccurrenceDto | null>(null);
  const ruleOf = (ruleId: string) => rules.find((rule) => rule.id === ruleId);

  return (
    <section className="flex flex-col gap-3" aria-labelledby="recurring-pending">
      <h3 id="recurring-pending" className="text-lg font-semibold">
        {t('pending.title')}
      </h3>
      {pending.length === 0 ? (
        <p className="text-muted-foreground">{t('pending.empty')}</p>
      ) : (
        <ul className="flex flex-col divide-y divide-border border-y border-border">
          {pending.map((item) => (
            <li key={item.transactionId} className="flex flex-col gap-2 py-3">
              <div className="flex items-baseline justify-between gap-4">
                <span className="flex flex-col">
                  <span className="font-medium">{item.ruleName}</span>
                  <span className="text-sm text-muted-foreground tabular-nums">
                    {formatters.date(item.date)}
                  </span>
                </span>
                <span className="text-right tabular-nums">
                  {amountOf(ruleOf(item.ruleId)?.kind ?? 'expense', item.amount, item.currency)}
                </span>
              </div>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  className="h-11"
                  onClick={() => {
                    setConfirming(item);
                  }}
                >
                  {t('pending.confirm')}
                </Button>
                <Button
                  variant="ghost"
                  className="h-11"
                  disabled={skip.isPending}
                  onClick={() => {
                    skip.mutate(item.transactionId);
                  }}
                >
                  {t('pending.skip')}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {skip.isError && (
        <p role="alert" className="text-sm text-destructive">
          {messageForError(skip.error instanceof ApiError ? skip.error : { code: '' })}
        </p>
      )}
      {confirming !== null && (
        <ConfirmPendingDialog
          key={confirming.transactionId}
          occurrence={confirming}
          rule={ruleOf(confirming.ruleId)}
          onClose={() => {
            setConfirming(null);
          }}
        />
      )}
    </section>
  );
}
