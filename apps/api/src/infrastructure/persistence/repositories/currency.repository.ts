import type { CurrencyRepository, CurrencyRow } from '../../../application/ports/repositories.js';
import type { TransactionClient } from '../unit-of-work.js';

/** Prisma implementation over `currency`, always filtered by the user of the transaction (RN-09). */
export function createCurrencyRepository(
  tx: TransactionClient,
  userId: string,
): CurrencyRepository {
  const select = async (
    code: string,
    lock: 'FOR UPDATE' | 'FOR SHARE',
  ): Promise<CurrencyRow | null> => {
    const rows =
      lock === 'FOR UPDATE'
        ? await tx.$queryRaw<CurrencyRow[]>`
            SELECT code::text AS code, symbol, is_system AS "isSystem", status::text AS status,
                   created_at AS "createdAt"
              FROM currency
             WHERE user_id = ${userId}::uuid AND code = ${code}
               FOR UPDATE`
        : await tx.$queryRaw<CurrencyRow[]>`
            SELECT code::text AS code, symbol, is_system AS "isSystem", status::text AS status,
                   created_at AS "createdAt"
              FROM currency
             WHERE user_id = ${userId}::uuid AND code = ${code}
               FOR SHARE`;
    return rows[0] ?? null;
  };

  return {
    async list(): Promise<CurrencyRow[]> {
      return tx.$queryRaw<CurrencyRow[]>`
        SELECT code::text AS code, symbol, is_system AS "isSystem", status::text AS status,
               created_at AS "createdAt"
          FROM currency
         WHERE user_id = ${userId}::uuid
         ORDER BY created_at ASC, code ASC`;
    },

    async get(code: string): Promise<CurrencyRow | null> {
      const rows = await tx.$queryRaw<CurrencyRow[]>`
        SELECT code::text AS code, symbol, is_system AS "isSystem", status::text AS status,
               created_at AS "createdAt"
          FROM currency
         WHERE user_id = ${userId}::uuid AND code = ${code}`;
      return rows[0] ?? null;
    },

    lockForUpdate: (code: string) => select(code, 'FOR UPDATE'),

    lockForShare: (code: string) => select(code, 'FOR SHARE'),

    async insert(currency: { code: string; symbol: string }): Promise<void> {
      await tx.$executeRaw`
        INSERT INTO currency (user_id, code, symbol)
        VALUES (${userId}::uuid, ${currency.code}, ${currency.symbol})`;
    },
  };
}
