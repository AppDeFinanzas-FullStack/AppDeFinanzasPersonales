import type { CreateTransactionInput } from '@finanzas/contracts';
import { customRateOn, isFutureFor } from '@finanzas/domain';
import { Decimal } from 'decimal.js';
import { uuidv7 } from 'uuidv7';

import { AppError } from '../errors.js';
import type {
  AccountRow,
  LedgerTransactionDetail,
  Repositories,
} from '../ports/repositories.js';
import type { UnitOfWork } from '../ports/unit-of-work.js';
import { BalanceGuard, type BalanceDelta } from '../shared/balance-guard.js';
import type { LedgerHooks } from '../shared/ledger-hooks.js';
import type { MovementRates, RatesContext, RatesService } from './rates.service.js';

/** A new expense or income (`CreateTransactionInput`, plan §4.6.1). */
export type SimpleTransactionInput = Extract<
  CreateTransactionInput,
  { kind: 'expense' | 'income' }
>;

export interface CreateTransactionResult {
  /** `true` for a new movement (201); `false` for the existing one with the same id and data (200). */
  created: boolean;
  transaction: LedgerTransactionDetail;
  /** The `undo_action(create)` of a new movement; `null` when it already existed. */
  undoToken: string | null;
}

export interface TransactionsService {
  /** Creates an expense or an income, idempotent by the client's id (ADR-11, plan §4.6.2). */
  create(ctx: RatesContext, input: SimpleTransactionInput): Promise<CreateTransactionResult>;
}

export interface TransactionsServiceDeps {
  uow: UnitOfWork;
  rates: RatesService;
  ledgerHooks: LedgerHooks;
}

/** The signed amount of the entry: an expense takes money out of the account (ADR-04). */
function signedAmount(input: SimpleTransactionInput): Decimal {
  const amount = new Decimal(input.amount);
  return input.kind === 'expense' ? amount.negated() : amount;
}

/** `true` when the stored movement is the same one the client sends again (ADR-11). */
function sameMovement(existing: LedgerTransactionDetail, input: SimpleTransactionInput): boolean {
  const entry = existing.entries[0];
  return (
    existing.origin === 'manual' &&
    existing.kind === input.kind &&
    existing.date === input.date &&
    existing.categoryId === input.categoryId &&
    existing.note === (input.note ?? null) &&
    existing.entries.length === 1 &&
    entry !== undefined &&
    entry.accountId === input.accountId &&
    entry.amount.equals(signedAmount(input))
  );
}

async function activeAccount(repos: Repositories, accountId: string): Promise<AccountRow> {
  const account = await repos.accounts.get(accountId);
  if (account === null) {
    throw new AppError('NOT_FOUND');
  }
  if (account.status !== 'active') {
    throw new AppError('ACCOUNT_ARCHIVED');
  }
  return account;
}

async function assertCategory(repos: Repositories, input: SimpleTransactionInput): Promise<void> {
  const category = await repos.categories.get(input.categoryId);
  if (category === null) {
    throw new AppError('NOT_FOUND');
  }
  if (category.status !== 'active') {
    throw new AppError('CATEGORY_ARCHIVED');
  }
  if (category.kind !== input.kind) {
    throw new AppError('CATEGORY_KIND_MISMATCH');
  }
}

/** Creations take the currency `FOR SHARE` so it cannot be deactivated meanwhile (plan §4.3.3). */
async function assertActiveCurrency(repos: Repositories, code: string): Promise<void> {
  const currency = await repos.currencies.lockForShare(code);
  if (currency?.status !== 'active') {
    throw new AppError('CURRENCY_INACTIVE');
  }
}

