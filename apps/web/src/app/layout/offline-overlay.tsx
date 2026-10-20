import { WifiOff } from 'lucide-react';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';

import { online } from '@/lib/online';
import { useUiStore } from '@/lib/ui-store';

/** Turns the browser `offline` event into the app's offline state (plan §4.2.3). */
function useOfflineEvent(): void {
  useEffect(() => {
    const onOffline = () => {
      online.setOffline();
    };
    if (!navigator.onLine) onOffline();
    window.addEventListener('offline', onOffline);
    return () => {
      window.removeEventListener('offline', onOffline);
    };
  }, []);
}

/** Covers the whole app while offline without unmounting it; it goes away on its own (RF-M2-07, RNF-23). */
export function OfflineOverlay() {
  const { t } = useTranslation('navigation');
  const offline = useUiStore((state) => state.offline);
  useOfflineEvent();
  if (!offline) return null;
  return (
    <div
      role="alert"
      aria-labelledby="offline-title"
      aria-describedby="offline-description"
      className="fixed inset-0 z-[60] flex items-center justify-center bg-background px-4"
    >
      <div className="flex max-w-sm flex-col items-center gap-3 text-center">
        <WifiOff aria-hidden="true" className="size-8 text-muted-foreground" />
        <h2 id="offline-title" className="text-2xl font-semibold">
          {t('offline.title')}
        </h2>
        <p id="offline-description" className="text-base text-muted-foreground">
          {t('offline.description')}
        </p>
      </div>
    </div>
  );
}
