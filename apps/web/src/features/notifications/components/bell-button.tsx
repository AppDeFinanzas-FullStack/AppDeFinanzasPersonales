import { isReleased } from '@finanzas/contracts';
import { Bell } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { i18n, LANGUAGE } from '@/app/providers/i18n';
import { Button } from '@/components/ui/button';
import { Sheet, SheetTrigger } from '@/components/ui/sheet';
import { useMe } from '@/features/auth/hooks/use-me';
import notifications from '@/locales/es-BO/notifications.json';

import { useUnreadCount } from '../hooks/use-notifications';

import { NotificationsPanel } from './notifications-panel';

i18n.addResourceBundle(LANGUAGE, 'notifications', notifications, true, true);

const MAX_SHOWN = 99;

function BellTrigger() {
  const { t } = useTranslation('notifications');
  const [open, setOpen] = useState(false);
  const { data } = useUnreadCount();
  const count = data?.count ?? 0;
  const shown = count > MAX_SHOWN ? t('bell.overflow') : String(count);
  const label = count > 0 ? t('bell.labelUnread', { value: shown }) : t('bell.label');

  // Not modal, so the header (and its count) stays available while the inbox is open.
  return (
    <Sheet open={open} onOpenChange={setOpen} modal={false}>
      <SheetTrigger asChild>
        <Button type="button" variant="ghost" className="relative size-11 p-0" aria-label={label}>
          <Bell aria-hidden="true" className="size-5" />
          {count > 0 ? (
            <span className="absolute right-0 top-0 min-w-5 rounded-[calc(var(--radius)-2px)] bg-foreground px-1 text-sm font-semibold leading-5 text-background tabular-nums">
              {shown}
            </span>
          ) : null}
        </Button>
      </SheetTrigger>
      <NotificationsPanel
        open={open}
        onClose={() => {
          setOpen(false);
        }}
      />
    </Sheet>
  );
}

/** The bell of the header with the unread count (RF-M15-06), from the release of the inbox (M15). */
export function BellButton() {
  const me = useMe();
  if (me.data === undefined || !isReleased('M15', me.data.release)) return null;
  return <BellTrigger />;
}
