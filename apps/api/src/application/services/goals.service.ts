import type {
  CreateGoalInput,
  DedicateInput,
  EarmarkInput,
  GoalDto,
  ReleaseInput,
  UpdateGoalInput,
} from '@finanzas/contracts';
import {
  progress as goalProgress,
  status as goalStatus,
  suggestedMonthly,
  todayFor,
  toMoneyString,
} from '@finanzas/domain';
import { Decimal } from 'decimal.js';
import { uuidv7 } from 'uuidv7';

import { AppError } from '../errors.js';
import type {
  AccountRow,
  GoalHistoryItem,
  GoalPatch,
  GoalRow,
  Repositories,
} from '../ports/repositories.js';
import type { UnitOfWork } from '../ports/unit-of-work.js';
import { assertLimit } from '../shared/limits.js';
import type { RatesContext, RatesService } from './rates.service.js';

export type GoalsContext = RatesContext;

export type GoalDetail = GoalDto & { history: GoalHistoryItem[] };

export interface GoalsService {
  /** Creates a goal, idempotent by `input.id` (ADR-11); a dedicated account is validated (RF-M12-01). */
  create(ctx: GoalsContext, input: CreateGoalInput): Promise<{ created: boolean; goal: GoalDto }>;
  /** Edits a goal; a target date before today is rejected (RF-M12-01). */
  update(ctx: GoalsContext, id: string, input: UpdateGoalInput): Promise<GoalDto>;
  /** The goals that are not archived, with progress, status and suggestion (RF-M12-02, RF-M12-06). */
  list(ctx: GoalsContext): Promise<GoalDto[]>;
  /** One goal with its progress by account and its history (RF-M12-07). */
  get(ctx: GoalsContext, id: string): Promise<GoalDetail>;
  /** Earmarks an amount of an account for the goal, within its free balance (RF-M12-04). */
  earmark(ctx: GoalsContext, goalId: string, input: EarmarkInput): Promise<GoalDto>;
  /** Releases part of what the goal has earmarked in an account (RF-M12-04). */
  release(ctx: GoalsContext, goalId: string, input: ReleaseInput): Promise<GoalDto>;
  /** Dedicates an account to the goal (RF-M12-03). */
  dedicate(ctx: GoalsContext, goalId: string, input: DedicateInput): Promise<GoalDto>;
  /** Releases every earmark, drops the dedicated account and archives the goal (RF-M12-09). */
  useAndClose(ctx: GoalsContext, goalId: string): Promise<GoalDto>;
  /** Archives an empty goal. */
  archive(ctx: GoalsContext, goalId: string): Promise<GoalDto>;
  /** Restores an archived goal; earmarks are not recovered. */
  restore(ctx: GoalsContext, goalId: string): Promise<GoalDto>;
  /** Deletes an empty goal with its history. */
  remove(ctx: GoalsContext, goalId: string): Promise<void>;
  /** Marks the celebration as shown, once. */
  celebrated(ctx: GoalsContext, goalId: string): Promise<void>;
}

export interface GoalsServiceDeps {
  uow: UnitOfWork;
  rates: Pick<RatesService, 'currentRateFor'>;
}

/** What is stored for one goal at the moment of reading it. */
interface GoalSnapshot {
  goal: GoalRow;
  dedicated: { account: AccountRow; balance: Decimal } | null;
  earmarks: { account: AccountRow; amount: Decimal }[];
  history: GoalHistoryItem[];
}

function invalidField(path: string, code: string): AppError {
  return new AppError('VALIDATION_ERROR', { issues: [{ path, code }] });
}

async function requireActiveCurrency(repos: Repositories, code: string): Promise<void> {
  const currency = await repos.currencies.lockForShare(code);
  if (currency === null) {
    throw invalidField('currencyCode', 'not_found');
  }
  if (currency.status !== 'active') {
    throw new AppError('CURRENCY_INACTIVE');
  }
}

/** The same rules as dedicating an account to a goal (plan §4.12.2). */
async function assertDedicable(repos: Repositories, accountId: string): Promise<void> {
  const [account] = await repos.accounts.lockForUpdate([accountId]);
  if (account === undefined) {
    throw new AppError('NOT_FOUND');
  }
  if (account.type === 'credit_card') {
    throw new AppError('ACCOUNT_NOT_DEDICABLE');
  }
  if ((await repos.goals.findByDedicatedAccount(accountId)) !== null) {
    throw new AppError('ACCOUNT_ALREADY_DEDICATED');
  }
  const earmarks = await repos.goalAllocations.earmarkedByAccount(accountId);
  if (earmarks.some((earmark) => earmark.amount.greaterThan(0))) {
    throw new AppError('ACCOUNT_HAS_OTHER_EARMARKS');
  }
}

