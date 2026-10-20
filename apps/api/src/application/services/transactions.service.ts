import type { CreateTransactionInput } from '@finanzas/contracts';
import { amountInFrom, customRateOn, isFutureFor, rateFromAmounts } from '@finanzas/domain';
import { Decimal } from 'decimal.js';
import { uuidv7 } from 'uuidv7';

import { AppError } from '../errors.js';
import type {
  AccountRow,
  LedgerEntryInput,
  LedgerTransactionDetail,
  Repositories,
} from '../ports/repositories.js';
import type { UnitOfWork } from '../ports/unit-of-work.js';
import { BalanceGuard, type BalanceDelta } from '../shared/balance-guard.js';
import type { LedgerChange, LedgerHooks } from '../shared/ledger-hooks.js';
import type { MovementRates, RatesContext, RatesService } from './rates.service.js';

/** A new expense or income (`CreateTransactionInput`, plan §4.6.1). */
export type SimpleTransactionInput = Extract<
  CreateTransactionInput,
  { kind: 'expense' | 'income' }
>;

/** A new transfer, with its optional fee (`CreateTransactionInput`, plan §4.6.1). */
export type TransferTransactionInput = Extract<CreateTransactionInput, { kind: 'transfer' }>;

export interface CreateTransactionResult {
  /** `true` for a new movement (201); `false` for the existing one with the same id and data (200). */
  created: boolean;
  transaction: LedgerTransactionDetail;
  /** The `undo_action(create)` of a new movement; `null` when it already existed. */
  undoToken: string | null;
}

export interface TransactionsService {
  /**
   * Creates an expense, an income or a transfer with its fee, idempotent by the client's id
   * (ADR-11, plan §4.6.2).
   */
  create(ctx: RatesContext, input: CreateTransactionInput): Promise<CreateTransactionResult>;
}

export interface TransactionsServiceDeps {
  uow: UnitOfWork;
  rates: RatesService;
  ledgerHooks: LedgerHooks;
}

/** The preset category of the fees (plan §4.6.3). */
const FEE_PARENT_NAME = 'Servicios';
const FEE_CATEGORY_NAME = 'Comisiones bancarias';

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

/** `true` when the stored fee is the one the client sends again (ADR-11). */
function sameFee(
  existing: LedgerTransactionDetail,
  input: TransferTransactionInput,
): boolean {
  const fee = input.fee;
  if (fee === undefined) {
    return existing.fee === null;
  }
  const stored = existing.fee;
  const entry = stored?.entries[0];
  return (
    stored !== null &&
    stored.id === fee.id &&
    (fee.categoryId === undefined || stored.categoryId === fee.categoryId) &&
    stored.entries.length === 1 &&
    entry !== undefined &&
    entry.accountId === input.fromAccountId &&
    entry.amount.equals(new Decimal(fee.amount).negated())
  );
}

