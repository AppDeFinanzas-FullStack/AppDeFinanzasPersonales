import { UsdReference, type RatesCurrentDto } from '@finanzas/contracts';
import { useTranslation } from 'react-i18next';

import { useFormatters } from '@/features/settings/hooks/use-settings';

type RateSource = NonNullable<RatesCurrentDto['references'][UsdReference]>['source'];

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

const SOURCE_URLS: Partial<Record<RateSource, string>> = {
  paralelo_bo: 'https://paralelo.bo',
  bcb: 'https://www.bcb.gob.bo',
};

function useUpdatedAgo(now: number): (observedAt: string) => string {
  const { t } = useTranslation('fx');
  return (observedAt) => {
    const elapsed = Math.max(0, now - new Date(observedAt).getTime());
    if (elapsed < MINUTE_MS) return t('current.updated.justNow');
    if (elapsed < HOUR_MS) {
      return t('current.updated.minutes', { count: Math.floor(elapsed / MINUTE_MS) });
    }
    if (elapsed < DAY_MS) {
      return t('current.updated.hours', { count: Math.floor(elapsed / HOUR_MS) });
    }
    return t('current.updated.days', { count: Math.floor(elapsed / DAY_MS) });
  };
}

/** The source is shown next to its data, linked when it has a site (RNF-27). */
function SourceLink({ source }: { source: RateSource }) {
  const { t } = useTranslation('fx');
  const url = SOURCE_URLS[source];
  const name = t(`current.sources.${source}`);
  if (url === undefined) return <span>{name}</span>;
  return (
    <a href={url} target="_blank" rel="noreferrer" className="text-primary underline">
      {name}
    </a>
  );
}

/** The 4 USD references, each with "actualizado hace X" and its source (RF-M3-05, RNF-27). */
export function CurrentRatesCard({ rates, now }: { rates: RatesCurrentDto; now: number }) {
  const { t } = useTranslation('fx');
  const formatters = useFormatters();
  const updatedAgo = useUpdatedAgo(now);
  return (
    <section aria-labelledby="fx-current" className="flex flex-col gap-4">
      <h2 id="fx-current" className="text-lg font-semibold">
        {t('current.title')}
      </h2>
      <ul className="flex flex-col divide-y divide-border rounded-lg border border-border">
        {UsdReference.options.map((kind) => {
          const reference = rates.references[kind];
          return (
            <li key={kind} data-testid={`rate-${kind}`} className="flex flex-col gap-1 px-4 py-3">
              <div className="flex items-baseline justify-between gap-4">
                <span className="font-medium">
                  {t(`kinds.${kind}`)}
                  {rates.inUse.kind === kind && (
                    <span className="ml-2 text-sm font-normal text-muted-foreground">
                      {t('current.inUse')}
                    </span>
                  )}
                </span>
                <span className="text-right font-semibold tabular-nums">
                  {reference === null
                    ? t('current.noValue')
                    : formatters.money(reference.value, 'Bs')}
                </span>
              </div>
              {reference !== null && (
                <p className="text-sm text-muted-foreground">
                  {updatedAgo(reference.observedAt)} · {t('current.source')}{' '}
                  <SourceLink source={reference.source} />
                </p>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
