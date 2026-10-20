import { Decimal } from 'decimal.js';

import type {
  FxEventKind,
  MarketRateKind,
  UserFxEventRepository,
  UserFxEventRow,
} from '../../../application/ports/repositories.js';
import type { TransactionClient } from '../unit-of-work.js';

interface UserFxEventRecord {
  id: string;
  kind: FxEventKind;
  currencyCode: string | null;
  reference: MarketRateKind | null;
  value: string | null;
  effectiveAt: Date;
}

/** Prisma implementation over `user_fx_event`, always filtered by the user of the transaction (RN-09). */
export function createUserFxEventRepository(
  tx: TransactionClient,
  userId: string,
): UserFxEventRepository {
  return {
    async insert(event: UserFxEventRow): Promise<void> {
      await tx.$executeRaw`
        INSERT INTO user_fx_event (id, user_id, kind, currency_code, reference, value, effective_at)
        VALUES (${event.id}::uuid, ${userId}::uuid, ${event.kind}::fx_event_kind,
                ${event.currencyCode}, ${event.reference}::market_rate_kind,
                ${event.value === null ? null : event.value.toFixed(2)}::numeric,
                ${event.effectiveAt}::timestamptz)`;
    },

    async eventsUntil(instant: Date): Promise<UserFxEventRow[]> {
      const rows = await tx.$queryRaw<UserFxEventRecord[]>`
        SELECT id::text AS id, kind::text AS kind, currency_code::text AS "currencyCode",
               reference::text AS reference, value::text AS value, effective_at AS "effectiveAt"
          FROM user_fx_event
         WHERE user_id = ${userId}::uuid AND effective_at <= ${instant}::timestamptz
         ORDER BY effective_at ASC, id ASC`;
      return rows.map((row) => ({
        ...row,
        value: row.value === null ? null : new Decimal(row.value),
      }));
    },
  };
}
