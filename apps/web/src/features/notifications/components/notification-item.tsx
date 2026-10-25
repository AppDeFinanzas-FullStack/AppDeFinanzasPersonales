import type { NotificationDto } from '@finanzas/contracts';
import { BOLIVIA_TIME_ZONE, todayFor } from '@finanzas/domain';
import { useQueryClient } from '@tanstack/react-query';
import { MoreHorizontal } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { uuidv7 } from 'uuidv7';

import { i18n, LANGUAGE } from '@/app/providers/i18n';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useMe } from '@/features/auth/hooks/use-me';
import { CloseDecisionNotice } from '@/features/budgets/components/close-decision-card';
import { ConfirmPendingDialog } from '@/features/recurring/components/confirm-pending-dialog';
import {
  useConfirmOccurrence,
  useRecurring,
  useSkipOccurrence,
} from '@/features/recurring/hooks/use-recurring';
import { useFormatters } from '@/features/settings/hooks/use-settings';
import { ApiError } from '@/lib/api-client';
import { messageForError } from '@/lib/i18n-errors';
import { cn } from '@/lib/utils';
import recurringMessages from '@/locales/es-BO/recurring.json';

import { NOTIFICATIONS_KEY } from '../hooks/use-notifications';

// The inbox decides pending occurrences outside Recurrentes, so it brings their texts along.
i18n.addResourceBundle(LANGUAGE, 'recurring', recurringMessages, true, true);

/**
 * Confirmar and Omitir of a pending occurrence, with the same endpoints as Recurrentes (plan §4.15.4,
 * EC-M15-01). An occurrence with its amount is confirmed as scheduled; one without amount, or one the
 * server rejects (an archived account or category), opens the same dialog as Recurrentes to adjust
 * it. Once decided, the inbox refreshes and the notice shows as resolved.
 */
function PendingDecision({ occurrenceId }: { occurrenceId: string }) {
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

/**
 * One notification of the inbox (plan §4.15.4): its i18n text with its parameters, a tap that opens
 * it and a "…" menu with Eliminar, the keyboard alternative to swiping (RNF-06).
 */
export function NotificationItem({
  notification,
  onOpen,
  onRemove,
}: {
  notification: NotificationDto;
  onOpen: (notification: NotificationDto) => void;
  onRemove: (id: string) => void;
}) {
  const { t } = useTranslation('notifications');
  const me = useMe();
  const formatters = useFormatters();
  const timezone = me.data?.timezone ?? BOLIVIA_TIME_ZONE;
  const now = new Date();
  // The day it arrived, in the user's timezone (RN-07).
  const day = formatters.relativeDay(
    todayFor(timezone, new Date(notification.createdAt)),
    todayFor(timezone, now),
  );
  const unread = !notification.read;
  const { decision } = notification;
  const budgetId = notification.params['budgetId'];
  // The close of a period is decided right here, with the same endpoint as the budget (RF-M15-03).
  const closeDecision =
    notification.type === 'period_close' &&
    decision?.kind === 'budget_period' &&
    decision.status !== 'resolved' &&
    typeof budgetId === 'string'
      ? { budgetId, periodId: decision.ref }
      : undefined;
  const pendingId =
    notification.type === 'recurring_pending' &&
    decision?.kind === 'occurrence' &&
    decision.status !== 'resolved'
      ? decision.ref
      : undefined;

  return (
    <li className="flex flex-col gap-2 border-b border-border py-2 last:border-b-0">
      <div className="flex items-start gap-2">
        <button
          type="button"
          onClick={() => {
            onOpen(notification);
          }}
          className="flex min-h-11 min-w-0 flex-1 flex-col items-start gap-1 rounded-md px-2 py-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span className={cn('text-base', unread && 'font-semibold')}>
            {t(`types.${notification.type}`, { replace: notification.params })}
          </span>
          <span className="flex items-center gap-2 text-sm text-muted-foreground">
            <span>{day}</span>
            {unread ? (
              <span className="rounded-[calc(var(--radius)-2px)] border border-border px-1.5 text-foreground">
                {t('item.unread')}
              </span>
            ) : null}
          </span>
        </button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-11 shrink-0"
              aria-label={t('item.more')}
            >
              <MoreHorizontal aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              className="min-h-11 text-base"
              onSelect={() => {
                onRemove(notification.id);
              }}
            >
              {t('item.remove')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {closeDecision !== undefined && (
        <div className="px-2">
          <CloseDecisionNotice
            budgetId={closeDecision.budgetId}
            periodId={closeDecision.periodId}
          />
        </div>
      )}
      {pendingId !== undefined && (
        <div className="px-2">
          <PendingDecision occurrenceId={pendingId} />
        </div>
      )}
    </li>
  );
}
