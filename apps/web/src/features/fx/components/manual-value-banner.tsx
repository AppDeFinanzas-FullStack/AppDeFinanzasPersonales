import type { RatesCurrentDto } from '@finanzas/contracts';
import { useTranslation } from 'react-i18next';

import { useFormatters } from '@/features/settings/hooks/use-settings';

const DAY_MS = 86_400_000;

/** Fixed notice while the manual value has priority (RF-M3-03, scenario "Valor manual con prioridad"). */
export function ManualValueBanner({
  inUse,
  now,
}: {
  inUse: RatesCurrentDto['inUse'];
  now: number;
}) {
  const { t } = useTranslation('fx');
  const formatters = useFormatters();
  if (inUse.kind !== 'manual' || inUse.value === null) return null;
  const value = formatters.money(inUse.value, 'Bs');
  let text: string;
  if (inUse.since === undefined) {
    text = t('banner.noSince', { value });
  } else {
    const days = Math.max(0, Math.floor((now - new Date(inUse.since).getTime()) / DAY_MS));
    text =
      days === 0 ? t('banner.sinceToday', { value }) : t('banner.since', { value, count: days });
  }
  return (
    <p role="status" className="rounded-lg border border-border px-4 py-3 font-medium">
      {text}
    </p>
  );
}
