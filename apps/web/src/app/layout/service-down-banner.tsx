import { useQueryClient } from '@tanstack/react-query';
import { ServerOff } from 'lucide-react';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';

import { uiStore, useUiStore } from '@/lib/ui-store';

const READY_PATH = '/api/health/ready';
const RECHECK_MS = 15_000;

/** Asks the API whether the database answers again; 204 means yes. */
async function isReady(): Promise<boolean> {
  try {
    const response = await fetch(READY_PATH, { method: 'GET' });
    return response.status === 204;
  } catch {
    return false;
  }
}

/**
 * Notice that stays on top while the database is down (for example the Neon quota is used up), so
 * the screens do not just look empty. It checks again by itself and goes away when the service is
 * back, refreshing what the screens show. It does not block the app (unlike the offline overlay).
 */
export function ServiceDownBanner() {
  const { t } = useTranslation('common');
  const serviceDown = useUiStore((state) => state.serviceDown);
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!serviceDown) return;
    const timer = setInterval(() => {
      void isReady().then((ready) => {
        if (!ready) return;
        uiStore.setServiceDown(false);
        void queryClient.invalidateQueries();
      });
    }, RECHECK_MS);
    return () => {
      clearInterval(timer);
    };
  }, [serviceDown, queryClient]);

  if (!serviceDown) return null;
  return (
    <div
      role="alert"
      className="fixed inset-x-0 top-0 z-[55] flex items-start gap-3 border-b bg-amber-100 px-4 py-3 text-amber-950"
    >
      <ServerOff aria-hidden="true" className="mt-0.5 size-5 shrink-0" />
      <div>
        <p className="font-semibold">{t('serviceDown.title')}</p>
        <p className="text-sm">{t('serviceDown.description')}</p>
      </div>
    </div>
  );
}
