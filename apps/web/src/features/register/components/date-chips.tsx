import { CalendarDays } from 'lucide-react';
import { useState } from 'react';
import { es } from 'react-day-picker/locale';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { Calendar } from '@/components/ui/calendar';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useFormatters } from '@/features/settings/hooks/use-settings';

/** The calendar day before 'YYYY-MM-DD'. */
export function dayBefore(date: string): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
}

/** 'YYYY-MM-DD' as a local date for the calendar, and back. */
const toDate = (date: string): Date => {
  const [year = 1970, month = 1, day = 1] = date.split('-').map(Number);
  return new Date(year, month - 1, day);
};
const toLocalDate = (date: Date): string =>
  [
    String(date.getFullYear()),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-');

interface DateChipsProps {
  value: string;
  /** The user's today: no future date is offered (RF-M7-05). */
  today: string;
  /** The first day of the week of the settings (RF-M9-04). */
  weekStart: 'monday' | 'sunday';
  onChange: (date: string) => void;
}

/** `<DateChips>`: "Hoy" (marked), "Ayer" and "Calendario", without future dates (RF-M7-05). */
export function DateChips({ value, today, weekStart, onChange }: DateChipsProps) {
  const { t } = useTranslation('register');
  const formatters = useFormatters();
  const [open, setOpen] = useState(false);
  const yesterday = dayBefore(today);
  const custom = value !== today && value !== yesterday;
  const chip = (selected: boolean) =>
    selected ? 'h-11 border-primary ring-1 ring-primary' : 'h-11';

  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-2 text-sm text-muted-foreground">{t('date.label')}</legend>
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          className={chip(value === today)}
          aria-pressed={value === today}
          onClick={() => {
            onChange(today);
          }}
        >
          {t('date.today')}
        </Button>
        <Button
          type="button"
          variant="outline"
          className={chip(value === yesterday)}
          aria-pressed={value === yesterday}
          onClick={() => {
            onChange(yesterday);
          }}
        >
          {t('date.yesterday')}
        </Button>
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="outline"
              className={chip(custom)}
              aria-pressed={custom}
              aria-label={custom ? `${t('date.calendar')}: ${formatters.date(value)}` : undefined}
            >
              <CalendarDays aria-hidden />
              {custom ? formatters.date(value) : t('date.calendar')}
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-auto p-0" align="start" aria-label={t('date.pick')}>
            <Calendar
              mode="single"
              locale={es}
              weekStartsOn={weekStart === 'monday' ? 1 : 0}
              selected={toDate(value)}
              defaultMonth={toDate(value)}
              disabled={{ after: toDate(today) }}
              onSelect={(day) => {
                if (day === undefined) return;
                onChange(toLocalDate(day));
                setOpen(false);
              }}
            />
          </PopoverContent>
        </Popover>
      </div>
    </fieldset>
  );
}
