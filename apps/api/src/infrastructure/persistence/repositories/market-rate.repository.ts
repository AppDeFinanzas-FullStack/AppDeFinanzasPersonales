import { Decimal } from 'decimal.js';

import type {
  MarketRateKind,
  MarketRateRepository,
  MarketRateRow,
  RateSource,
} from '../../../application/ports/repositories.js';
import type { TransactionClient } from '../unit-of-work.js';

interface MarketRateRecord {
  kind: MarketRateKind;
  rateDate: string;
  value: string;
  observedAt: Date;
  source: RateSource;
}

const toRow = (record: MarketRateRecord): MarketRateRow => ({
  kind: record.kind,
  rateDate: record.rateDate,
  value: new Decimal(record.value),
  observedAt: record.observedAt,
  source: record.source,
});

/** Prisma implementation over `market_rate`, a global table (ADR-12). */
export function createMarketRateRepository(tx: TransactionClient): MarketRateRepository {
  return {
    async upsertIfNewer(rate: MarketRateRow): Promise<void> {
      await tx.$executeRaw`
        INSERT INTO market_rate (kind, rate_date, value, observed_at, source)
        VALUES (${rate.kind}::market_rate_kind, ${rate.rateDate}::date, ${rate.value.toFixed(2)}::numeric,
                ${rate.observedAt}::timestamptz, ${rate.source}::rate_source)
        ON CONFLICT (kind, rate_date) DO UPDATE
           SET value = EXCLUDED.value,
               observed_at = EXCLUDED.observed_at,
               source = EXCLUDED.source
         WHERE EXCLUDED.observed_at > market_rate.observed_at`;
    },

    async latest(kind: MarketRateKind): Promise<MarketRateRow | null> {
      const rows = await tx.$queryRaw<MarketRateRecord[]>`
        SELECT kind::text AS kind, to_char(rate_date, 'YYYY-MM-DD') AS "rateDate",
               value::text AS value, observed_at AS "observedAt", source::text AS source
          FROM market_rate
         WHERE kind = ${kind}::market_rate_kind
         ORDER BY rate_date DESC
         LIMIT 1`;
      const row = rows[0];
      return row === undefined ? null : toRow(row);
    },

    async series(kind: MarketRateKind, from: string, to: string): Promise<MarketRateRow[]> {
      const rows = await tx.$queryRaw<MarketRateRecord[]>`
        SELECT kind::text AS kind, to_char(rate_date, 'YYYY-MM-DD') AS "rateDate",
               value::text AS value, observed_at AS "observedAt", source::text AS source
          FROM market_rate
         WHERE kind = ${kind}::market_rate_kind
           AND rate_date BETWEEN ${from}::date AND ${to}::date
         ORDER BY rate_date ASC`;
      return rows.map(toRow);
    },
  };
}
