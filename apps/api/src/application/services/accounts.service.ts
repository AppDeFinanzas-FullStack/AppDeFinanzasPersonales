import {
  UpdateAccountInput,
  type AccountDto,
  type AdjustInput,
  type ArchiveInput,
  type CreateAccountInput,
  type ReorderInput,
  type RestoreInput,
} from '@finanzas/contracts';
import {
  cardView,
  convert,
  netWorth,
  todayFor,
  toMoneyString,
  validateInitialBalance,
  validateTypeChange,
  type NetWorthResult,
} from '@finanzas/domain';
import { Decimal } from 'decimal.js';
import { uuidv7 } from 'uuidv7';

import { AppError } from '../errors.js';
import type {
  AccountPatch,
  AccountRow,
  LedgerTransactionDetail,
  LifecycleStatus,
  Repositories,
} from '../ports/repositories.js';
import type { UnitOfWork } from '../ports/unit-of-work.js';
import { BalanceGuard } from '../shared/balance-guard.js';
import type { LedgerHooks } from '../shared/ledger-hooks.js';
import { assertLimit } from '../shared/limits.js';
import type { RatesContext, RatesService } from './rates.service.js';

/** Request context built from the session (plan §1.4). */
export type AccountsContext = RatesContext;

export interface AccountsService {
  /**
   * Creates an active account, idempotent by `input.id` (ADR-11): the same id with the same data
   * gives the existing account with `created: false`; with other data, `IDEMPOTENCY_CONFLICT`.
   */
  create(
    ctx: AccountsContext,
    input: CreateAccountInput,
  ): Promise<{ created: boolean; account: AccountDto }>;
  /** Accounts of that status with their balance, its equivalents and the card data (RF-M4-08). */
  list(ctx: AccountsContext, status: LifecycleStatus): Promise<AccountDto[]>;
  /**
   * Net worth of the active accounts and its breakdown, with the rate in force (RF-M4-09,
   * RF-M4-10, RN-05); a missing rate leaves its amounts as `null`.
   */
  summary(ctx: AccountsContext): Promise<NetWorthResult>;
  /**
   * Edits the name, color, icon, card fields, type and currency (RF-M4-07); the initial balance
   * and its date are not editable (EC-M4-02). The last write wins (RNF-08).
   */
  update(ctx: AccountsContext, id: string, input: UpdateAccountInput): Promise<AccountDto>;
  /** Gives the user's accounts the order of `ids`, which must be exactly all of them (RF-M4-11). */
  reorder(ctx: AccountsContext, input: ReorderInput): Promise<void>;
  /**
   * Brings the balance to the real one with an adjustment dated today (RF-M4-05, RN-01), which is
   * neither income nor expense (RN-02). The same balance creates nothing (EC-M4-08), and the same
   * `transactionId` gives the adjustment already made (ADR-11).
   */
  adjust(
    ctx: AccountsContext,
    id: string,
    input: AdjustInput,
  ): Promise<{ created: boolean; transaction: LedgerTransactionDetail | null }>;
  /**
   * Archives an active account (RF-M4-09); a balance other than 0 needs `confirmNonZero`. It stops
   * being the default account (RF-M4-12, EC-M7-05). An archived account stays as it is.
   */
  archive(ctx: AccountsContext, id: string, input: ArchiveInput): Promise<AccountDto>;
  /**
   * Restores an archived account with a free name, or `newName` (EC-M4-04), in an active currency
   * (EC-M4-07). An active account stays as it is.
   */
  restore(ctx: AccountsContext, id: string, input: RestoreInput): Promise<AccountDto>;
  /**
   * Deletes an account without entries, counting those of deleted movements still undoable; it
   * stops being the default account and its shortcuts are deleted (RF-M4-13).
   */
  remove(ctx: AccountsContext, id: string): Promise<void>;
}

export interface AccountsServiceDeps {
  uow: UnitOfWork;
  rates: RatesService;
  ledgerHooks: LedgerHooks;
}

/** Set aside for goals: nothing until V1.1 (RF-M4-10). */
const NO_EARMARK = '0.00';

/** Accounts read in one transaction, with their balances and the user's base currency. */
interface Snapshot {
  rows: AccountRow[];
  balances: Map<string, Decimal>;
  baseCurrency: string;
}

/** The other one of BOB and USD; BOB when the base is any other currency (glossary). */
function otherCurrency(base: string): string {
  return base === 'BOB' ? 'USD' : 'BOB';
}

