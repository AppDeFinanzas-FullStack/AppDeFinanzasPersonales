import type { RatesCurrentDto } from '@finanzas/contracts';
import { useTranslation } from 'react-i18next';

import { useFormatters } from '@/features/settings/hooks/use-settings';

/** Gap of the rate in use against the official one, in % and in Bs (RF-M3-12). */
export function GapCard({ gap }: { gap: RatesCurrentDto['gap'] }) {
  const { t } = useTranslation('fx');
  const formatters = useFormatters();
  return (
    <section aria-labelledby="fx-gap" className="flex flex-col gap-2">
      <h2 id="fx-gap" className="text-lg font-semibold">
        {t('gap.title')}
      </h2>
      {gap === null ? (
        <p className="text-sm text-muted-foreground">{t('gap.empty')}</p>
      ) : (
        <>
          <p className="flex flex-wrap items-baseline gap-x-4 tabular-nums">
            <span className="text-3xl font-semibold">
              {t('gap.pct', { value: formatters.money(gap.pct, '').trim() })}
            </span>
            <span className="font-medium">{formatters.money(gap.bs, 'Bs')}</span>
          </p>
          <p className="text-sm text-muted-foreground">
            {t('gap.compared', { kind: t(`kinds.${gap.comparedKind}`) })}
          </p>
        </>
      )}
    </section>
  );
}
