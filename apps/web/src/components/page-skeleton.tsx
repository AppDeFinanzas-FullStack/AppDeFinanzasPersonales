import { useTranslation } from 'react-i18next';

import { i18n, LANGUAGE } from '@/app/providers/i18n';
import navigation from '@/locales/es-BO/navigation.json';

// The guards draw the skeleton before the app shell registers this namespace.
i18n.addResourceBundle(LANGUAGE, 'navigation', navigation, true, true);

/**
 * What a screen shows while its data arrives, instead of a blank page: neutral blocks announced
 * once as "Cargando". It rests when the user prefers reduced motion (RNF-06).
 */
export function PageSkeleton() {
  const { t } = useTranslation('navigation');
  return (
    <div role="status" aria-label={t('loading')} className="flex flex-col gap-6">
      <div
        aria-hidden="true"
        className="h-11 w-full rounded-md bg-muted motion-safe:animate-pulse"
      />
      <div
        aria-hidden="true"
        className="h-32 w-full rounded-md bg-muted motion-safe:animate-pulse"
      />
      <div
        aria-hidden="true"
        className="h-32 w-full rounded-md bg-muted motion-safe:animate-pulse"
      />
    </div>
  );
}
