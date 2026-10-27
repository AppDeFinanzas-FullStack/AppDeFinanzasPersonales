import { DateFormat, NumberFormat, Theme, WeekStart, type SettingsDto } from '@finanzas/contracts';
import { useTranslation } from 'react-i18next';

import { useSettings } from '../hooks/use-settings';
import { useAutosaveSettings, type GeneralSettingsPatch } from '../hooks/use-update-settings';

import { ResetSectionButton } from './reset-section-button';

type GeneralKey = keyof GeneralSettingsPatch;

const OPTIONS: { [K in GeneralKey]: readonly SettingsDto[K][] } = {
  numberFormat: NumberFormat.options,
  dateFormat: DateFormat.options,
  weekStart: WeekStart.options,
  theme: Theme.options,
};

const KEYS: readonly GeneralKey[] = ['numberFormat', 'dateFormat', 'weekStart', 'theme'];

/** `/ajustes/general`: formats, first day of the week and theme, saved on change (plan §4.9.4). */
export function GeneralSettings() {
  const { t } = useTranslation('settings');
  const settings = useSettings();
  const { change, unsaved, isError } = useAutosaveSettings();

  if (settings.isError && settings.data === undefined) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {t('general.loadError')}
      </p>
    );
  }
  if (settings.data === undefined) return null;
  const data = { ...settings.data, ...unsaved };

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">{t('sections.general.title')}</h1>
        <p className="text-sm text-muted-foreground">{t('general.autosave')}</p>
      </div>
      {isError && (
        <p role="alert" className="text-sm text-destructive">
          {t('general.saveError')}
        </p>
      )}
      {KEYS.map((key) => (
        <fieldset key={key} className="flex flex-col gap-2">
          <legend className="pb-2 text-base font-medium">{t(`general.${key}.label`)}</legend>
          {OPTIONS[key].map((option) => (
            <label key={option} className="flex min-h-11 items-center gap-3">
              <input
                type="radio"
                name={`settings-${key}`}
                value={option}
                checked={data[key] === option}
                className="h-4 w-4 accent-[hsl(var(--primary))]"
                onChange={() => {
                  change({ [key]: option });
                }}
              />
              <span className={key === 'numberFormat' ? 'tabular-nums' : undefined}>
                {t(`general.${key}.options.${option}`)}
              </span>
            </label>
          ))}
        </fieldset>
      ))}
      <ResetSectionButton section="general" />
    </div>
  );
}