/** `true` when the stored transfer is the same one the client sends again (ADR-11). */
function sameTransfer(existing: LedgerTransactionDetail, input: TransferTransactionInput): boolean {
  const out = existing.entries.find((entry) => entry.accountId === input.fromAccountId);
  const arrival = existing.entries.find((entry) => entry.accountId === input.toAccountId);
  return (
    existing.origin === 'manual' &&
    existing.kind === 'transfer' &&
    existing.date === input.date &&
    existing.note === (input.note ?? null) &&
    existing.entries.length === 2 &&
    out !== undefined &&
    arrival !== undefined &&
    out.amount.equals(new Decimal(input.amountOut).negated()) &&
    (input.amountIn === undefined || arrival.amount.equals(new Decimal(input.amountIn))) &&
    sameFee(existing, input)
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

/** The category exists for the user, is active and is of the movement's kind. */
async function assertCategory(
  repos: Repositories,
  categoryId: string,
  kind: 'expense' | 'income',
): Promise<void> {
  const category = await repos.categories.get(categoryId);
  if (category === null) {
    throw new AppError('NOT_FOUND');
  }
  if (category.status !== 'active') {
    throw new AppError('CATEGORY_ARCHIVED');
  }
  if (category.kind !== kind) {
    throw new AppError('CATEGORY_KIND_MISMATCH');
  }
}

/**
 * The category of the fee: the one the client chose, else the active "Servicios › Comisiones
 * bancarias". Without it the client must choose another one (`FEE_CATEGORY_REQUIRED`, EC-M6-08).
 */
async function feeCategoryId(repos: Repositories, chosen: string | undefined): Promise<string> {
  if (chosen !== undefined) {
    await assertCategory(repos, chosen, 'expense');
    return chosen;
  }
  const roots = await repos.categories.tree('expense', 'active');
  const preset = roots
    .find((root) => root.name === FEE_PARENT_NAME)
    ?.children.find((child) => child.name === FEE_CATEGORY_NAME);
  if (preset === undefined) {
    throw new AppError('FEE_CATEGORY_REQUIRED');
  }
  return preset.id;
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

/** The delta of an entry, or none when it is dated before the initial balance (RN-12). */
function deltaFor(account: AccountRow, date: string, amount: Decimal): BalanceDelta[] {
  return date < account.initialBalanceDate ? [] : [{ accountId: account.id, amount }];
}

/** How the money crosses currencies in a transfer (RF-M3-08). */
interface TransferAmounts {
  amountIn: Decimal;
  /** `null` between accounts of the same currency. */
  declaredRate: Decimal | null;
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

  /**
   * Amount that arrives and declared rate (RF-M3-07, RF-M3-08): the amount that arrives, when it
   * comes, rules and the rate is recalculated; else the declared rate, or the prefilled one.
   */
  async function transferAmounts(
    repos: Repositories,
    ctx: RatesContext,
    input: TransferTransactionInput,
    from: AccountRow,
    to: AccountRow,
  ): Promise<TransferAmounts> {
    const amountOut = new Decimal(input.amountOut);
    if (from.currencyCode === to.currencyCode) {
      return { amountIn: amountOut, declaredRate: null };
    }
    if (input.amountIn !== undefined) {
      const amountIn = new Decimal(input.amountIn);
      return { amountIn, declaredRate: rateFromAmounts(amountOut, amountIn, from.currencyCode) };
    }
    const declaredRate =
      input.declaredRate === undefined
        ? await rates.transferRate(repos, ctx, from.currencyCode, to.currencyCode, input.date)
        : new Decimal(input.declaredRate);
    if (declaredRate === null) {
      throw new AppError('RATE_REQUIRED');
    }
    return { amountIn: amountInFrom(amountOut, declaredRate, from.currencyCode), declaredRate };
  }

  /**
   * The rates the transfer and its fee store (RN-04), both in the currency of the origin. The
   * declared rate is the historical rate of the movement (RF-M3-09): in BOB↔USD it is the
   * `rate_usd_bob`, and it is the origin's rate whenever the other side is BOB (plan §4.6.1).
   */
  async function transferRates(
    repos: Repositories,
    ctx: RatesContext,
    from: string,
    to: string,
    date: string,
    declaredRate: Decimal | null,
  ): Promise<MovementRates> {
    if (declaredRate === null || (from !== 'BOB' && to !== 'BOB')) {
      return rates.ratesForMovement(repos, ctx, from, date);
    }
    const rateCurBob = from === 'BOB' ? new Decimal(1) : declaredRate;
    if (from === 'USD' || to === 'USD') {
      return { rateCurBob, rateUsdBob: declaredRate };
    }
    const { rateUsdBob } = await rates.ratesForMovement(repos, ctx, 'BOB', date);
    return { rateCurBob, rateUsdBob };
  }

  /** The hooks and the `undo_action(create)` of a new movement, read back with its fee. */
  async function finishCreation(
    repos: Repositories,
    ctx: RatesContext,
    id: string,
    change: LedgerChange,
  ): Promise<CreateTransactionResult> {
    await ledgerHooks.afterChange(repos, ctx.userId, change);
    const undo = await repos.undoActions.create('create', { transactionIds: [id] });

    const transaction = await repos.ledger.get(id);
    if (transaction === null) {
      throw new Error('The created transaction could not be read back');
    }
    return { created: true, transaction, undoToken: undo.id };
  }

  async function createSimple(
    repos: Repositories,
    ctx: RatesContext,
    input: SimpleTransactionInput,
  ): Promise<CreateTransactionResult> {
    const existing = await repos.ledger.get(input.id);
    if (existing !== null) {
      if (!sameMovement(existing, input)) {
        throw new AppError('IDEMPOTENCY_CONFLICT');
      }
      return { created: false, transaction: existing, undoToken: null };
    }

    const account = await activeAccount(repos, input.accountId);
    await assertCategory(repos, input.categoryId, input.kind);
    if (isFutureFor(input.date, ctx.timezone, ctx.now)) {
      throw new AppError('FUTURE_DATE');
    }
    await assertActiveCurrency(repos, account.currencyCode);

    const manual = input.manualUsdRate === undefined ? null : new Decimal(input.manualUsdRate);
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
    await BalanceGuard.apply(repos, ctx.userId, deltaFor(account, input.date, amount), {
      mode: 'interactive',
    });

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

    return finishCreation(repos, ctx, input.id, {
      dates: [input.date],
      categoryIds: [input.categoryId],
      accountIds: [account.id],
    });
  }

  async function createTransfer(
    repos: Repositories,
    ctx: RatesContext,
    input: TransferTransactionInput,
  ): Promise<CreateTransactionResult> {
    const existing = await repos.ledger.get(input.id);
    if (existing !== null) {
      if (!sameTransfer(existing, input)) {
        throw new AppError('IDEMPOTENCY_CONFLICT');
      }
      return { created: false, transaction: existing, undoToken: null };
    }

    // The origin and the destination are active accounts of the user and distinct (RF-M6-04).
    if (input.fromAccountId === input.toAccountId) {
      throw new AppError('VALIDATION_ERROR', {
        issues: [{ path: 'toAccountId', code: 'SAME_ACCOUNT' }],
      });
    }
    const from = await activeAccount(repos, input.fromAccountId);
    const to = await activeAccount(repos, input.toAccountId);
    if (isFutureFor(input.date, ctx.timezone, ctx.now)) {
      throw new AppError('FUTURE_DATE');
    }
    await assertActiveCurrency(repos, from.currencyCode);
    if (to.currencyCode !== from.currencyCode) {
      await assertActiveCurrency(repos, to.currencyCode);
    }
    const fee =
      input.fee === undefined
        ? null
        : {
            id: input.fee.id,
            amount: new Decimal(input.fee.amount).negated(),
            categoryId: await feeCategoryId(repos, input.fee.categoryId),
          };

    const { amountIn, declaredRate } = await transferAmounts(repos, ctx, input, from, to);
    const { rateCurBob, rateUsdBob } = await transferRates(
      repos,
      ctx,
      from.currencyCode,
      to.currencyCode,
      input.date,
      declaredRate,
    );

    const amountOut = new Decimal(input.amountOut).negated();
    // The amount and the fee are checked together against the negative block (RF-M6-05).
    const deltas: BalanceDelta[] = [
      ...deltaFor(from, input.date, amountOut),
      ...deltaFor(to, input.date, amountIn),
      ...(fee === null ? [] : deltaFor(from, input.date, fee.amount)),
    ];
    await BalanceGuard.apply(repos, ctx.userId, deltas, { mode: 'interactive' });

    const entries: LedgerEntryInput[] = [
      { id: uuidv7(), accountId: from.id, amount: amountOut },
      { id: uuidv7(), accountId: to.id, amount: amountIn },
    ];
    const inserted = await repos.ledger.insertTransaction(
      {
        id: input.id,
        kind: 'transfer',
        date: input.date,
        note: input.note ?? null,
        categoryId: null,
        origin: 'manual',
        originId: null,
        parentTransactionId: null,
        recurringRuleId: null,
        recurringLabel: null,
        rateCurBob,
        rateUsdBob,
        declaredRate,
      },
      entries,
    );
    if (!inserted) {
      throw new AppError('IDEMPOTENCY_CONFLICT');
    }

    if (fee !== null) {
      // The fee is an expense of the origin linked to the transfer (RF-M6-05, plan §4.6.3).
      const feeInserted = await repos.ledger.insertTransaction(
        {
          id: fee.id,
          kind: 'expense',
          date: input.date,
          note: null,
          categoryId: fee.categoryId,
          origin: 'fee',
          originId: null,
          parentTransactionId: input.id,
          recurringRuleId: null,
          recurringLabel: null,
          rateCurBob,
          rateUsdBob,
          declaredRate: null,
        },
        [{ id: uuidv7(), accountId: from.id, amount: fee.amount }],
      );
      if (!feeInserted) {
        throw new AppError('IDEMPOTENCY_CONFLICT');
      }
    }

    return finishCreation(repos, ctx, input.id, {
      dates: [input.date],
      categoryIds: fee === null ? [] : [fee.categoryId],
      accountIds: [from.id, to.id],
    });
  }

  return {
    async create(ctx, input) {
      return uow.run(
        (repos) =>
          input.kind === 'transfer'
            ? createTransfer(repos, ctx, input)
            : createSimple(repos, ctx, input),
        { userLock: ctx.userId },
      );
    },
  };
}