/** A goal is empty when it has no earmarks and no dedicated account. */
async function assertEmpty(repos: Repositories, goal: GoalRow): Promise<void> {
  const earmarks = await repos.goalAllocations.earmarkedByGoal(goal.id);
  if (goal.dedicatedAccountId !== null || earmarks.some((row) => !row.amount.isZero())) {
    throw new AppError('GOAL_NOT_EMPTY');
  }
}

async function requireGoal(repos: Repositories, id: string): Promise<GoalRow> {
  const goal = await repos.goals.get(id);
  if (goal === null) {
    throw new AppError('NOT_FOUND');
  }
  return goal;
}

function sameGoal(row: GoalRow, input: CreateGoalInput): boolean {
  return (
    row.name === input.name.trim() &&
    row.target.equals(new Decimal(input.target)) &&
    row.currencyCode === input.currencyCode &&
    row.targetDate === (input.targetDate ?? null) &&
    row.icon === input.icon &&
    row.color === input.color &&
    row.dedicatedAccountId === (input.dedicatedAccountId ?? null)
  );
}

async function snapshotOf(
  repos: Repositories,
  goal: GoalRow,
  withHistory: boolean,
): Promise<GoalSnapshot> {
  const accountOf = async (id: string): Promise<AccountRow> => {
    const account = await repos.accounts.get(id);
    if (account === null) {
      throw new AppError('INTERNAL_ERROR');
    }
    return account;
  };

  let dedicated: GoalSnapshot['dedicated'] = null;
  if (goal.dedicatedAccountId !== null) {
    const account = await accountOf(goal.dedicatedAccountId);
    const balances = await repos.ledger.balances([account.id]);
    dedicated = { account, balance: balances.get(account.id) ?? account.initialBalance };
  }

  const earmarks: GoalSnapshot['earmarks'] = [];
  for (const row of await repos.goalAllocations.earmarkedByGoal(goal.id)) {
    if (row.accountId === goal.dedicatedAccountId || !row.amount.greaterThan(0)) {
      continue;
    }
    earmarks.push({ account: await accountOf(row.accountId), amount: row.amount });
  }

  // An adjustment of the dedicated account shows with the origin "adjustment" (RF-M4-05).
  const history = withHistory
    ? (await repos.goalAllocations.history(goal.id)).map((item) =>
        item.ledgerKind === 'adjustment' ? { ...item, origin: 'adjustment' as const } : item,
      )
    : [];
  return { goal, dedicated, earmarks, history };
}

