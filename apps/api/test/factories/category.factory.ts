import { uuidv7 } from 'uuidv7';

import { testPrisma } from '../integration/setup/db.js';

export type TestCategoryKind = 'expense' | 'income';
export type TestCategoryStatus = 'active' | 'archived';

export interface TestCategory {
  id: string;
  userId: string;
  kind: TestCategoryKind;
  parentId: string | null;
  name: string;
  color: string;
  icon: string;
  status: TestCategoryStatus;
  sortOrder: number;
}

export interface CreateCategoryOptions {
  id?: string;
  kind?: TestCategoryKind;
  parentId?: string | null;
  name?: string;
  color?: string;
  icon?: string;
  status?: TestCategoryStatus;
  sortOrder?: number;
}

let sequence = 0;

/** A name no other category of the same user has (the active names are unique, EC-M5-01). */
export function uniqueCategoryName(prefix = 'Cat'): string {
  sequence += 1;
  return `${prefix} ${sequence} ${uuidv7().slice(-6)}`;
}

/**
 * Creates a category of the user straight in `category`, by SQL, so the tests of the code that
 * reads categories never depend on the repository that writes them (plan §3.5). By default it is an
 * active expense category without a parent, `blue` with the `utensils` icon. An archived category
 * gets its `archived_at`. A subcategory takes the kind of its parent when `kind` is omitted. The
 * `category_guard` trigger still applies. The category goes away with its user
 * (`deleteCreatedUsers`).
 */
export async function createCategory(
  userId: string,
  options: CreateCategoryOptions = {},
): Promise<TestCategory> {
  sequence += 1;
  const parentId = options.parentId ?? null;
  const kind = options.kind ?? (parentId ? await kindOf(parentId) : 'expense');
  const category: TestCategory = {
    id: options.id ?? uuidv7(),
    userId,
    kind,
    parentId,
    name: options.name ?? uniqueCategoryName(),
    color: options.color ?? 'blue',
    icon: options.icon ?? 'utensils',
    status: options.status ?? 'active',
    sortOrder: options.sortOrder ?? 1000 + sequence,
  };

  await testPrisma().$executeRaw`
    INSERT INTO category (id, user_id, kind, parent_id, name, color, icon, status, archived_at,
                          sort_order)
    VALUES (${category.id}::uuid, ${userId}::uuid, ${category.kind}::category_kind,
            ${category.parentId}::uuid, ${category.name}, ${category.color}, ${category.icon},
            ${category.status}::lifecycle_status,
            ${category.status === 'archived' ? new Date() : null}::timestamptz,
            ${category.sortOrder})`;

  return category;
}

async function kindOf(categoryId: string): Promise<TestCategoryKind> {
  const rows = await testPrisma().$queryRaw<{ kind: TestCategoryKind }[]>`
    SELECT kind::text AS kind FROM category WHERE id = ${categoryId}::uuid`;
  const kind = rows[0]?.kind;
  if (!kind) {
    throw new Error(`Unknown parent category ${categoryId}`);
  }
  return kind;
}

/** Writes an active budget in BOB over the category, by SQL (plan §3.6). Returns its id. */
export async function createCategoryBudget(userId: string, categoryId: string): Promise<string> {
  const id = uuidv7();
  await testPrisma().$executeRaw`
    INSERT INTO budget (id, user_id, scope, category_id, amount, currency_code, start_day)
    VALUES (${id}::uuid, ${userId}::uuid, 'category', ${categoryId}::uuid, 500.00, 'BOB', 1)`;
  return id;
}

/**
 * Writes an active monthly recurring rule in confirm mode over the category and the account, by
 * SQL (plan §3.6). The kind follows the kind of the category. Returns its id and name.
 */
export async function createCategoryRule(
  userId: string,
  categoryId: string,
  accountId: string,
): Promise<{ id: string; name: string }> {
  const id = uuidv7();
  const name = uniqueCategoryName('Regla');
  const kind = await kindOf(categoryId);
  await testPrisma().$executeRaw`
    INSERT INTO recurring_rule (id, user_id, name, kind, account_id, category_id, frequency,
                                day_of_month, start_date, mode)
    VALUES (${id}::uuid, ${userId}::uuid, ${name}, ${kind}::entry_kind, ${accountId}::uuid,
            ${categoryId}::uuid, 'monthly', 5, '2090-01-01'::date, 'confirm')`;
  return { id, name };
}

/**
 * Writes a shortcut over the category and the account, by SQL (plan §3.5). The kind follows the
 * kind of the category. Returns its id and name.
 */
export async function createCategoryShortcut(
  userId: string,
  categoryId: string,
  accountId: string,
): Promise<{ id: string; name: string }> {
  const id = uuidv7();
  const name = uniqueCategoryName('Atajo');
  const kind = await kindOf(categoryId);
  await testPrisma().$executeRaw`
    INSERT INTO shortcut (id, user_id, name, kind, amount, account_id, category_id, sort_order)
    VALUES (${id}::uuid, ${userId}::uuid, ${name}, ${kind}::entry_kind, 10.00, ${accountId}::uuid,
            ${categoryId}::uuid, 1)`;
  return { id, name };
}

/**
 * Deletes the budgets, recurring rules and shortcuts of the users. They go first: `recurring_rule`
 * and `budget` point to `account` and `category` with `ON DELETE RESTRICT`, so they must not
 * outlive them when the users are deleted.
 */
export async function deleteCategoryUsageOf(userIds: string[]): Promise<void> {
  if (userIds.length === 0) {
    return;
  }
  const db = testPrisma();
  await db.$executeRaw`DELETE FROM recurring_rule WHERE user_id = ANY(${userIds}::uuid[])`;
  await db.$executeRaw`DELETE FROM budget WHERE user_id = ANY(${userIds}::uuid[])`;
  await db.$executeRaw`DELETE FROM shortcut WHERE user_id = ANY(${userIds}::uuid[])`;
}