function invalidField(path: string, code: string): AppError {
  return new AppError('VALIDATION_ERROR', { issues: [{ path, code }] });
}

/** The initial balance as stored: a card keeps its debt as negative (RF-M4-02). */
function signedInitialBalance(input: CreateAccountInput): Decimal {
  const { initialBalance } = input;
  if (typeof initialBalance === 'string') {
    return new Decimal(initialBalance);
  }
  if (input.type !== 'credit_card') {
    throw invalidField('initialBalance', 'invalid_type');
  }
  const amount = new Decimal(initialBalance.amount);
  return initialBalance.kind === 'debt' ? amount.negated() : amount;
}

/** The real balance as stored: on a card the user gives the real debt, kept as negative. */
function signedRealBalance(
  type: AccountRow['type'],
  realBalance: AdjustInput['realBalance'],
): Decimal {
  if (typeof realBalance === 'string') {
    return new Decimal(realBalance);
  }
  if (type !== 'credit_card') {
    throw invalidField('realBalance', 'invalid_type');
  }
  const amount = new Decimal(realBalance.amount);
  return realBalance.kind === 'debt' ? amount.negated() : amount;
}

/** Card fields are only kept for a card. */
function cardFieldsOf(
  input: CreateAccountInput,
): Pick<AccountRow, 'cardCutDay' | 'cardPayDay' | 'cardLimit'> {
  const card = input.type === 'credit_card' ? input.card : undefined;
  return {
    cardCutDay: card?.cutDay ?? null,
    cardPayDay: card?.payDay ?? null,
    cardLimit: card?.limit === undefined || card.limit === null ? null : new Decimal(card.limit),
  };
}

function sameDecimal(a: Decimal | null, b: Decimal | null): boolean {
  return a === null || b === null ? a === b : a.equals(b);
}

/** Whether a repeated creation carries the data of the account already stored (ADR-11). */
function sameAccount(row: AccountRow, input: CreateAccountInput, initial: Decimal): boolean {
  const card = cardFieldsOf(input);
  return (
    row.type === input.type &&
    row.name === input.name.trim() &&
    row.currencyCode === input.currencyCode &&
    row.initialBalance.equals(initial) &&
    row.initialBalanceDate === input.initialBalanceDate &&
    row.color === input.color &&
    row.icon === input.icon &&
    row.cardCutDay === card.cardCutDay &&
    row.cardPayDay === card.cardPayDay &&
    sameDecimal(row.cardLimit, card.cardLimit)
  );
}

/** Rejects a name already used, ignoring case, by another active account (RF-M4-01). */
async function assertNameFree(
  repos: Repositories,
  name: string,
  selfId: string | null = null,
): Promise<void> {
  const wanted = name.toLowerCase();
  const active = await repos.accounts.list('active');
  if (active.some((account) => account.id !== selfId && account.name.toLowerCase() === wanted)) {
    throw new AppError('NAME_TAKEN');
  }
}

/** The currency an account is created in or moved to must exist and be active (plan §4.3.3). */
async function requireActiveCurrency(repos: Repositories, code: string): Promise<void> {
  // FOR SHARE keeps the currency from being deactivated meanwhile.
  const currency = await repos.currencies.lockForShare(code);
  if (currency === null) {
    throw invalidField('currencyCode', 'not_found');
  }
  if (currency.status !== 'active') {
    throw new AppError('CURRENCY_INACTIVE');
  }
}

/** The user's account locked `FOR UPDATE` until the transaction ends, or `NOT_FOUND`. */
async function lockedAccount(repos: Repositories, id: string): Promise<AccountRow> {
  const [account] = await repos.accounts.lockForUpdate([id]);
  if (account === undefined) {
    throw new AppError('NOT_FOUND');
  }
  return account;
}

async function readBack(repos: Repositories, id: string): Promise<AccountRow> {
  const account = await repos.accounts.get(id);
  if (account === null) {
    throw new AppError('INTERNAL_ERROR');
  }
  return account;
}

async function baseCurrencyOf(repos: Repositories, userId: string): Promise<string> {
  const settings = await repos.userSettings.fxSettings(userId);
  if (settings === null) {
    throw new AppError('SESSION_EXPIRED');
  }
  return settings.baseCurrency;
}

async function snapshotOf(
  repos: Repositories,
  userId: string,
  rows: AccountRow[],
): Promise<Snapshot> {
  const balances = await repos.ledger.balances(rows.map((row) => row.id));
  return { rows, balances, baseCurrency: await baseCurrencyOf(repos, userId) };
}

