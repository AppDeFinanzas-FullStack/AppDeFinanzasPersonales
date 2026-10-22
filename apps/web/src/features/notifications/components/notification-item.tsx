import type { NotificationDto } from '@finanzas/contracts';
import { BOLIVIA_TIME_ZONE, todayFor } from '@finanzas/domain';
import { MoreHorizontal } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useMe } from '@/features/auth/hooks/use-me';
import { useFormatters } from '@/features/settings/hooks/use-settings';
import { cn } from '@/lib/utils';

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

  return (
    <li className="flex items-start gap-2 border-b border-border py-2 last:border-b-0">
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
    </li>
  );
}
