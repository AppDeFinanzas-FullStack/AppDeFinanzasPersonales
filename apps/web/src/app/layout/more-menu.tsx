import { isReleased } from '@finanzas/contracts';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import { useMe } from '@/features/auth/hooks/use-me';

import { SECTION_ITEMS, SECTION_ORDER } from './nav-items';

/** The "More" screen: sections without released modules are hidden (RF-M2-12). */
export function MoreMenu() {
  const { t } = useTranslation('navigation');
  const me = useMe();
  const release = me.data?.release;
  if (release === undefined) return null;

  return (
    <div className="space-y-6">
      {SECTION_ORDER.map((section) => {
        const items = SECTION_ITEMS[section].filter((item) => isReleased(item.moduleKey, release));
        if (items.length === 0) return null;
        return (
          <section key={section} aria-labelledby={`more-${section}`}>
            <h2 id={`more-${section}`} className="pb-1 text-sm text-muted-foreground">
              {t(`sections.${section}`)}
            </h2>
            <ul className="divide-y divide-border border-y border-border">
              {items.map(({ key, path, icon: Icon }) => (
                <li key={key}>
                  <Link
                    to={path}
                    className="flex min-h-11 items-center gap-3 text-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <Icon aria-hidden="true" className="size-5 shrink-0" />
                    <span>{t(`items.${key}`)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
