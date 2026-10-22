import { uuidv7 } from 'uuidv7';

import { testPrisma } from '../integration/setup/db.js';

export type TestAllocationOrigin =
  | 'manual'
  | 'budget'
  | 'confirmed_spend'
  | 'use_and_close'
  | 'adjustment';

export interface TestGoal {
  id: string;
  userId: string;
  name: string;
  /** Decimal text with two decimals. */
  target: string;
  currencyCode: string;
  dedicatedAccountId: string | null;
}

export interface CreateGoalOptions {
  id?: string;
  name?: string;
  target?: string;
  currencyCode?: string;
  icon?: string;
  color?: string;
  dedicatedAccountId?: string | null;
}

export interface CreateAllocationEventOptions {
  id?: string;
  /** Signed decimal text: an earmark (+) or a withdrawal (-). */
  amount: string;
  origin?: TestAllocationOrigin;
}

let sequence = 0;

/** Creates a goal straight in `goal`, by SQL (plan §3.6). It goes away with its user. */
export async function createGoal(
  userId: string,
  options: CreateGoalOptions = {},
): Promise<TestGoal> {
  sequence += 1;
  const goal: TestGoal = {
    id: options.id ?? uuidv7(),
    userId,
    name: options.name ?? `Meta ${sequence} ${uuidv7().slice(-6)}`,
    target: options.target ?? '1000.00',
    currencyCode: options.currencyCode ?? 'BOB',
    dedicatedAccountId: options.dedicatedAccountId ?? null,
  };
  await testPrisma().$executeRaw`
    INSERT INTO goal (id, user_id, name, target, currency_code, icon, color, dedicated_account_id)
    VALUES (${goal.id}::uuid, ${userId}::uuid, ${goal.name}, ${goal.target}::numeric,
            ${goal.currencyCode}, ${options.icon ?? 'target'}, ${options.color ?? 'blue'},
            ${goal.dedicatedAccountId}::uuid)`;
  return goal;
}

/** Writes an allocation event of the goal on the account, by SQL (plan §3.6). Returns its id. */
export async function createAllocationEvent(
  userId: string,
  goalId: string,
  accountId: string,
  options: CreateAllocationEventOptions,
): Promise<string> {
  const id = options.id ?? uuidv7();
  await testPrisma().$executeRaw`
    INSERT INTO goal_allocation_event (id, user_id, goal_id, account_id, amount, origin)
    VALUES (${id}::uuid, ${userId}::uuid, ${goalId}::uuid, ${accountId}::uuid,
            ${options.amount}::numeric, ${options.origin ?? 'manual'}::allocation_origin)`;
  return id;
}

/**
 * Deletes the events and the goals of the users. They go first: both point to `account` with
 * `ON DELETE RESTRICT`, so they must not outlive the accounts when the users are deleted.
 */
export async function deleteGoalsOf(userIds: string[]): Promise<void> {
  if (userIds.length === 0) {
    return;
  }
  const db = testPrisma();
  await db.$executeRaw`DELETE FROM goal_allocation_event WHERE user_id = ANY(${userIds}::uuid[])`;
  await db.$executeRaw`DELETE FROM goal WHERE user_id = ANY(${userIds}::uuid[])`;
}
