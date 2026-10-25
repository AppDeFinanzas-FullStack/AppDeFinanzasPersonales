import type { DashboardViewDto } from '@finanzas/contracts';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import { useFormatters } from '@/features/settings/hooks/use-settings';

interface Props {
  data: NonNullable<DashboardViewDto['upcoming']>;
}

const KINDS = ['debt_i_owe', 'debt_owed_to_me', 'card_cut', 'card_payment'] as const;

/** Where each due date leads: a debt to its detail, a card to its account. */
function routeOf(kind: string, id: string): string {
  return kind.startsWith('debt_') ? `/deudas/${id}` : `/cuentas/${id}`;
}

/** "Próximos pagos y deudas": the due dates of the next 7 days (RF-M8-09). */
export function UpcomingBlock({ data }: Props) {
  const { t } = useTranslation('dashboard');
  const formatters = useFormatters();

  return (
    <section className="flex flex-col gap-3" aria-labelledby="dashboard-upcoming">
      <h2 id="dashboard-upcoming" className="text-base font-semibold">
        {t('upcoming.title')}
      </h2>
      {data.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('upcoming.empty')}</p>
      ) : (
        <ul className="flex flex-col">
          {data.map((item) => (
            <li
              key={`${item.kind}-${item.id}-${item.dueDate}`}
              className="border-b border-border last:border-b-0"
            >
              <Link
                to={routeOf(item.kind, item.id)}
                className="flex min-h-11 items-center justify-between gap-2"
              >
                <span className="flex flex-col">
                  <span>{item.name}</span>
                  <span className="text-sm text-muted-foreground">
                    {(KINDS as readonly string[]).includes(item.kind)
                      ? t(`upcoming.kind.${item.kind}`)
                      : ''}
                  </span>
                </span>
                <span className="text-sm tabular-nums">{formatters.date(item.dueDate)}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
