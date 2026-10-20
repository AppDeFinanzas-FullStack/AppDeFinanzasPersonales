import type { DashboardDto } from '@finanzas/contracts';
import { useTranslation } from 'react-i18next';

import { useFormatters } from '@/features/settings/hooks/use-settings';

type Direction = 'up' | 'down' | 'same';
type Tone = 'good' | 'bad' | 'neutral';

interface Variation {
  /** Text shown, e.g. "+100 %", "+3 pp", "—". */
  text: string;
  direction: Direction | null;
  /** Whether a rise is good (income, balance, savings rate) or bad (expense). */
  upIsGood: boolean;
}

const TONE_CLASS: Record<Tone, string> = {
  good: 'text-green-700 dark:text-green-400',
  bad: 'text-red-700 dark:text-red-400',
  neutral: 'text-muted-foreground',
};

function directionOf(sign: number): Direction {
  if (sign > 0) return 'up';
  if (sign < 0) return 'down';
  return 'same';
}

/** Sign of a decimal text like "+10%", "-5.00" or "0". */
function signOf(value: string): number {
  if (value.startsWith('-')) return -1;
  return /[1-9]/.test(value) ? 1 : 0;
}

function toneOf({ direction, upIsGood }: Variation): Tone {
  if (direction === null || direction === 'same') return 'neutral';
  return (direction === 'up') === upIsGood ? 'good' : 'bad';
}

function percentVariation(value: string | null, upIsGood: boolean, none: string): Variation {
  if (value === null) return { text: none, direction: null, upIsGood };
  return { text: value.replace('%', ' %'), direction: directionOf(signOf(value)), upIsGood };
}

function VariationLine({ variation }: { variation: Variation }) {
  const { t } = useTranslation('dashboard');
  const tone = toneOf(variation);
  return (
    <p className="text-sm">
      {variation.direction !== null && (
        <span className="text-muted-foreground">{t(`variation.${variation.direction}`)} </span>
      )}
      <span className={`tabular-nums ${TONE_CLASS[tone]}`}>{variation.text}</span>
      <span className="sr-only"> {t('variation.versus')}</span>
    </p>
  );
}

function Card({ label, value, variation }: { label: string; value: string; variation: Variation }) {
  return (
    <div className="flex flex-col gap-1 rounded-lg border border-border p-4">
      <p className="text-sm text-muted-foreground">{label}</p>
      <p className="text-2xl font-semibold tabular-nums">{value}</p>
      <VariationLine variation={variation} />
    </div>
  );
}

/** The four cards of the Inicio with their variation against the previous month (RF-M8-03/04). */
export function SummaryCards({ cards, symbol }: { cards: DashboardDto['cards']; symbol: string }) {
  const { t } = useTranslation('dashboard');
  const formatters = useFormatters();
  const none = t('variation.none');
  const { variations } = cards;

  const delta = variations.balance;
  const balanceVariation: Variation =
    delta === null
      ? { text: none, direction: null, upIsGood: true }
      : {
          text: `${signOf(delta) < 0 ? '−' : '+'}${formatters.money(delta.replace('-', ''), symbol)}`,
          direction: directionOf(signOf(delta)),
          upIsGood: true,
        };

  const pp = variations.savingsRatePp;
  const rateVariation: Variation =
    pp === null
      ? { text: none, direction: null, upIsGood: true }
      : {
          text: `${pp > 0 ? '+' : pp < 0 ? '−' : ''}${Math.abs(pp)} pp`,
          direction: directionOf(pp),
          upIsGood: true,
        };

  return (
    <section className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <Card
        label={t('cards.income')}
        value={`+${formatters.money(cards.income, symbol)}`}
        variation={percentVariation(variations.income, true, none)}
      />
      <Card
        label={t('cards.expense')}
        value={`−${formatters.money(cards.expense, symbol)}`}
        variation={percentVariation(variations.expense, false, none)}
      />
      <Card
        label={t('cards.balance')}
        value={formatters.money(cards.balance, symbol)}
        variation={balanceVariation}
      />
      {cards.savingsRatePct !== null && (
        <Card
          label={t('cards.savingsRate')}
          value={`${cards.savingsRatePct} %`}
          variation={rateVariation}
        />
      )}
    </section>
  );
}