export function createGoalsService({ uow, rates }: GoalsServiceDeps): GoalsService {
  /** Goal DTOs from the snapshots; rates are read after the transaction (RN-05). */
  const toDtos = async (ctx: GoalsContext, snapshots: GoalSnapshot[]): Promise<GoalDto[]> => {
    const codes = new Set<string>();
    for (const { goal, dedicated, earmarks } of snapshots) {
      codes.add(goal.currencyCode);
      if (dedicated) codes.add(dedicated.account.currencyCode);
      for (const earmark of earmarks) codes.add(earmark.account.currencyCode);
    }
    const bobPerUnit: Record<string, Decimal> = {};
    for (const code of codes) {
      const rate = await rates.currentRateFor(ctx, code);
      if (rate !== null) bobPerUnit[code] = rate;
    }
    const today = todayFor(ctx.timezone, ctx.now);

    return snapshots.map(({ goal, dedicated, earmarks }) => {
      const target = toMoneyString(goal.target);
      const progress = goalProgress(
        dedicated
          ? {
              amount: toMoneyString(dedicated.balance),
              currencyCode: dedicated.account.currencyCode,
            }
          : null,
        earmarks.map((e) => ({
          amount: toMoneyString(e.amount),
          currencyCode: e.account.currencyCode,
        })),
        { goalCurrency: goal.currencyCode, bobPerUnit },
      );
      const targetDate = goal.targetDate ?? undefined;
      const state =
        goal.archivedAt === null
          ? goalStatus({ target, currencyCode: goal.currencyCode, targetDate }, progress, today)
          : 'archived';
      const pct = goal.target.isZero()
        ? new Decimal(0)
        : new Decimal(progress).div(goal.target).times(100).toDecimalPlaces(0, Decimal.ROUND_DOWN);

      const byAccount: GoalDto['byAccount'] = [];
      if (dedicated) {
        byAccount.push({
          accountId: dedicated.account.id,
          name: dedicated.account.name,
          amount: toMoneyString(dedicated.balance),
          dedicated: true,
        });
      }
      for (const earmark of earmarks) {
        byAccount.push({
          accountId: earmark.account.id,
          name: earmark.account.name,
          amount: toMoneyString(earmark.amount),
          dedicated: false,
        });
      }

      const dto: GoalDto = {
        id: goal.id,
        name: goal.name,
        target,
        currencyCode: goal.currencyCode,
        icon: goal.icon as GoalDto['icon'],
        color: goal.color as GoalDto['color'],
        status: state,
        progress,
        pct: pct.toNumber(),
        byAccount,
        suggested: suggestedMonthly(target, progress, targetDate, today),
        firstAchievement: state === 'achieved' && goal.celebratedAt === null,
      };
      if (targetDate !== undefined) dto.targetDate = targetDate;
      if (dedicated) {
        dto.dedicatedAccount = { id: dedicated.account.id, name: dedicated.account.name };
      }
      return dto;
    });
  };

  const single = async (ctx: GoalsContext, snapshot: GoalSnapshot): Promise<GoalDto> => {
    const [dto] = await toDtos(ctx, [snapshot]);
    if (dto === undefined) {
      throw new AppError('INTERNAL_ERROR');
    }
    return dto;
  };

  return {
    async create(ctx, input) {
      const { created, snapshot } = await uow.run(
        async (repos) => {
          const existing = await repos.goals.get(input.id);
          if (existing !== null) {
            if (!sameGoal(existing, input)) {
              throw new AppError('IDEMPOTENCY_CONFLICT');
            }
            return { created: false, snapshot: await snapshotOf(repos, existing, false) };
          }

          assertLimit(await repos.goals.count(), 'goals');
          await requireActiveCurrency(repos, input.currencyCode);
          if (input.dedicatedAccountId !== undefined) {
            await assertDedicable(repos, input.dedicatedAccountId);
          }

          await repos.goals.insert({
            id: input.id,
            name: input.name.trim(),
            target: new Decimal(input.target),
            currencyCode: input.currencyCode,
            targetDate: input.targetDate ?? null,
            icon: input.icon,
            color: input.color,
            dedicatedAccountId: input.dedicatedAccountId ?? null,
          });
          const goal = await repos.goals.get(input.id);
          if (goal === null) {
            throw new AppError('INTERNAL_ERROR');
          }
          return { created: true, snapshot: await snapshotOf(repos, goal, false) };
        },
        { userLock: ctx.userId },
      );
      return { created, goal: await single(ctx, snapshot) };
    },

    async update(ctx, id, input) {
      const snapshot = await uow.run(
        async (repos) => {
          const current = await repos.goals.get(id);
          if (current === null) {
            throw new AppError('NOT_FOUND');
          }
          const patch: GoalPatch = {};
          if (input.name !== undefined) patch.name = input.name.trim();
          if (input.target !== undefined) patch.target = new Decimal(input.target);
          if (input.icon !== undefined) patch.icon = input.icon;
          if (input.color !== undefined) patch.color = input.color;
          if (input.targetDate !== undefined) {
            if (input.targetDate < todayFor(ctx.timezone, ctx.now)) {
              throw new AppError('TARGET_DATE_IN_PAST');
            }
            patch.targetDate = input.targetDate;
          }
          if (input.currencyCode !== undefined && input.currencyCode !== current.currencyCode) {
            await requireActiveCurrency(repos, input.currencyCode);
            patch.currencyCode = input.currencyCode;
          }
          await repos.goals.update(id, patch);
          const updated = await repos.goals.get(id);
          if (updated === null) {
            throw new AppError('INTERNAL_ERROR');
          }
          return snapshotOf(repos, updated, false);
        },
        { userLock: ctx.userId },
      );
      return single(ctx, snapshot);
    },

    async list(ctx) {
      const snapshots = await uow.run(
        async (repos) => {
          const result: GoalSnapshot[] = [];
          for (const goal of await repos.goals.list()) {
            result.push(await snapshotOf(repos, goal, false));
          }
          return result;
        },
        { userLock: ctx.userId, readOnly: true },
      );
      return toDtos(ctx, snapshots);
    },

    async get(ctx, id) {
      const snapshot = await uow.run(
        async (repos) => {
          const goal = await repos.goals.get(id);
          if (goal === null) {
            throw new AppError('NOT_FOUND');
          }
          return snapshotOf(repos, goal, true);
        },
        { userLock: ctx.userId, readOnly: true },
      );
      return { ...(await single(ctx, snapshot)), history: snapshot.history };
    },

    async earmark(ctx, goalId, input) {
      const snapshot = await uow.run(
        async (repos) => {
          const goal = await repos.goals.get(goalId);
          if (goal === null) {
            throw new AppError('NOT_FOUND');
          }
          const [account] = await repos.accounts.lockForUpdate([input.accountId]);
          if (account === undefined) {
            throw new AppError('NOT_FOUND');
          }
          if (account.type === 'credit_card') {
            throw new AppError('ACCOUNT_NOT_DEDICABLE');
          }
          const balances = await repos.ledger.balances([account.id]);
          const balance = balances.get(account.id) ?? account.initialBalance;
          const earmarked = (await repos.goalAllocations.earmarkedByAccount(account.id)).reduce(
            (sum, row) => sum.plus(row.amount),
            new Decimal(0),
          );
          const free = balance.minus(earmarked);
          const amount = new Decimal(input.amount);
          if (amount.greaterThan(free)) {
            throw new AppError('EARMARK_EXCEEDS_FREE', { free: toMoneyString(free) });
          }
          await repos.goalAllocations.insert({
            id: input.id,
            goalId,
            accountId: account.id,
            amount,
            origin: 'manual',
            relatedTransactionId: null,
          });
          return snapshotOf(repos, goal, false);
        },
        { userLock: ctx.userId },
      );
      return single(ctx, snapshot);
    },

    async release(ctx, goalId, input) {
      const snapshot = await uow.run(
        async (repos) => {
          const goal = await repos.goals.get(goalId);
          if (goal === null) {
            throw new AppError('NOT_FOUND');
          }
          const [account] = await repos.accounts.lockForUpdate([input.accountId]);
          if (account === undefined) {
            throw new AppError('NOT_FOUND');
          }
          const earmarked =
            (await repos.goalAllocations.earmarkedByAccount(account.id)).find(
              (row) => row.goalId === goalId,
            )?.amount ?? new Decimal(0);
          const amount = new Decimal(input.amount);
          if (amount.greaterThan(earmarked)) {
            throw new AppError('RELEASE_EXCEEDS_EARMARK');
          }
          await repos.goalAllocations.insert({
            id: uuidv7(),
            goalId,
            accountId: account.id,
            amount: amount.negated(),
            origin: 'manual',
            relatedTransactionId: null,
          });
          return snapshotOf(repos, goal, false);
        },
        { userLock: ctx.userId },
      );
      return single(ctx, snapshot);
    },

    async dedicate(ctx, goalId, input) {
      const snapshot = await uow.run(
        async (repos) => {
          const goal = await repos.goals.get(goalId);
          if (goal === null) {
            throw new AppError('NOT_FOUND');
          }
          await assertDedicable(repos, input.accountId);
          await repos.goals.setDedicatedAccount(goalId, input.accountId);
          const updated = await repos.goals.get(goalId);
          if (updated === null) {
            throw new AppError('INTERNAL_ERROR');
          }
          return snapshotOf(repos, updated, false);
        },
        { userLock: ctx.userId },
      );
      return single(ctx, snapshot);
    },

    async useAndClose(ctx, goalId) {
      const snapshot = await uow.run(
        async (repos) => {
          const goal = await requireGoal(repos, goalId);
          for (const row of await repos.goalAllocations.earmarkedByGoal(goalId)) {
            if (row.amount.isZero()) continue;
            await repos.goalAllocations.insert({
              id: uuidv7(),
              goalId,
              accountId: row.accountId,
              amount: row.amount.negated(),
              origin: 'use_and_close',
              relatedTransactionId: null,
            });
          }
          if (goal.dedicatedAccountId !== null) {
            await repos.goals.clearDedicatedAccount(goalId);
          }
          await repos.goals.setArchived(goalId, true);
          return snapshotOf(repos, await requireGoal(repos, goalId), false);
        },
        { userLock: ctx.userId },
      );
      return single(ctx, snapshot);
    },

    async archive(ctx, goalId) {
      const snapshot = await uow.run(
        async (repos) => {
          await assertEmpty(repos, await requireGoal(repos, goalId));
          await repos.goals.setArchived(goalId, true);
          return snapshotOf(repos, await requireGoal(repos, goalId), false);
        },
        { userLock: ctx.userId },
      );
      return single(ctx, snapshot);
    },

    async restore(ctx, goalId) {
      const snapshot = await uow.run(
        async (repos) => {
          await requireGoal(repos, goalId);
          await repos.goals.setArchived(goalId, false);
          return snapshotOf(repos, await requireGoal(repos, goalId), false);
        },
        { userLock: ctx.userId },
      );
      return single(ctx, snapshot);
    },

    async remove(ctx, goalId) {
      await uow.run(
        async (repos) => {
          await assertEmpty(repos, await requireGoal(repos, goalId));
          await repos.goalAllocations.deleteByGoal(goalId);
          await repos.goals.remove(goalId);
        },
        { userLock: ctx.userId },
      );
    },

    async celebrated(ctx, goalId) {
      await uow.run(
        async (repos) => {
          await requireGoal(repos, goalId);
          await repos.goals.markCelebrated(goalId);
        },
        { userLock: ctx.userId },
      );
    },
  };
}
