import { Prisma } from '@finanzas/db';
import { Decimal } from 'decimal.js';

import type {
  ShortcutKind,
  ShortcutPatch,
  ShortcutRepository,
  ShortcutRow,
} from '../../../application/ports/repositories.js';
import type { TransactionClient } from '../unit-of-work.js';

interface ShortcutRecord {
  id: string;
  name: string;
  kind: ShortcutKind;
  amount: string | null;
  accountId: string;
  destAccountId: string | null;
  categoryId: string | null;
  note: string | null;
  sortOrder: number;
}

const COLUMNS = Prisma.sql`
  s.id::text AS id, s.name, s.kind::text AS kind, s.amount::text AS amount,
  s.account_id::text AS "accountId", s.dest_account_id::text AS "destAccountId",
  s.category_id::text AS "categoryId", s.note, s.sort_order AS "sortOrder"`;

const toRow = (record: ShortcutRecord): ShortcutRow => ({
  ...record,
  amount: record.amount === null ? null : new Decimal(record.amount),
});

const money = (value: Decimal | null): string | null => (value === null ? null : value.toFixed(2));

/** The `SET` assignments of the fields present in the patch. */
function assignments(patch: ShortcutPatch): Prisma.Sql[] {
  const sets: Prisma.Sql[] = [];
  if (patch.name !== undefined) sets.push(Prisma.sql`name = ${patch.name}`);
  if (patch.kind !== undefined) sets.push(Prisma.sql`kind = ${patch.kind}::entry_kind`);
  if (patch.amount !== undefined) {
    sets.push(Prisma.sql`amount = ${money(patch.amount)}::numeric`);
  }
  if (patch.accountId !== undefined) {
    sets.push(Prisma.sql`account_id = ${patch.accountId}::uuid`);
  }
  if (patch.destAccountId !== undefined) {
    sets.push(Prisma.sql`dest_account_id = ${patch.destAccountId}::uuid`);
  }
  if (patch.categoryId !== undefined) {
    sets.push(Prisma.sql`category_id = ${patch.categoryId}::uuid`);
  }
  if (patch.note !== undefined) sets.push(Prisma.sql`note = ${patch.note}`);
  return sets;
}

/** Prisma implementation over `shortcut`, always filtered by the user of the transaction (RN-09). */
export function createShortcutRepository(
  tx: TransactionClient,
  userId: string,
): ShortcutRepository {
  return {
    async insert(shortcut: ShortcutRow): Promise<void> {
      await tx.$executeRaw`
        INSERT INTO shortcut (id, user_id, name, kind, amount, account_id, dest_account_id,
                              category_id, note, sort_order)
        VALUES (${shortcut.id}::uuid, ${userId}::uuid, ${shortcut.name},
                ${shortcut.kind}::entry_kind, ${money(shortcut.amount)}::numeric,
                ${shortcut.accountId}::uuid, ${shortcut.destAccountId}::uuid,
                ${shortcut.categoryId}::uuid, ${shortcut.note}, ${shortcut.sortOrder})`;
    },

    async get(id: string): Promise<ShortcutRow | null> {
      const records = await tx.$queryRaw<ShortcutRecord[]>`
        SELECT ${COLUMNS} FROM shortcut s
         WHERE s.user_id = ${userId}::uuid AND s.id = ${id}::uuid`;
      const record = records[0];
      return record === undefined ? null : toRow(record);
    },

    async list(): Promise<ShortcutRow[]> {
      const records = await tx.$queryRaw<ShortcutRecord[]>`
        SELECT ${COLUMNS} FROM shortcut s
         WHERE s.user_id = ${userId}::uuid
         ORDER BY s.sort_order ASC, s.id ASC`;
      return records.map(toRow);
    },

    async listVisible(): Promise<ShortcutRow[]> {
      const records = await tx.$queryRaw<ShortcutRecord[]>`
        SELECT ${COLUMNS} FROM shortcut s
          JOIN account a
            ON a.user_id = s.user_id AND a.id = s.account_id AND a.status = 'active'
          LEFT JOIN account d ON d.user_id = s.user_id AND d.id = s.dest_account_id
          LEFT JOIN category c ON c.user_id = s.user_id AND c.id = s.category_id
         WHERE s.user_id = ${userId}::uuid
           AND (s.dest_account_id IS NULL OR d.status = 'active')
           AND (s.category_id IS NULL OR c.status = 'active')
         ORDER BY s.sort_order ASC, s.id ASC`;
      return records.map(toRow);
    },

    async update(id: string, patch: ShortcutPatch): Promise<void> {
      const sets = assignments(patch);
      if (sets.length === 0) {
        return;
      }
      await tx.$executeRaw`
        UPDATE shortcut
           SET ${Prisma.join(sets, ', ')}, updated_at = now()
         WHERE user_id = ${userId}::uuid AND id = ${id}::uuid`;
    },

    async setOrder(ids: string[]): Promise<void> {
      if (ids.length === 0) {
        return;
      }
      await tx.$executeRaw`
        UPDATE shortcut
           SET sort_order = position.ord::int
          FROM unnest(${ids}::uuid[]) WITH ORDINALITY AS position(id, ord)
         WHERE shortcut.user_id = ${userId}::uuid AND shortcut.id = position.id`;
    },

    async remove(id: string): Promise<boolean> {
      const deleted = await tx.$executeRaw`
        DELETE FROM shortcut WHERE user_id = ${userId}::uuid AND id = ${id}::uuid`;
      return deleted > 0;
    },

    async count(): Promise<number> {
      const rows = await tx.$queryRaw<{ count: number }[]>`
        SELECT count(*)::int AS count FROM shortcut WHERE user_id = ${userId}::uuid`;
      return rows[0]?.count ?? 0;
    },
  };
}
