import { addMonths } from '@finanzas/domain';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { LANGUAGE } from '@/app/providers/i18n';
import { Button } from '@/components/ui/button';

/** The month `by` months away from 'YYYY-MM'. */
export function shiftMonth(month: string, by: number): string {
  return addMonths(`${month}-01`, by).slice(0, 7);
}

/** "Octubre de 2026": the month name in the app language, in sentence case. */
function monthLabel(month: string): string {
  const [year = 1970, index = 1] = month.split('-').map(Number);
  const text = new Intl.DateTimeFormat(LANGUAGE, {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(year, index - 1, 1)));
  return text.charAt(0).toUpperCase() + text.slice(1);
}

interface MonthSelectorProps {
  /** 'YYYY-MM'. */
  month: string;
  /** The user's current month: movements are dated today or before (RF-M6-02). */
  currentMonth: string;
  onChange: (month: string) => void;
}

/** The month of the list, which opens on the current one (plan §4.6.4). */
export function MonthSelector({ month, currentMonth, onChange }: MonthSelectorProps) {
  const { t } = useTranslation('transactions');
  return (
    <div className="flex items-center justify-between gap-2">
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="h-11 w-11"
        aria-label={t('month.previous')}
        onClick={() => {
          onChange(shiftMonth(month, -1));
        }}
      >
        <ChevronLeft aria-hidden="true" />
      </Button>
      <p className="text-base font-medium" aria-live="polite">
        {monthLabel(month)}
      </p>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="h-11 w-11"
        aria-label={t('month.next')}
        disabled={month >= currentMonth}
        onClick={() => {
          onChange(shiftMonth(month, 1));
        }}
      >
        <ChevronRight aria-hidden="true" />
      </Button>
    </div>
  );
}
