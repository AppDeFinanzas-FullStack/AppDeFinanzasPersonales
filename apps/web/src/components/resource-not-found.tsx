import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

/**
 * What a detail screen shows when its resource no longer exists, e.g. the target of a notification
 * that was deleted (RF-M15-11, plan §4.15.3): "Esto ya no existe" and a way back to Inicio.
 */
export function ResourceNotFound() {
  const { t } = useTranslation(['errors', 'navigation']);
  return (
    <section className="flex flex-col items-start gap-4 py-8">
      <h2 className="text-2xl font-semibold">{t('NOT_FOUND', { ns: 'errors' })}</h2>
      <Link
        to="/"
        className="inline-flex min-h-11 items-center rounded-md text-base font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {t('items.home', { ns: 'navigation' })}
      </Link>
    </section>
  );
}