/** Turns the manual USD value on, with its event, in the caller's transaction (EC-M3-02). */
async function activateManual(
  repos: Repositories,
  ctx: RatesContext,
  value: Decimal,
): Promise<void> {
  await repos.userFxEvents.insert({
    id: uuidv7(),
    kind: 'manual_usd_on',
    currencyCode: 'USD',
    reference: null,
    value,
    effectiveAt: ctx.now,
  });
  await repos.userSettings.setManualUsd(ctx.userId, { value, since: ctx.now });
}

export function createTransactionsService({
  uow,
  rates,
  ledgerHooks,
}: TransactionsServiceDeps): TransactionsService {
  /** The rates the movement stores (RN-04); the USD value the user gave is its rate (EC-M3-02). */
  async function movementRates(
    repos: Repositories,
    ctx: RatesContext,
    currencyCode: string,
    date: string,
    manual: Decimal | null,
  ): Promise<MovementRates> {
    if (manual === null) {
      return rates.ratesForMovement(repos, ctx, currencyCode, date);
    }
    if (currencyCode === 'BOB') {
      return { rateCurBob: new Decimal(1), rateUsdBob: manual };
    }
    if (currencyCode === 'USD') {
      return { rateCurBob: manual, rateUsdBob: manual };
    }
    // An added currency only needs its own rate: the USD rate is the value the user gave.
    const events = await repos.userFxEvents.eventsUntil(ctx.now);
    const rateCurBob = customRateOn(events, currencyCode, date, ctx.timezone);
    if (rateCurBob === null) {
      throw new AppError('RATE_REQUIRED');
    }
    return { rateCurBob, rateUsdBob: manual };
  }

  return {
    async create(ctx, input) {
      return uow.run(
        async (repos) => {
          const existing = await repos.ledger.get(input.id);
          if (existing !== null) {
            if (!sameMovement(existing, input)) {
              throw new AppError('IDEMPOTENCY_CONFLICT');
            }
            return { created: false, transaction: existing, undoToken: null };
          }

          const account = await activeAccount(repos, input.accountId);
          await assertCategory(repos, input);
          if (isFutureFor(input.date, ctx.timezone, ctx.now)) {
            throw new AppError('FUTURE_DATE');
          }
          await assertActiveCurrency(repos, account.currencyCode);

          const manual =
            input.manualUsdRate === undefined ? null : new Decimal(input.manualUsdRate);
          if (manual !== null) {
            await activateManual(repos, ctx, manual);
          }
          const { rateCurBob, rateUsdBob } = await movementRates(
            repos,
            ctx,
            account.currencyCode,
            input.date,
            manual,
          );

          const amount = signedAmount(input);
          // A movement dated before the initial balance does not change the balance (RN-12).
          const deltas: BalanceDelta[] =
            input.date < account.initialBalanceDate ? [] : [{ accountId: account.id, amount }];
          await BalanceGuard.apply(repos, ctx.userId, deltas, { mode: 'interactive' });

          const inserted = await repos.ledger.insertTransaction(
            {
              id: input.id,
              kind: input.kind,
              date: input.date,
              note: input.note ?? null,
              categoryId: input.categoryId,
              origin: 'manual',
              originId: null,
              parentTransactionId: null,
              recurringRuleId: null,
              recurringLabel: null,
              rateCurBob,
              rateUsdBob,
              declaredRate: null,
            },
            [{ id: uuidv7(), accountId: account.id, amount }],
          );
          if (!inserted) {
            // The id is taken by a deleted movement or by another user's one (ADR-11).
            throw new AppError('IDEMPOTENCY_CONFLICT');
          }

          await ledgerHooks.afterChange(repos, ctx.userId, {
            dates: [input.date],
            categoryIds: [input.categoryId],
            accountIds: [account.id],
          });
          const undo = await repos.undoActions.create('create', { transactionIds: [input.id] });

          const transaction = await repos.ledger.get(input.id);
          if (transaction === null) {
            throw new Error('The created transaction could not be read back');
          }
          return { created: true, transaction, undoToken: undo.id };
        },
        { userLock: ctx.userId },
      );
    },
  };
}
