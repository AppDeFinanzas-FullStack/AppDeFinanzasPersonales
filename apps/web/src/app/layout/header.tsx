import { useTranslation } from 'react-i18next';
import { useLocation } from 'react-router';

import { RateChip } from '@/features/fx/components/rate-chip';

import { ALL_ITEMS } from './nav-items';

function titleKeyFor(pathname: string): string | undefined {
  const match = ALL_ITEMS.find((item) =>
    item.path === '/' ? pathname === '/' : pathname === item.path || pathname.startsWith(`${item.path}/`),
  );
  return match?.key;
}

export function Header() {
  const { t } = useTranslation('navigation');
  const { pathname } = useLocation();
  const key = titleKeyFor(pathname);
  return (
    <header className="flex h-14 items-center justify-between border-b border-border px-4">
      <h1 className="text-2xl font-semibold">{key ? t(`items.${key}`) : ''}</h1>
      <RateChip />
    </header>
  );
}
