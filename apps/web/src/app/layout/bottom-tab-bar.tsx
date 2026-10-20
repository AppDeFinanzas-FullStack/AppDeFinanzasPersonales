import { useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { NavLink } from 'react-router';

import { cn } from '@/lib/utils';

import { TAB_ITEMS } from './nav-items';

const DESKTOP_QUERY = '(min-width: 1024px)';

function subscribe(listener: () => void): () => void {
  const media = window.matchMedia(DESKTOP_QUERY);
  media.addEventListener('change', listener);
  return () => media.removeEventListener('change', listener);
}

function useIsDesktop(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(DESKTOP_QUERY).matches,
    () => false,
  );
}

/** Always mounted, hidden from lg up (EC-M2-03). "More" never exists in the desktop format (RF-M2-02). */
export function BottomTabBar() {
  const { t } = useTranslation('navigation');
  const isDesktop = useIsDesktop();
  const items = isDesktop ? TAB_ITEMS.filter((item) => item.key !== 'more') : TAB_ITEMS;
  return (
    <nav
      aria-label={t('primaryLabel')}
      className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-background lg:hidden"
    >
      <ul className="flex">
        {items.map(({ key, path, icon: Icon, end }) => (
          <li key={key} className="flex-1">
            <NavLink
              to={path}
              end={end}
              className={({ isActive }) =>
                cn(
                  'flex min-h-14 flex-col items-center justify-center gap-1 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  isActive ? 'font-semibold text-primary' : 'text-foreground',
                )
              }
            >
              <Icon aria-hidden="true" className="size-5" />
              <span>{t(`items.${key}`)}</span>
            </NavLink>
          </li>
        ))}
      </ul>
    </nav>
  );
}
