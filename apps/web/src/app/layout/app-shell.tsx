import { Outlet } from 'react-router';

import { i18n, LANGUAGE } from '@/app/providers/i18n';
import { useUiStore } from '@/lib/ui-store';
import navigation from '@/locales/es-BO/navigation.json';

import { BottomTabBar } from './bottom-tab-bar';
import { Header } from './header';
import { OfflineOverlay } from './offline-overlay';
import { SessionExpiredDialog } from './session-expired-dialog';
import { Sidebar } from './sidebar';

// The layout registers its own namespace (RNF-07).
i18n.addResourceBundle(LANGUAGE, 'navigation', navigation, true, true);

export function AppShell() {
  const offline = useUiStore((state) => state.offline);
  return (
    <>
      {/* Offline keeps the whole tree mounted but out of reach (RF-M2-07, RF-M2-10). */}
      <div className="flex min-h-screen bg-background text-foreground" inert={offline}>
        <Sidebar />
        <div className="flex min-w-0 flex-1 flex-col">
          <Header />
          <main className="mx-auto w-full max-w-3xl flex-1 px-4 pb-20 pt-4 lg:pb-4">
            <Outlet />
          </main>
        </div>
        <BottomTabBar />
      </div>
      <OfflineOverlay />
      <SessionExpiredDialog />
    </>
  );
}
