import { NotificationType, type PreferenceInput } from '@finanzas/contracts';
import { useTranslation } from 'react-i18next';

import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';

import {
  useNotificationPreferences,
  useUpdatePreference,
} from '../hooks/use-notification-preferences';
import { useSettings } from '../hooks/use-settings';

/** The values the API takes when a setting was never chosen (plan §4.15.1). */
const DEFAULT_HOUR = 21;
const DEFAULT_LEAD_DAYS = 1;

const HOURS = Array.from({ length: 24 }, (_, hour) => hour);
const LEAD_DAYS = Array.from({ length: 8 }, (_, days) => days);
const MONDAY_FIRST = [1, 2, 3, 4, 5, 6, 0];
const SUNDAY_FIRST = [0, 1, 2, 3, 4, 5, 6];

const SELECT_CLASS =
  'h-11 w-full rounded-md border border-input bg-background px-3 text-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

const hourLabel = (hour: number): string => `${String(hour).padStart(2, '0')}:00`;

interface RowProps {
  preference: PreferenceInput;
  weekdays: readonly number[];
  onChange: (change: PreferenceInput) => void;
}

/** One type: its switch and, while it is on, the settings that type uses (RF-M15-07). */
function PreferenceRow({ preference, weekdays, onChange }: RowProps) {
  const { t } = useTranslation('settings');
  const { type, enabled } = preference;
  const id = `preference-${type}`;
  const chosenDays = preference.weekdays ?? SUNDAY_FIRST;

  return (
    <li className="flex flex-col gap-4 py-4">
      <div className="flex min-h-11 items-center gap-4">
        <div className="flex flex-1 flex-col gap-1">
          <Label htmlFor={id} className="text-base font-normal leading-normal">
            {t(`reminders.types.${type}.title`)}
          </Label>
          <p id={`${id}-description`} className="text-sm text-muted-foreground">
            {t(`reminders.types.${type}.description`)}
          </p>
        </div>
        <Switch
          id={id}
          checked={enabled}
          aria-describedby={`${id}-description`}
          onCheckedChange={(checked) => {
            onChange({ type, enabled: checked });
          }}
        />
      </div>

      {enabled && type === 'payment_upcoming' && (
        <div className="flex flex-col gap-2">
          <Label htmlFor={`${id}-lead`} className="text-base">
            {t('reminders.leadDays.label')}
          </Label>
          <select
            id={`${id}-lead`}
            className={SELECT_CLASS}
            value={preference.leadDays ?? DEFAULT_LEAD_DAYS}
            onChange={(event) => {
              onChange({ type, enabled, leadDays: Number(event.target.value) });
            }}
          >
            {LEAD_DAYS.map((days) => (
              <option key={days} value={days}>
                {days === 0
                  ? t('reminders.leadDays.sameDay')
                  : t('reminders.leadDays.option', { count: days })}
              </option>
            ))}
          </select>
        </div>
      )}

      {enabled && type === 'log_day' && (
        <>
          <div className="flex flex-col gap-2">
            <Label htmlFor={`${id}-hour`} className="text-base">
              {t('reminders.hour.label')}
            </Label>
            <select
              id={`${id}-hour`}
              className={`${SELECT_CLASS} tabular-nums`}
              value={preference.hour ?? DEFAULT_HOUR}
              onChange={(event) => {
                onChange({ type, enabled, hour: Number(event.target.value) });
              }}
            >
              {HOURS.map((hour) => (
                <option key={hour} value={hour}>
                  {hourLabel(hour)}
                </option>
              ))}
            </select>
          </div>
          <fieldset className="flex flex-col gap-1">
            <legend className="pb-2 text-base font-medium">{t('reminders.weekdays.label')}</legend>
            {weekdays.map((day) => (
              <label key={day} className="flex min-h-11 items-center gap-3">
                <input
                  type="checkbox"
                  className="h-4 w-4 accent-[hsl(var(--primary))]"
                  checked={chosenDays.includes(day)}
                  onChange={(event) => {
                    const next = event.target.checked
                      ? SUNDAY_FIRST.filter((d) => d === day || chosenDays.includes(d))
                      : chosenDays.filter((d) => d !== day);
                    onChange({ type, enabled, weekdays: next });
                  }}
                />
                <span>{t(`reminders.weekdays.days.${day}`)}</span>
              </label>
            ))}
          </fieldset>
        </>
      )}
    </li>
  );
}

/** `/ajustes/recordatorios` (V1.2): one switch per type, saved at once (plan §4.15.4). */
export function PreferencesList() {
  const { t } = useTranslation('settings');
  const preferences = useNotificationPreferences();
  const settings = useSettings();
  const update = useUpdatePreference();

  if (preferences.isError && preferences.data === undefined) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {t('reminders.loadError')}
      </p>
    );
  }
  if (preferences.data === undefined) return null;

  const byType = new Map(preferences.data.map((preference) => [preference.type, preference]));
  const weekdays = settings.data?.weekStart === 'sunday' ? SUNDAY_FIRST : MONDAY_FIRST;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">{t('sections.reminders.title')}</h1>
        <p className="text-sm text-muted-foreground">{t('reminders.autosave')}</p>
      </div>
      {update.isError && (
        <p role="alert" className="text-sm text-destructive">
          {t('reminders.saveError')}
        </p>
      )}
      <ul className="divide-y divide-border border-y border-border">
        {NotificationType.options.map((type) => {
          const preference = byType.get(type);
          if (preference === undefined) return null;
          return (
            <PreferenceRow
              key={type}
              preference={preference}
              weekdays={weekdays}
              onChange={(change) => {
                update.mutate(change);
              }}
            />
          );
        })}
      </ul>
    </div>
  );
}
