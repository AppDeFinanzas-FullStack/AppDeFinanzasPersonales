import { useTranslation } from 'react-i18next';
import { useLocation } from 'react-router';

import { BrandMark } from '@/components/brand-mark';
import { RateChip } from '@/features/fx/components/rate-chip';
import { BellButton } from '@/features/notifications/components/bell-button';

import { useIsDesktop } from '@/lib/use-is-desktop';

import { BackButton } from './back-button';
import { ALL_ITEMS } from './nav-items';
import { parentOf } from './route-parents';

function titleKeyFor(pathname: string): string | undefined {
  const match = ALL_ITEMS.find((item) =>
    item.path === '/' ? pathname === '/' : pathname === item.path || pathname.startsWith(`${item.path}/`),
  );
  return match?.key;
}

export function Header() {
  const { t } = useTranslation('navigation');
  const { pathname } = useLocation();
  const isDesktop = useIsDesktop();
  const key = titleKeyFor(pathname);
  const parent = parentOf(pathname, { desktop: isDesktop });
  return (
    <header className="flex h-14 items-center justify-between border-b border-border px-4">
      <div className="flex min-w-0 items-center gap-2">
        {parent !== null && <BackButton parent={parent} />}
        <BrandMark size="header" className="shrink-0" />
        <h1 className="truncate text-2xl font-semibold">{key ? t(`items.${key}`) : ''}</h1>
      </div>
      <div className="flex items-center gap-1">
        <RateChip />
        <BellButton />
      </div>
    </header>
  );
}
