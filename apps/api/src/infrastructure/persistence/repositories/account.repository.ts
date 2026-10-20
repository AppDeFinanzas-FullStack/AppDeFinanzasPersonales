import { Prisma } from '@finanzas/db';
import { Decimal } from 'decimal.js';

import type {
  AccountPatch,
  AccountRepository,
  AccountRow,
  AccountType,
  LifecycleStatus,
  NewAccount,
} from '../../../application/ports/repositories.js';
import type { TransactionClient } from '../unit-of-work.js';

interface AccountRecord {
  id: string;
  type: AccountType;
  name: string;
  currencyCode: string;
  initialBalance: string;
  initialBalanceDate: string;
  color: string;
  icon: string;
  cardCutDay: number | null;
  cardPayDay: number | null;
  cardLimit: string | null;
  status: LifecycleStatus;
  archivedAt: Date | null;
  sortOrder: number;
}

const COLUMNS = Prisma.sql`
  id::text AS id, type::text AS type, name, currency_code::text AS "currencyCode",
  initial_balance::text AS "initialBalance",
  to_char(initial_balance_date, 'YYYY-MM-DD') AS "initialBalanceDate", color, icon,
  card_cut_day::int AS "cardCutDay", card_pay_day::int AS "cardPayDay",
  card_limit::text AS "cardLimit", status::text AS status, archived_at AS "archivedAt",
  sort_order AS "sortOrder"`;

const toRow = (record: AccountRecord): AccountRow => ({
  ...record,
  initialBalance: new Decimal(record.initialBalance),
  cardLimit: record.cardLimit === null ? null : new Decimal(record.cardLimit),
});

const money = (value: Decimal | null): string | null => (value === null ? null : value.toFixed(2));

/** The `SET` assignments of the fields present in the patch. */
function assignments(patch: AccountPatch): Prisma.Sql[] {
  const sets: Prisma.Sql[] = [];
  if (patch.type !== undefined) sets.push(Prisma.sql`type = ${patch.type}::account_type`);
  if (patch.name !== undefined) sets.push(Prisma.sql`name = ${patch.name}`);
  if (patch.currencyCode !== undefined)
    sets.push(Prisma.sql`currency_code = ${patch.currencyCode}`);
  if (patch.color !== undefined) sets.push(Prisma.sql`color = ${patch.color}`);
  if (patch.icon !== undefined) sets.push(Prisma.sql`icon = ${patch.icon}`);
  if (patch.cardCutDay !== undefined) {
    sets.push(Prisma.sql`card_cut_day = ${patch.cardCutDay}::smallint`);
  }
  if (patch.cardPayDay !== undefined) {
    sets.push(Prisma.sql`card_pay_day = ${patch.cardPayDay}::smallint`);
  }
  if (patch.cardLimit !== undefined) {
    sets.push(Prisma.sql`card_limit = ${money(patch.cardLimit)}::numeric`);
  }
  return sets;
}

/** Prisma implementation over `account`, always filtered by the user of the transaction (RN-09). */
export function createAccountRepository(tx: TransactionClient, userId: string): AccountRepository {
  return {
    async insert(account: NewAccount): Promise<void> {
      await tx.$executeRaw`
        INSERT INTO account (id, user_id, type, name, currency_code, initial_balance,
                             initial_balance_date, color, icon, card_cut_day, card_pay_day,
                             card_limit, sort_order)
        VALUES (${account.id}::uuid, ${userId}::uuid, ${account.type}::account_type, ${account.name},
                ${account.currencyCode}, ${account.initialBalance.toFixed(2)}::numeric,
                ${account.initialBalanceDate}::date, ${account.color}, ${account.icon},
                ${account.cardCutDay}::smallint, ${account.cardPayDay}::smallint,
                ${money(account.cardLimit)}::numeric, ${account.sortOrder})`;
    },

    async get(id: string): Promise<AccountRow | null> {
      const rows = await tx.$queryRaw<AccountRecord[]>`
        SELECT ${COLUMNS}
          FROM account
         WHERE user_id = ${userId}::uuid AND id = ${id}::uuid`;
      const row = rows[0];
      return row === undefined ? null : toRow(row);
    },

    async list(status: LifecycleStatus): Promise<AccountRow[]> {
      const rows = await tx.$queryRaw<AccountRecord[]>`
        SELECT ${COLUMNS}
          FROM account
         WHERE user_id = ${userId}::uuid AND status = ${status}::lifecycle_status
         ORDER BY sort_order ASC, id ASC`;
      return rows.map(toRow);
    },

    async lockForUpdate(ids: string[]): Promise<AccountRow[]> {
      if (ids.length === 0) {
        return [];
      }
      const rows = await tx.$queryRaw<AccountRecord[]>`
        SELECT ${COLUMNS}
          FROM account
         WHERE user_id = ${userId}::uuid AND id = ANY(${ids}::uuid[])
         ORDER BY id ASC
           FOR UPDATE`;
      return rows.map(toRow);
    },

    async update(id: string, patch: AccountPatch): Promise<void> {
      const sets = assignments(patch);
      if (sets.length === 0) {
        return;
      }
      await tx.$executeRaw`
        UPDATE account
           SET ${Prisma.join(sets, ', ')}
         WHERE user_id = ${userId}::uuid AND id = ${id}::uuid`;
    },

    async setOrder(ids: string[]): Promise<void> {
      if (ids.length === 0) {
        return;
      }
      await tx.$executeRaw`
        UPDATE account
           SET sort_order = position.ord::int
          FROM unnest(${ids}::uuid[]) WITH ORDINALITY AS position(id, ord)
         WHERE account.user_id = ${userId}::uuid AND account.id = position.id`;
    },

    async count(): Promise<number> {
      const rows = await tx.$queryRaw<{ count: number }[]>`
        SELECT count(*)::int AS count FROM account WHERE user_id = ${userId}::uuid`;
      return rows[0]?.count ?? 0;
    },

    async hasEntries(id: string): Promise<boolean> {
      const rows = await tx.$queryRaw<{ found: boolean }[]>`
        SELECT EXISTS (
          SELECT 1 FROM ledger_entry WHERE user_id = ${userId}::uuid AND account_id = ${id}::uuid
        ) AS found`;
      return rows[0]?.found ?? false;
    },

    async archive(id: string): Promise<boolean> {
      const updated = await tx.$executeRaw`
        UPDATE account
           SET status = 'archived'::lifecycle_status, archived_at = now()
         WHERE user_id = ${userId}::uuid AND id = ${id}::uuid AND status = 'active'`;
      return updated > 0;
    },

    async restore(id: string, name: string): Promise<boolean> {
      const updated = await tx.$executeRaw`
        UPDATE account
           SET status = 'active'::lifecycle_status, archived_at = NULL, name = ${name}
         WHERE user_id = ${userId}::uuid AND id = ${id}::uuid AND status = 'archived'`;
      return updated > 0;
    },

    async remove(id: string): Promise<void> {
      await tx.$executeRaw`
        DELETE FROM shortcut
         WHERE user_id = ${userId}::uuid
           AND (account_id = ${id}::uuid OR dest_account_id = ${id}::uuid)`;
      await tx.$executeRaw`
        DELETE FROM account WHERE user_id = ${userId}::uuid AND id = ${id}::uuid`;
    },
  };
}