export function createAccountsService({
  uow,
  rates,
  ledgerHooks,
}: AccountsServiceDeps): AccountsService {
  /**
   * Bs per unit of each currency with the rate in force (RN-05). It runs after the snapshot's
   * transaction, since each rate takes the user lock in its own one.
   */
  const bobPerUnit = async (
    ctx: AccountsContext,
    snapshot: Snapshot,
  ): Promise<Record<string, Decimal | null>> => {
    const codes = new Set([
      snapshot.baseCurrency,
      otherCurrency(snapshot.baseCurrency),
      ...snapshot.rows.map((row) => row.currencyCode),
    ]);
    const result: Record<string, Decimal | null> = {};
    for (const code of codes) {
      result[code] = await rates.currentRateFor(ctx, code);
    }
    return result;
  };

  const toDtos = async (ctx: AccountsContext, snapshot: Snapshot): Promise<AccountDto[]> => {
    const perUnit = await bobPerUnit(ctx, snapshot);
    const base = snapshot.baseCurrency;
    const other = otherCurrency(base);
    const equivalent = (balance: Decimal, from: string, to: string): string | null => {
      const fromRate = perUnit[from] ?? null;
      const toRate = perUnit[to] ?? null;
      return fromRate === null || toRate === null
        ? null
        : toMoneyString(convert(balance, fromRate, toRate));
    };
    return snapshot.rows.map((row) => {
      const balance = snapshot.balances.get(row.id) ?? row.initialBalance;
      const text = toMoneyString(balance);
      const dto: AccountDto = {
        id: row.id,
        type: row.type,
        name: row.name,
        currencyCode: row.currencyCode,
        color: row.color as AccountDto['color'],
        icon: row.icon as AccountDto['icon'],
        status: row.status,
        sortOrder: row.sortOrder,
        initialBalance: toMoneyString(row.initialBalance),
        initialBalanceDate: row.initialBalanceDate,
        balance: text,
        balanceInBase: equivalent(balance, row.currencyCode, base),
        balanceInOther: equivalent(balance, row.currencyCode, other),
        earmarked: NO_EARMARK,
        free: text,
      };
      if (row.type === 'credit_card') {
        const limit = row.cardLimit === null ? null : toMoneyString(row.cardLimit);
        const view = cardView(text, limit);
        dto.card = {
          cutDay: row.cardCutDay,
          payDay: row.cardPayDay,
          limit,
          creditAvailable: view.availableCredit,
          overLimit: view.overLimit,
        };
      }
      return dto;
    });
  };

  const single = async (ctx: AccountsContext, snapshot: Snapshot): Promise<AccountDto> => {
    const [account] = await toDtos(ctx, snapshot);
    if (account === undefined) {
      throw new AppError('INTERNAL_ERROR');
    }
    return account;
  };

  return {
    async create(ctx, input) {
      const initial = signedInitialBalance(input);
      const { created, snapshot } = await uow.run(
        async (repos) => {
          const existing = await repos.accounts.get(input.id);
          if (existing !== null) {
            if (!sameAccount(existing, input, initial)) {
              throw new AppError('IDEMPOTENCY_CONFLICT');
            }
            return { created: false, snapshot: await snapshotOf(repos, ctx.userId, [existing]) };
          }

          const count = await repos.accounts.count();
          assertLimit(count, 'accounts');

          await requireActiveCurrency(repos, input.currencyCode);

          const name = input.name.trim();
          await assertNameFree(repos, name);

          const rule = validateInitialBalance(input.type, toMoneyString(initial));
          if (!rule.ok) {
            throw invalidField('initialBalance', rule.reason);
          }

          await repos.accounts.insert({
            id: input.id,
            type: input.type,
            name,
            currencyCode: input.currencyCode,
            initialBalance: initial,
            initialBalanceDate: input.initialBalanceDate,
            color: input.color,
            icon: input.icon,
            ...cardFieldsOf(input),
            sortOrder: count,
          });
          const account = await repos.accounts.get(input.id);
          if (account === null) {
            throw new AppError('INTERNAL_ERROR');
          }
          return { created: true, snapshot: await snapshotOf(repos, ctx.userId, [account]) };
        },
        { userLock: ctx.userId },
      );
      const [account] = await toDtos(ctx, snapshot);
      if (account === undefined) {
        throw new AppError('INTERNAL_ERROR');
      }
      return { created, account };
    },

    async list(ctx, status) {
      const snapshot = await uow.run(
        async (repos) => snapshotOf(repos, ctx.userId, await repos.accounts.list(status)),
        { userLock: ctx.userId, readOnly: true },
      );
      return toDtos(ctx, snapshot);
    },

    async summary(ctx) {
      // Archived accounts never add up in the current totals (RF-M4-09).
      const snapshot = await uow.run(
        async (repos) => snapshotOf(repos, ctx.userId, await repos.accounts.list('active')),
        { userLock: ctx.userId, readOnly: true },
      );
      const perUnit = await bobPerUnit(ctx, snapshot);
      return netWorth(
        snapshot.rows.map((row) => ({
          type: row.type,
          currencyCode: row.currencyCode,
          balance: toMoneyString(snapshot.balances.get(row.id) ?? row.initialBalance),
        })),
        {
          baseCurrency: snapshot.baseCurrency,
          otherCurrency: otherCurrency(snapshot.baseCurrency),
          bobPerUnit: perUnit,
        },
      );
    },

    async update(ctx, id, input) {
      // The initial balance or any other unknown field is rejected (EC-M4-02).
      const parsed = UpdateAccountInput.safeParse(input);
      if (!parsed.success) {
        throw new AppError('VALIDATION_ERROR', {
          issues: parsed.error.issues.map((issue) => ({
            path: issue.path.map(String).join('.'),
            code: issue.code,
          })),
        });
      }
      const changes = parsed.data;
      const snapshot = await uow.run(
        async (repos) => {
          const [current] = await repos.accounts.lockForUpdate([id]);
          if (current === undefined) {
            throw new AppError('NOT_FOUND');
          }
          const patch: AccountPatch = {};

          if (changes.name !== undefined && changes.name !== current.name) {
            if (current.status === 'active') {
              await assertNameFree(repos, changes.name, id);
            }
            patch.name = changes.name;
          }
          if (changes.color !== undefined) patch.color = changes.color;
          if (changes.icon !== undefined) patch.icon = changes.icon;

          if (changes.currencyCode !== undefined && changes.currencyCode !== current.currencyCode) {
            // RF-M4-06: only an account without movements changes currency.
            if (await repos.accounts.hasEntries(id)) {
              throw new AppError('CURRENCY_LOCKED');
            }
            await requireActiveCurrency(repos, changes.currencyCode);
            patch.currencyCode = changes.currencyCode;
          }

          const type = changes.type ?? current.type;
          if (type !== current.type) {
            const balances = await repos.ledger.balances([id]);
            // Goals arrive in V1.1: no account is dedicated nor has earmarks yet.
            const rule = validateTypeChange({
              from: current.type,
              to: type,
              initialBalance: toMoneyString(current.initialBalance),
              currentBalance: toMoneyString(balances.get(id) ?? current.initialBalance),
              dedicated: false,
              hasEarmarks: false,
            });
            if (!rule.ok) {
              throw new AppError('TYPE_CHANGE_INVALID', { reason: rule.reason });
            }
            patch.type = type;
          }

          if (type !== 'credit_card') {
            // RF-M4-07: an account that stops being a card loses its card fields.
            if (current.type === 'credit_card') {
              patch.cardCutDay = null;
              patch.cardPayDay = null;
              patch.cardLimit = null;
            }
          } else if (changes.card !== undefined) {
            patch.cardCutDay = changes.card.cutDay;
            patch.cardPayDay = changes.card.payDay;
            patch.cardLimit = changes.card.limit === null ? null : new Decimal(changes.card.limit);
          }

          if (Object.keys(patch).length > 0) {
            await repos.accounts.update(id, patch);
          }
          const updated = await repos.accounts.get(id);
          if (updated === null) {
            throw new AppError('INTERNAL_ERROR');
          }
          return snapshotOf(repos, ctx.userId, [updated]);
        },
        { userLock: ctx.userId },
      );
      const [account] = await toDtos(ctx, snapshot);
      if (account === undefined) {
        throw new AppError('INTERNAL_ERROR');
      }
      return account;
    },

    async reorder(ctx, input) {
      await uow.run(
        async (repos) => {
          const owned = [
            ...(await repos.accounts.list('active')),
            ...(await repos.accounts.list('archived')),
          ].map((account) => account.id);
          const wanted = new Set(input.ids);
          const exact =
            wanted.size === input.ids.length &&
            wanted.size === owned.length &&
            owned.every((accountId) => wanted.has(accountId));
          if (!exact) {
            throw invalidField('ids', 'invalid_value');
          }
          await repos.accounts.setOrder(input.ids);
        },
        { userLock: ctx.userId },
      );
    },

    async adjust(ctx, id, input) {
      return uow.run(
        async (repos) => {
          const existing = await repos.ledger.get(input.transactionId);
          if (existing !== null) {
            const sameAdjustment =
              existing.kind === 'adjustment' &&
              existing.entries.every((entry) => entry.accountId === id);
            if (!sameAdjustment) {
              throw new AppError('IDEMPOTENCY_CONFLICT');
            }
            return { created: false, transaction: existing };
          }

          const [account] = await repos.accounts.lockForUpdate([id]);
          if (account === undefined) {
            throw new AppError('NOT_FOUND');
          }
          const real = signedRealBalance(account.type, input.realBalance);
          const balances = await repos.ledger.balances([id]);
          const delta = real.minus(balances.get(id) ?? account.initialBalance);
          if (delta.isZero()) {
            return { created: false, transaction: null };
          }

          const today = todayFor(ctx.timezone, ctx.now);
          await BalanceGuard.apply(repos, ctx.userId, [{ accountId: id, amount: delta }], {
            mode: 'interactive',
            earmarkWithdrawals: (input.earmarkWithdrawals ?? []).map((w) => ({
              goalId: w.goalId,
              accountId: w.accountId,
              amount: new Decimal(w.amount),
            })),
          });
          // RN-04: the adjustment stores the rates of its day like any movement.
          const { rateCurBob, rateUsdBob } = await rates.ratesForMovement(
            repos,
            ctx,
            account.currencyCode,
            today,
          );
          const inserted = await repos.ledger.insertTransaction(
            {
              id: input.transactionId,
              kind: 'adjustment',
              date: today,
              note: input.note ?? null,
              categoryId: null,
              origin: 'manual',
              originId: null,
              parentTransactionId: null,
              recurringRuleId: null,
              recurringLabel: null,
              rateCurBob,
              rateUsdBob,
              declaredRate: null,
            },
            [{ id: uuidv7(), accountId: id, amount: delta }],
          );
          if (!inserted) {
            // The id is taken by a deleted movement or by another user's one (ADR-11).
            throw new AppError('IDEMPOTENCY_CONFLICT');
          }
          await ledgerHooks.afterChange(repos, ctx.userId, {
            dates: [today],
            categoryIds: [],
            accountIds: [id],
          });

          const transaction = await repos.ledger.get(input.transactionId);
          if (transaction === null) {
            throw new AppError('INTERNAL_ERROR');
          }
          return { created: true, transaction };
        },
        { userLock: ctx.userId },
      );
    },

    async archive(ctx, id, input) {
      const snapshot = await uow.run(
        async (repos) => {
          const account = await lockedAccount(repos, id);
          if (account.status === 'active') {
            const balances = await repos.ledger.balances([id]);
            const balance = balances.get(id) ?? account.initialBalance;
            if (!balance.isZero() && !input.confirmNonZero) {
              throw new AppError('ARCHIVE_CONFIRMATION_REQUIRED', {
                balance: toMoneyString(balance),
              });
            }
            await repos.accounts.archive(id);
            await repos.userSettings.clearDefaultAccount(ctx.userId, id);
          }
          return snapshotOf(repos, ctx.userId, [await readBack(repos, id)]);
        },
        { userLock: ctx.userId },
      );
      return single(ctx, snapshot);
    },

    async restore(ctx, id, input) {
      const snapshot = await uow.run(
        async (repos) => {
          const account = await lockedAccount(repos, id);
          if (account.status === 'archived') {
            const name = input.newName?.trim() ?? account.name;
            await assertNameFree(repos, name, id);
            await requireActiveCurrency(repos, account.currencyCode);
            await repos.accounts.restore(id, name);
          }
          return snapshotOf(repos, ctx.userId, [await readBack(repos, id)]);
        },
        { userLock: ctx.userId },
      );
      return single(ctx, snapshot);
    },

    async remove(ctx, id) {
      await uow.run(
        async (repos) => {
          await lockedAccount(repos, id);
          // Entries of deleted movements still count: they may be undone (RF-M4-13).
          if (await repos.accounts.hasEntries(id)) {
            throw new AppError('ACCOUNT_HAS_MOVEMENTS');
          }
          await repos.userSettings.clearDefaultAccount(ctx.userId, id);
          await repos.accounts.remove(id);
        },
        { userLock: ctx.userId },
      );
    },
  };
}
