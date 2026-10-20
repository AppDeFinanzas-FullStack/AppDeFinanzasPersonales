import type { AccountDto, CreateAccountInput } from '@finanzas/contracts';
import {
  cardView,
  convert,
  netWorth,
  toMoneyString,
  validateInitialBalance,
  type NetWorthResult,
} from '@finanzas/domain';
import { Decimal } from 'decimal.js';

import { AppError } from '../errors.js';
import type { AccountRow, LifecycleStatus, Repositories } from '../ports/repositories.js';
import type { UnitOfWork } from '../ports/unit-of-work.js';
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
}

export interface AccountsServiceDeps {
  uow: UnitOfWork;
  rates: RatesService;
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
async function assertNameFree(repos: Repositories, name: string): Promise<void> {
  const wanted = name.toLowerCase();
  const active = await repos.accounts.list('active');
  if (active.some((account) => account.name.toLowerCase() === wanted)) {
    throw new AppError('NAME_TAKEN');
  }
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

export function createAccountsService({ uow, rates }: AccountsServiceDeps): AccountsService {
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

          // FOR SHARE keeps the currency from being deactivated meanwhile (plan §4.3.3).
          const currency = await repos.currencies.lockForShare(input.currencyCode);
          if (currency === null) {
            throw invalidField('currencyCode', 'not_found');
          }
          if (currency.status !== 'active') {
            throw new AppError('CURRENCY_INACTIVE');
          }

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
  };
}
