import { isReleased } from '@finanzas/contracts';
import { PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { useMe } from '@/features/auth/hooks/use-me';
import { useSettings, useUpdateSettings } from '@/features/settings/hooks/use-settings';
import { cn } from '@/lib/utils';

import { useTabLink } from './bottom-tab-bar';
import { MAIN_ITEMS, SECTION_ITEMS, SECTION_ORDER, type NavItem } from './nav-items';

function SidebarLink({ item, collapsed }: { item: NavItem; collapsed: boolean }) {
  const { t } = useTranslation('navigation');
  const label = t(`items.${item.key}`);
  const Icon = item.icon;
  const { to, active, onClick } = useTabLink(item);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Link
          to={to}
          onClick={onClick}
          aria-current={active ? 'page' : undefined}
          aria-label={collapsed ? label : undefined}
          className={cn(
            'flex min-h-11 items-center gap-3 rounded-md px-3 text-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            collapsed && 'justify-center',
            active ? 'font-semibold text-primary' : 'text-foreground',
          )}
        >
          <Icon aria-hidden="true" className="size-5 shrink-0" />
          {collapsed ? null : <span>{label}</span>}
        </Link>
      </TooltipTrigger>
      {collapsed ? <TooltipContent side="right">{label}</TooltipContent> : null}
    </Tooltip>
  );
}

/** Always mounted, shown from lg up; the collapsed state lives in the user's settings (RF-M2-09). */
export function Sidebar() {
  const { t } = useTranslation('navigation');
  const me = useMe();
  const settings = useSettings();
  const update = useUpdateSettings();
  const collapsed = settings.data?.sidebarCollapsed ?? false;
  const release = me.data?.release;

  const visible = (items: NavItem[]) =>
    release === undefined ? [] : items.filter((item) => isReleased(item.moduleKey, release));
  const toggleLabel = collapsed ? t('expand') : t('collapse');
  const ToggleIcon = collapsed ? PanelLeftOpen : PanelLeftClose;

  return (
    <TooltipProvider>
      <aside
        className={cn(
          'sticky top-0 hidden h-screen shrink-0 flex-col border-r border-border bg-background lg:flex',
          collapsed ? 'w-16' : 'w-64',
        )}
      >
        <nav aria-label={t('sidebarLabel')} className="flex-1 overflow-y-auto p-2">
          <ul className="space-y-1">
            {visible(MAIN_ITEMS).map((item) => (
              <li key={item.key}>
                <SidebarLink item={item} collapsed={collapsed} />
              </li>
            ))}
          </ul>
          {SECTION_ORDER.map((section) => {
            const items = visible(SECTION_ITEMS[section]);
            if (items.length === 0) return null;
            return (
              <div
                key={section}
                role="group"
                aria-label={t(`sections.${section}`)}
                data-label={collapsed ? undefined : t(`sections.${section}`)}
                className="mt-4 border-t border-border pt-4 data-[label]:before:block data-[label]:before:px-3 data-[label]:before:pb-1 data-[label]:before:text-sm data-[label]:before:text-muted-foreground data-[label]:before:content-[attr(data-label)]"
              >
                <ul className="space-y-1">
                  {items.map((item) => (
                    <li key={item.key}>
                      <SidebarLink item={item} collapsed={collapsed} />
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </nav>
        <div className="border-t border-border p-2">
          <button
            type="button"
            aria-label={toggleLabel}
            onClick={() => update.mutate({ sidebarCollapsed: !collapsed })}
            className="flex min-h-11 w-full items-center justify-center rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ToggleIcon aria-hidden="true" className="size-5" />
          </button>
        </div>
      </aside>
    </TooltipProvider>
  );
}
