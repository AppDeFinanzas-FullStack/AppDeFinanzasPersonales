import { Prisma } from '@finanzas/db';

import type {
  CategoryKind,
  CategoryPatch,
  CategoryRepository,
  CategoryRow,
  CategoryTreeNode,
  CategoryUsage,
  LifecycleStatus,
  NewUserCategory,
} from '../../../application/ports/repositories.js';
import type { TransactionClient } from '../unit-of-work.js';

interface TreeRecord {
  id: string;
  kind: CategoryKind;
  parentId: string | null;
  name: string;
  color: string;
  icon: string;
  isSystem: boolean;
  status: LifecycleStatus;
  /** `true` when the category hangs from a parent of the same status. */
  underParent: boolean;
}

const COLUMNS = Prisma.sql`
  c.id::text AS id, c.kind::text AS kind, c.parent_id::text AS "parentId", c.name, c.color, c.icon,
  c.is_system AS "isSystem", c.status::text AS status, c.archived_at AS "archivedAt",
  c.sort_order AS "sortOrder"`;

const toNode = (record: TreeRecord): CategoryTreeNode => ({
  id: record.id,
  kind: record.kind,
  name: record.name,
  color: record.color,
  icon: record.icon,
  isSystem: record.isSystem,
  status: record.status,
  children: [],
});

/** The `SET` assignments of the fields present in the patch. */
function assignments(patch: CategoryPatch): Prisma.Sql[] {
  const sets: Prisma.Sql[] = [];
  if (patch.name !== undefined) sets.push(Prisma.sql`name = ${patch.name}`);
  if (patch.color !== undefined) sets.push(Prisma.sql`color = ${patch.color}`);
  if (patch.icon !== undefined) sets.push(Prisma.sql`icon = ${patch.icon}`);
  if (patch.parentId !== undefined) sets.push(Prisma.sql`parent_id = ${patch.parentId}::uuid`);
  return sets;
}

/** Prisma implementation over `category`, always filtered by the user of the transaction (RN-09). */
export function createCategoryRepository(
  tx: TransactionClient,
  userId: string,
): CategoryRepository {
  return {
    async tree(kind: CategoryKind, status: LifecycleStatus): Promise<CategoryTreeNode[]> {
      const records = await tx.$queryRaw<TreeRecord[]>`
        SELECT c.id::text AS id, c.kind::text AS kind, c.parent_id::text AS "parentId", c.name,
               c.color, c.icon, c.is_system AS "isSystem", c.status::text AS status,
               (p.id IS NOT NULL) AS "underParent"
          FROM category c
          LEFT JOIN category p
            ON p.user_id = c.user_id AND p.id = c.parent_id AND p.status = c.status
         WHERE c.user_id = ${userId}::uuid AND c.kind = ${kind}::category_kind
           AND c.status = ${status}::lifecycle_status
         ORDER BY c.sort_order ASC, c.id ASC`;

      const roots: CategoryTreeNode[] = [];
      const byId = new Map<string, CategoryTreeNode>();
      for (const record of records) {
        if (!record.underParent) {
          const node = toNode(record);
          roots.push(node);
          byId.set(node.id, node);
        }
      }
      for (const record of records) {
        if (record.underParent && record.parentId !== null) {
          byId.get(record.parentId)?.children.push(toNode(record));
        }
      }
      return roots;
    },

    async get(id: string): Promise<CategoryRow | null> {
      const rows = await tx.$queryRaw<CategoryRow[]>`
        SELECT ${COLUMNS}
          FROM category c
         WHERE c.user_id = ${userId}::uuid AND c.id = ${id}::uuid`;
      return rows[0] ?? null;
    },

    async insert(category: NewUserCategory): Promise<void> {
      await tx.$executeRaw`
        INSERT INTO category (id, user_id, kind, parent_id, name, color, icon, sort_order)
        VALUES (${category.id}::uuid, ${userId}::uuid, ${category.kind}::category_kind,
                ${category.parentId}::uuid, ${category.name}, ${category.color}, ${category.icon},
                ${category.sortOrder})`;
    },

    async update(id: string, patch: CategoryPatch): Promise<void> {
      const sets = assignments(patch);
      if (sets.length === 0) {
        return;
      }
      await tx.$executeRaw`
        UPDATE category
           SET ${Prisma.join(sets, ', ')}
         WHERE user_id = ${userId}::uuid AND id = ${id}::uuid`;
    },

    async setOrder(ids: string[]): Promise<void> {
      if (ids.length === 0) {
        return;
      }
      await tx.$executeRaw`
        UPDATE category
           SET sort_order = position.ord::int
          FROM unnest(${ids}::uuid[]) WITH ORDINALITY AS position(id, ord)
         WHERE category.user_id = ${userId}::uuid AND category.id = position.id`;
    },

    async count(): Promise<number> {
      const rows = await tx.$queryRaw<{ count: number }[]>`
        SELECT count(*)::int AS count FROM category WHERE user_id = ${userId}::uuid`;
      return rows[0]?.count ?? 0;
    },

    async hasMovements(id: string): Promise<boolean> {
      const rows = await tx.$queryRaw<{ found: boolean }[]>`
        SELECT EXISTS (
          SELECT 1 FROM ledger_transaction
           WHERE user_id = ${userId}::uuid AND category_id = ${id}::uuid
        ) AS found`;
      return rows[0]?.found ?? false;
    },

    async usage(id: string): Promise<CategoryUsage> {
      const budgets = await tx.$queryRaw<{ id: string }[]>`
        SELECT id::text AS id FROM budget
         WHERE user_id = ${userId}::uuid AND category_id = ${id}::uuid
         ORDER BY created_at ASC, id ASC`;
      const recurring = await tx.$queryRaw<{ id: string; name: string }[]>`
        SELECT id::text AS id, name FROM recurring_rule
         WHERE user_id = ${userId}::uuid AND category_id = ${id}::uuid
         ORDER BY name ASC, id ASC`;
      const shortcuts = await tx.$queryRaw<{ id: string; name: string }[]>`
        SELECT id::text AS id, name FROM shortcut
         WHERE user_id = ${userId}::uuid AND category_id = ${id}::uuid
         ORDER BY sort_order ASC, id ASC`;
      return { budgets, recurring, shortcuts };
    },

    async idsWithChildren(id: string): Promise<string[]> {
      const rows = await tx.$queryRaw<{ id: string }[]>`
        SELECT id::text AS id FROM category
         WHERE user_id = ${userId}::uuid AND (id = ${id}::uuid OR parent_id = ${id}::uuid)
         ORDER BY (parent_id IS NOT NULL) ASC, sort_order ASC, id ASC`;
      return rows.map((row) => row.id);
    },
  };
}
