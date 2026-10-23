import { useTranslation } from 'react-i18next';

import { i18n, LANGUAGE } from '@/app/providers/i18n';
import recurring from '@/locales/es-BO/recurring.json';

import { PendingList } from './components/pending-list';
import { RulesList } from './components/rules-list';
import { Upcoming30 } from './components/upcoming-30';
import { useRecurring } from './hooks/use-recurring';

// The feature registers its own namespace (RNF-07).
i18n.addResourceBundle(LANGUAGE, 'recurring', recurring, true, true);

/** `/recurrentes` (plan §4.14.4). */
export function RecurringPage() {
  const { t } = useTranslation('recurring');
  const query = useRecurring();
  if (query.isError && query.data === undefined) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {t('loadError')}
      </p>
    );
  }
  if (query.data === undefined) return null;
  const { rules, pending, upcoming30 } = query.data;
  return (
    <div className="flex flex-col gap-8">
      <h2 className="text-2xl font-semibold">{t('title')}</h2>
      <PendingList pending={pending} rules={rules} />
      <RulesList rules={rules} />
      <Upcoming30 upcoming={upcoming30} rules={rules} />
    </div>
  );
}
