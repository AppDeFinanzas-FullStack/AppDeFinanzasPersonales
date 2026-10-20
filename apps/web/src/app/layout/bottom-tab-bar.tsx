import type { ModuleKey } from '@finanzas/contracts';
import { useEffect, useRef, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useLocation } from 'react-router';

import { uiStore, useUiStore } from '@/lib/ui-store';
import { cn } from '@/lib/utils';

import { ALL_ITEMS, TAB_ITEMS, type NavItem } from './nav-items';

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

const MORE_ROOT = '/mas';
const MORE_KEY: ModuleKey = 'M2';
const TAB_KEYS = new Set(TAB_ITEMS.map((item) => item.key));

let pendingScroll: { url: string; scrollY: number } | null = null;

function matchesPath(pathname: string, path: string): boolean {
  return path === '/' ? pathname === '/' : pathname === path || pathname.startsWith(`${path}/`);
}

function itemFor(pathname: string): NavItem | undefined {
  return ALL_ITEMS.find((item) => matchesPath(pathname, item.path));
}

/** Modules whose memory the current location feeds; "More" remembers what was opened from it. */
function ownersOf(pathname: string): ModuleKey[] {
  const item = itemFor(pathname);
  if (!item || item.key === 'more') return [];
  return TAB_KEYS.has(item.key) ? [item.moduleKey] : [item.moduleKey, MORE_KEY];
}

/** Saves the URL and scroll of the module being left (RF-M2-04). Mount it once. */
function useTabMemoryTracker(): void {
  const { pathname, search } = useLocation();
  const scrollRef = useRef(0);

  useEffect(() => {
    const url = `${pathname}${search}`;
    const owners = ownersOf(pathname);
    scrollRef.current = window.scrollY;
    const pending = pendingScroll;
    pendingScroll = null;
    if (pending !== null && pending.url === url) {
      const target = pending.scrollY;
      requestAnimationFrame(() => {
        window.scrollTo(0, target);
        scrollRef.current = window.scrollY;
      });
    }
    const onScroll = () => {
      scrollRef.current = window.scrollY;
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      window.removeEventListener('scroll', onScroll);
      for (const owner of owners) uiStore.setTabMemory(owner, { url, scrollY: scrollRef.current });
    };
  }, [pathname, search]);
}

/** Destination and state of a navigation entry: the active one goes to its root (RF-M2-05). */
export function useTabLink(item: NavItem): { to: string; active: boolean; onClick: () => void } {
  const { pathname, search } = useLocation();
  const memory = useUiStore((state) => state.tabMemory);
  const isMore = item.key === 'more';
  const active = isMore
    ? pathname === MORE_ROOT || ownersOf(pathname).includes(MORE_KEY)
    : matchesPath(pathname, item.path);
  const root = isMore ? MORE_ROOT : item.path;
  const entry = memory[item.moduleKey];
  const to = active ? root : (entry?.url ?? item.path);
  const scrollTarget = active ? 0 : (entry?.scrollY ?? 0);
  return {
    to,
    active,
    onClick: () => {
      if (to === `${pathname}${search}`) {
        pendingScroll = null;
        window.scrollTo(0, scrollTarget);
      } else {
        pendingScroll = { url: to, scrollY: scrollTarget };
      }
    },
  };
}

function TabLink({ item }: { item: NavItem }) {
  const { t } = useTranslation('navigation');
  const { to, active, onClick } = useTabLink(item);
  const Icon = item.icon;
  return (
    <Link
      to={to}
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'flex min-h-14 flex-col items-center justify-center gap-1 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        active ? 'font-semibold text-primary' : 'text-foreground',
      )}
    >
      <Icon aria-hidden="true" className="size-5" />
      <span>{t(`items.${item.key}`)}</span>
    </Link>
  );
}

/** Always mounted, hidden from lg up (EC-M2-03). "More" never exists in the desktop format (RF-M2-02). */
export function BottomTabBar() {
  const { t } = useTranslation('navigation');
  const isDesktop = useIsDesktop();
  useTabMemoryTracker();
  const items = isDesktop ? TAB_ITEMS.filter((item) => item.key !== 'more') : TAB_ITEMS;
  return (
    <nav
      aria-label={t('primaryLabel')}
      className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-background lg:hidden"
    >
      <ul className="flex">
        {items.map((item) => (
          <li key={item.key} className="flex-1">
            <TabLink item={item} />
          </li>
        ))}
      </ul>
    </nav>
  );
}
