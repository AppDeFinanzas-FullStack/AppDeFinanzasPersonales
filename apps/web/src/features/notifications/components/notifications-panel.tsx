import type { NotificationDto } from '@finanzas/contracts';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';

import { Button } from '@/components/ui/button';
import { SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';

import {
  useMarkAllRead,
  useMarkRead,
  useNotifications,
  useRemoveNotification,
} from '../hooks/use-notifications';

import { NotificationItem } from './notification-item';

/** Only routes of the app itself: a target never leaves the site. */
const isAppRoute = (route: string) => route.startsWith('/') && !route.startsWith('//');

/**
 * The inbox (plan §4.15.4), a Sheet opened from the bell. Tapping a notification marks it as read
 * and opens its screen, which shows "Esto ya no existe" when its target is gone (RF-M15-11).
 * "Marcar todo como leído" and Eliminar also apply to the ones waiting for a decision (RF-M15-12).
 */
export function NotificationsPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation('notifications');
  const navigate = useNavigate();
  const list = useNotifications(open);
  const markRead = useMarkRead();
  const markAllRead = useMarkAllRead();
  const remove = useRemoveNotification();
  const items = list.data?.pages.flatMap((page) => page.items) ?? [];

  const openNotification = (notification: NotificationDto) => {
    if (!notification.read) markRead.mutate(notification.id);
    onClose();
    if (isAppRoute(notification.targetRoute)) void navigate(notification.targetRoute);
  };

  return (
    <SheetContent
      closeLabel={t('panel.close')}
      className="flex w-full flex-col gap-4 overflow-y-auto sm:max-w-md"
    >
      <SheetHeader className="pr-8">
        <SheetTitle className="text-2xl font-semibold">{t('panel.title')}</SheetTitle>
        <SheetDescription>{t('panel.description')}</SheetDescription>
      </SheetHeader>
      {items.length > 0 ? (
        <div className="flex justify-end">
          <Button
            type="button"
            variant="ghost"
            className="min-h-11"
            disabled={markAllRead.isPending}
            onClick={() => {
              markAllRead.mutate();
            }}
          >
            {t('panel.markAllRead')}
          </Button>
        </div>
      ) : null}
      {list.isError ? (
        <p className="text-base">{t('panel.loadError')}</p>
      ) : list.isSuccess && items.length === 0 ? (
        <p className="text-base text-muted-foreground">{t('panel.empty')}</p>
      ) : (
        <ul className="flex flex-col">
          {items.map((notification) => (
            <NotificationItem
              key={notification.id}
              notification={notification}
              onOpen={openNotification}
              onRemove={(id) => {
                remove.mutate(id);
              }}
            />
          ))}
        </ul>
      )}
      {list.hasNextPage ? (
        <Button
          type="button"
          variant="outline"
          className="min-h-11"
          disabled={list.isFetchingNextPage}
          onClick={() => {
            void list.fetchNextPage();
          }}
        >
          {t('panel.loadMore')}
        </Button>
      ) : null}
    </SheetContent>
  );
}
