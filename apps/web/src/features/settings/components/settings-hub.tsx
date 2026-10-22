import { ChevronRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

/** V1.0 sections of Ajustes; Recordatorios arrives with M15 in V1.2 (spec §2.9.1). */
const SECTIONS = [
  { key: 'general', path: '/ajustes/general' },
  { key: 'currencies', path: '/ajustes/monedas' },
  { key: 'register', path: '/ajustes/registrar' },
  { key: 'dashboard', path: '/ajustes/inicio' },
] as const;

/** `/ajustes`: the list of sections (plan §4.9.4). */
export function SettingsHub() {
  const { t } = useTranslation('settings');
  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold">{t('title')}</h1>
      <ul className="divide-y divide-border border-y border-border">
        {SECTIONS.map(({ key, path }) => (
          <li key={key}>
            <Link
              to={path}
              className="flex min-h-11 items-center gap-3 py-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span className="flex flex-1 flex-col">
                <span className="text-base">{t(`sections.${key}.title`)}</span>
                <span className="text-sm text-muted-foreground">
                  {t(`sections.${key}.description`)}
                </span>
              </span>
              <ChevronRight aria-hidden="true" className="size-5 shrink-0 text-muted-foreground" />
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
