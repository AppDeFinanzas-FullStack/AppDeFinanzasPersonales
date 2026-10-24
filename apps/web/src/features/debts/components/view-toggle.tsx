import { useTranslation } from 'react-i18next';

import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';

import type { DebtsView } from '../api';

/** The list by debt or by person (RF-M13-13). */
export function ViewToggle({
  value,
  onChange,
}: {
  value: DebtsView;
  onChange: (view: DebtsView) => void;
}) {
  const { t } = useTranslation('debts');
  return (
    <Tabs
      value={value}
      onValueChange={(next) => {
        onChange(next === 'person' ? 'person' : 'debt');
      }}
    >
      <TabsList aria-label={t('view.label')} className="h-11">
        <TabsTrigger value="debt" className="h-9">
          {t('view.debt')}
        </TabsTrigger>
        <TabsTrigger value="person" className="h-9">
          {t('view.person')}
        </TabsTrigger>
      </TabsList>
    </Tabs>
  );
}
