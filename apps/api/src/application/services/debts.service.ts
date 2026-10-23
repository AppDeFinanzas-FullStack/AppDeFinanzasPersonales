import type {
  CreateDebtInput,
  DebtDto,
  DebtsSummaryDto,
  PaymentInput,
} from '@finanzas/contracts';
import {
  accrue,
  amountInFrom,
  dailyRate,
  deriveStatus,
  isFutureFor,
  round2,
  todayFor,
  toMoneyString,
  type LocalDate,
} from '@finanzas/domain';
import { Decimal } from 'decimal.js';
import { uuidv7 } from 'uuidv7';

import { AppError } from '../errors.js';
import type {
  AccountRow,
  CategoryKind,
  DebtPaymentRow,
  DebtRow,
  Repositories,
} from '../ports/repositories.js';
import type { UnitOfWork } from '../ports/unit-of-work.js';
import { BalanceGuard, type BalanceDelta } from '../shared/balance-guard.js';
import type { LedgerHooks } from '../shared/ledger-hooks.js';
import { assertLimit } from '../shared/limits.js';
import type { MovementRates, RatesContext, RatesService } from './rates.service.js';

export type DebtsContext = RatesContext;

export type DebtsView = 'debt' | 'person';

export interface DebtsListResult {
  debts: DebtDto[];
  summary: DebtsSummaryDto;
}

export interface DebtsService {
  /** Creates a debt, idempotent by `input.id` (ADR-11), with its optional initial movement. */
  create(ctx: DebtsContext, input: CreateDebtInput): Promise<{ created: boolean; debt: DebtDto }>;
  /** The user's debts with the interest carried to today without writing, and the summary. */
  list(ctx: DebtsContext, view: DebtsView): Promise<DebtsListResult>;
  /** Registers a payment on the debt, idempotent by `input.id` (ADR-11, plan §4.13.3). */
  pay(
    ctx: DebtsContext,
    debtId: string,
    input: PaymentInput,
  ): Promise<{ created: boolean; debt: DebtDto }>;
}

export interface DebtsServiceDeps {
  uow: UnitOfWork;
  rates: Pick<RatesService, 'currentRateFor' | 'ratesForMovement' | 'transferRate'>;
  ledgerHooks: LedgerHooks;
}

/** What is stored for one debt at the moment of reading it. */
interface DebtSnapshot {
  debt: DebtRow;
  payments: DebtPaymentRow[];
}

function invalidField(path: string, code: string): AppError {
  return new AppError('VALIDATION_ERROR', { issues: [{ path, code }] });
}

/** Creations take the currency `FOR SHARE` so it cannot be deactivated meanwhile (plan §4.3.3). */
async function requireActiveCurrency(repos: Repositories, code: string): Promise<void> {
  const currency = await repos.currencies.lockForShare(code);
  if (currency === null) {
    throw invalidField('currencyCode', 'not_found');
  }
  if (currency.status !== 'active') {
    throw new AppError('CURRENCY_INACTIVE');
  }
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

/** The system category "Deudas y préstamos" of that kind: the system root of its tree. */
async function debtsCategoryId(repos: Repositories, kind: CategoryKind): Promise<string> {
  const root = (await repos.categories.tree(kind, 'active')).find((node) => node.isSystem);
  if (root === undefined) {
    throw new AppError('INTERNAL_ERROR');
  }
  return root.id;
}

/** The system category "Intereses" of that kind: the system child of "Deudas y préstamos". */
async function interestCategoryId(repos: Repositories, kind: CategoryKind): Promise<string> {
  const root = (await repos.categories.tree(kind, 'active')).find((node) => node.isSystem);
  const child = root?.children.find((node) => node.isSystem);
  if (child === undefined) {
    throw new AppError('INTERNAL_ERROR');
  }
  return child.id;
}

function splitInvalid(reason: string): AppError {
  return new AppError('SPLIT_INVALID', { reason });
}

/** `true` when the stored payment is the same one the client sends again (ADR-11). */
function samePayment(row: DebtPaymentRow, input: PaymentInput): boolean {
  return (
    row.amount.equals(new Decimal(input.amount)) &&
    row.interestPart.equals(new Decimal(input.interestPart)) &&
    row.capitalPart.equals(new Decimal(input.capitalPart)) &&
    row.date === input.date &&
    row.accountId === (input.account?.accountId ?? null)
  );
}

/** `true` when the stored debt is the same one the client sends again (ADR-11). */
function sameDebt(row: DebtRow, input: CreateDebtInput): boolean {
  const rate = input.interest === undefined ? null : new Decimal(input.interest.rate);
  return (
    row.direction === input.direction &&
    row.person === input.person.trim() &&
    row.principal.equals(new Decimal(input.principal)) &&
    row.currencyCode === input.currencyCode &&
    row.startDate === input.startDate &&
    row.dueDate === (input.dueDate ?? null) &&
    row.note === (input.note ?? null) &&
    (rate === null ? row.interestRate === null : row.interestRate?.equals(rate) === true) &&
    row.interestPeriod === (input.interest?.period ?? null) &&
    row.initialTransactionId === (input.initialMovement?.transactionId ?? null)
  );
}

/** Unpaid interest carried to `today` without writing it (RF-M13-02, ADR-14). */
function interestToday(debt: DebtRow, today: LocalDate): Decimal {
  if (debt.status !== 'active' || debt.interestRate === null || debt.interestPeriod === null) {
    return debt.interestUnpaid;
  }
  const rate = dailyRate(debt.interestRate, debt.interestPeriod);
  return accrue(debt.capitalOutstanding, debt.interestUnpaid, rate, debt.accruedThrough, today);
}

function toDto(snapshot: DebtSnapshot, today: LocalDate): DebtDto {
  const { debt, payments } = snapshot;
  const interest = interestToday(debt, today);
  const interestAccrued = round2(interest);
  const dto: DebtDto = {
    id: debt.id,
    direction: debt.direction,
    person: debt.person,
    principal: toMoneyString(debt.principal),
    currencyCode: debt.currencyCode,
    startDate: debt.startDate,
    status: deriveStatus(
      {
        capitalOutstanding: debt.capitalOutstanding,
        interestUnpaid: interest,
        dueDate: debt.dueDate,
        forgiven: debt.status === 'forgiven',
      },
      today,
    ),
    capitalOutstanding: toMoneyString(debt.capitalOutstanding),
    interestAccrued: toMoneyString(interestAccrued),
    pending: toMoneyString(debt.capitalOutstanding.plus(interestAccrued)),
    payments: payments.map((payment) => ({
      id: payment.id,
      amount: toMoneyString(payment.amount),
      interestPart: toMoneyString(payment.interestPart),
      capitalPart: toMoneyString(payment.capitalPart),
      date: payment.date,
      ...(payment.note === null ? {} : { note: payment.note }),
    })),
    canDeleteLastPayment: payments.length > 0 && debt.status !== 'forgiven',
  };
  if (debt.dueDate !== null) dto.dueDate = debt.dueDate;
  if (debt.interestRate !== null && debt.interestPeriod !== null) {
    dto.interest = { rate: debt.interestRate.toString(), period: debt.interestPeriod };
  }
  if (debt.forgivenAmount !== null) dto.forgivenAmount = toMoneyString(debt.forgivenAmount);
  return dto;
}

async function snapshotOf(repos: Repositories, debt: DebtRow): Promise<DebtSnapshot> {
  return { debt, payments: await repos.debtPayments.list(debt.id) };
}

/** What the linked transactions of a payment moved in its account (RF-M13-09). */
interface PaymentMovements {
  declaredRate: Decimal | null;
  accountAmount: Decimal;
  capitalTransactionId: string | null;
  interestTransactionId: string | null;
}

/**
 * Checks a payment against the debt with its interest carried to today (RF-M13-05, RF-M13-06,
 * RF-M13-07, EC-M13-01).
 */
function assertPayment(
  ctx: DebtsContext,
  debt: DebtRow,
  interestUnpaid: Decimal,
  input: PaymentInput,
): void {
  if (input.date < debt.startDate) {
    throw splitInvalid('date_before_start');
  }
  if (isFutureFor(input.date, ctx.timezone, ctx.now)) {
    throw new AppError('FUTURE_DATE');
  }
  const interestAccrued = round2(interestUnpaid);
  const pending = debt.capitalOutstanding.plus(interestAccrued);
  const amount = new Decimal(input.amount);
  const interestPart = new Decimal(input.interestPart);
  const capitalPart = new Decimal(input.capitalPart);
  if (amount.greaterThan(pending)) {
    throw new AppError('PAYMENT_EXCEEDS_BALANCE', { pending: toMoneyString(pending) });
  }
  if (interestPart.lessThan(0) || capitalPart.lessThan(0)) {
    throw splitInvalid('negative_part');
  }
  if (interestPart.greaterThan(interestAccrued)) {
    throw splitInvalid('interest_exceeds_accrued');
  }
  if (capitalPart.greaterThan(debt.capitalOutstanding)) {
    throw splitInvalid('capital_exceeds_outstanding');
  }
  if (!interestPart.plus(capitalPart).equals(amount)) {
    throw splitInvalid('parts_mismatch');
  }
}

/** The delta of an entry, or none when it is dated before the initial balance (RN-12). */
function deltaFor(account: AccountRow, date: LocalDate, amount: Decimal): BalanceDelta[] {
  return date < account.initialBalanceDate ? [] : [{ accountId: account.id, amount }];
}

export function createDebtsService({ uow, rates, ledgerHooks }: DebtsServiceDeps): DebtsService {
  /**
   * The rates the initial movement stores, in the currency of the account (RN-04). The declared
   * rate follows plan §4.6.1: in BOB↔USD it is the `rate_usd_bob` (RF-M13-09).
   */
  async function movementRates(
    repos: Repositories,
    ctx: DebtsContext,
    debtCurrency: string,
    accountCurrency: string,
    date: LocalDate,
    declaredRate: Decimal | null,
  ): Promise<MovementRates> {
    if (declaredRate === null || (debtCurrency !== 'BOB' && accountCurrency !== 'BOB')) {
      return rates.ratesForMovement(repos, ctx, accountCurrency, date);
    }
    const rateCurBob = accountCurrency === 'BOB' ? new Decimal(1) : declaredRate;
    if (debtCurrency === 'USD' || accountCurrency === 'USD') {
      return { rateCurBob, rateUsdBob: declaredRate };
    }
    const { rateUsdBob } = await rates.ratesForMovement(repos, ctx, 'BOB', date);
    return { rateCurBob, rateUsdBob };
  }

  /**
   * The rate between the debt's currency and the account's: the declared one, or the one prefilled
   * as in RF-M3-07 (RF-M13-09). `null` when both currencies are the same.
   */
  async function declaredRateFor(
    repos: Repositories,
    ctx: DebtsContext,
    debtCurrency: string,
    accountCurrency: string,
    date: LocalDate,
    declared: string | undefined,
  ): Promise<Decimal | null> {
    if (accountCurrency === debtCurrency) {
      return null;
    }
    const rate =
      declared === undefined
        ? await rates.transferRate(repos, ctx, debtCurrency, accountCurrency, date)
        : new Decimal(declared);
    if (rate === null) {
      throw new AppError('RATE_REQUIRED');
    }
    return rate;
  }

  /**
   * The initial movement (RF-M13-08, RF-M13-09): an income if "Debo", an expense if "Me deben", in
   * the system category, with the amount converted to the account's currency by the declared rate.
   */
  async function createInitialMovement(
    repos: Repositories,
    ctx: DebtsContext,
    input: CreateDebtInput,
    movement: NonNullable<CreateDebtInput['initialMovement']>,
  ): Promise<void> {
    const account = await activeAccount(repos, movement.accountId);
    if (account.currencyCode !== input.currencyCode) {
      await requireActiveCurrency(repos, account.currencyCode);
    }
    const principal = new Decimal(input.principal);
    const declaredRate = await declaredRateFor(
      repos,
      ctx,
      input.currencyCode,
      account.currencyCode,
      input.startDate,
      movement.declaredRate,
    );
    const amount =
      declaredRate === null ? principal : amountInFrom(principal, declaredRate, input.currencyCode);
    const { rateCurBob, rateUsdBob } = await movementRates(
      repos,
      ctx,
      input.currencyCode,
      account.currencyCode,
      input.startDate,
      declaredRate,
    );

    const kind = input.direction === 'i_owe' ? 'income' : 'expense';
    const signed = kind === 'income' ? amount : amount.negated();
    const categoryId = await debtsCategoryId(repos, kind);
    await BalanceGuard.apply(repos, ctx.userId, deltaFor(account, input.startDate, signed), {
      mode: 'interactive',
    });

    const inserted = await repos.ledger.insertTransaction(
      {
        id: movement.transactionId,
        kind,
        date: input.startDate,
        note: null,
        categoryId,
        origin: 'debt_initial',
        originId: input.id,
        parentTransactionId: null,
        recurringRuleId: null,
        recurringLabel: null,
        rateCurBob,
        rateUsdBob,
        // Only a transfer stores `declared_rate`; here it lives in the stored rates (plan §4.6.1).
        declaredRate: null,
      },
      [{ id: uuidv7(), accountId: account.id, amount: signed }],
    );
    if (!inserted) {
      throw new AppError('IDEMPOTENCY_CONFLICT');
    }
    await ledgerHooks.afterChange(repos, ctx.userId, {
      dates: [input.startDate],
      categoryIds: [categoryId],
      accountIds: [account.id],
    });
  }

  /**
   * The linked transactions of a payment (RF-M13-08, RF-M13-09): capital in "Deudas y préstamos"
   * and interest in "Intereses", expenses if "Debo" and incomes if "Me deben". The whole amount is
   * converted once and the capital takes what the interest leaves, so no rounding residue remains.
   * A part of zero creates no transaction.
   */
  async function createPaymentMovements(
    repos: Repositories,
    ctx: DebtsContext,
    debt: DebtRow,
    input: PaymentInput,
    link: NonNullable<PaymentInput['account']>,
  ): Promise<PaymentMovements> {
    const account = await activeAccount(repos, link.accountId);
    if (account.currencyCode !== debt.currencyCode) {
      await requireActiveCurrency(repos, account.currencyCode);
    }
    const declaredRate = await declaredRateFor(
      repos,
      ctx,
      debt.currencyCode,
      account.currencyCode,
      input.date,
      link.declaredRate,
    );
    const toAccount = (value: Decimal): Decimal =>
      declaredRate === null ? value : amountInFrom(value, declaredRate, debt.currencyCode);
    const accountAmount = toAccount(new Decimal(input.amount));
    const interestAmount = toAccount(new Decimal(input.interestPart));
    const capitalAmount = accountAmount.minus(interestAmount);
    const { rateCurBob, rateUsdBob } = await movementRates(
      repos,
      ctx,
      debt.currencyCode,
      account.currencyCode,
      input.date,
      declaredRate,
    );

    const kind: CategoryKind = debt.direction === 'i_owe' ? 'expense' : 'income';
    const sign = (value: Decimal): Decimal => (kind === 'income' ? value : value.negated());
    const parts = [
      {
        id: link.capitalTransactionId,
        amount: capitalAmount,
        categoryId: await debtsCategoryId(repos, kind),
      },
      {
        id: link.interestTransactionId,
        amount: interestAmount,
        categoryId: await interestCategoryId(repos, kind),
      },
    ].filter((part) => !part.amount.isZero());

    await BalanceGuard.apply(
      repos,
      ctx.userId,
      parts.flatMap((part) => deltaFor(account, input.date, sign(part.amount))),
      {
        mode: 'interactive',
        earmarkWithdrawals: (input.earmarkWithdrawals ?? []).map((withdrawal) => ({
          goalId: withdrawal.goalId,
          accountId: withdrawal.accountId,
          amount: new Decimal(withdrawal.amount),
        })),
      },
    );

    for (const part of parts) {
      const inserted = await repos.ledger.insertTransaction(
        {
          id: part.id,
          kind,
          date: input.date,
          note: null,
          categoryId: part.categoryId,
          origin: 'debt_payment',
          originId: input.id,
          parentTransactionId: null,
          recurringRuleId: null,
          recurringLabel: null,
          rateCurBob,
          rateUsdBob,
          // Only a transfer stores `declared_rate`; here it lives in the stored rates (plan §4.6.1).
          declaredRate: null,
        },
        [{ id: uuidv7(), accountId: account.id, amount: sign(part.amount) }],
      );
      if (!inserted) {
        throw new AppError('IDEMPOTENCY_CONFLICT');
      }
    }
    if (parts.length > 0) {
      await ledgerHooks.afterChange(repos, ctx.userId, {
        dates: [input.date],
        categoryIds: parts.map((part) => part.categoryId),
        accountIds: [account.id],
      });
    }
    const createdIds = new Set(parts.map((part) => part.id));
    const createdOrNull = (id: string): string | null => (createdIds.has(id) ? id : null);
    return {
      declaredRate,
      accountAmount,
      capitalTransactionId: createdOrNull(link.capitalTransactionId),
      interestTransactionId: createdOrNull(link.interestTransactionId),
    };
  }

  /** Converts an amount to the base currency with the current reference (RF-M13-13). */
  async function toBase(
    ctx: DebtsContext,
    base: string,
    amounts: { currencyCode: string; amount: Decimal }[],
  ): Promise<Decimal[]> {
    const bobPerUnit = new Map<string, Decimal | null>();
    const rateOf = async (code: string): Promise<Decimal | null> => {
      if (!bobPerUnit.has(code)) {
        bobPerUnit.set(code, await rates.currentRateFor(ctx, code));
      }
      return bobPerUnit.get(code) ?? null;
    };
    const baseRate = await rateOf(base);
    const result: Decimal[] = [];
    for (const { currencyCode, amount } of amounts) {
      if (currencyCode === base) {
        result.push(round2(amount));
        continue;
      }
      const rate = await rateOf(currencyCode);
      result.push(
        rate === null || baseRate === null || baseRate.isZero()
          ? new Decimal(0)
          : round2(amount.times(rate).div(baseRate)),
      );
    }
    return result;
  }

  async function summaryOf(
    ctx: DebtsContext,
    base: string,
    debts: DebtRow[],
    dtos: DebtDto[],
    view: DebtsView,
  ): Promise<DebtsSummaryDto> {
    const open = debts
      .map((debt, index) => ({ debt, dto: dtos[index] }))
      .filter(
        (item): item is { debt: DebtRow; dto: DebtDto } =>
          item.dto !== undefined && item.debt.status === 'active',
      );
    const values = await toBase(
      ctx,
      base,
      open.map(({ dto }) => ({ currencyCode: dto.currencyCode, amount: new Decimal(dto.pending) })),
    );

    let iOwe = new Decimal(0);
    let owedToMe = new Decimal(0);
    const people = new Map<string, { person: string; net: Decimal }>();
    open.forEach(({ debt }, index) => {
      const value = values[index] ?? new Decimal(0);
      if (debt.direction === 'i_owe') {
        iOwe = iOwe.plus(value);
      } else {
        owedToMe = owedToMe.plus(value);
      }
      const signed = debt.direction === 'i_owe' ? value.negated() : value;
      const entry = people.get(debt.personKey);
      people.set(debt.personKey, {
        person: entry?.person ?? debt.person,
        net: (entry?.net ?? new Decimal(0)).plus(signed),
      });
    });

    const summary: DebtsSummaryDto = {
      iOwe: toMoneyString(iOwe),
      owedToMe: toMoneyString(owedToMe),
    };
    if (view === 'person') {
      summary.byPerson = [...people].map(([personKey, { person, net }]) => ({
        personKey,
        person,
        net: toMoneyString(net),
      }));
    }
    return summary;
  }

  return {
    async create(ctx, input) {
      const { created, snapshot } = await uow.run(
        async (repos) => {
          const existing = await repos.debts.get(input.id);
          if (existing !== null) {
            if (!sameDebt(existing, input)) {
              throw new AppError('IDEMPOTENCY_CONFLICT');
            }
            return { created: false, snapshot: await snapshotOf(repos, existing) };
          }

          assertLimit((await repos.debts.list()).length, 'debts');
          if (isFutureFor(input.startDate, ctx.timezone, ctx.now)) {
            throw new AppError('FUTURE_DATE');
          }
          await requireActiveCurrency(repos, input.currencyCode);
          if (input.initialMovement !== undefined) {
            await createInitialMovement(repos, ctx, input, input.initialMovement);
          }

          const principal = new Decimal(input.principal);
          await repos.debts.insert({
            id: input.id,
            direction: input.direction,
            person: input.person.trim(),
            principal,
            currencyCode: input.currencyCode,
            startDate: input.startDate,
            dueDate: input.dueDate ?? null,
            note: input.note ?? null,
            interestRate: input.interest === undefined ? null : new Decimal(input.interest.rate),
            interestPeriod: input.interest?.period ?? null,
            initialTransactionId: input.initialMovement?.transactionId ?? null,
            capitalOutstanding: principal,
            accruedThrough: input.startDate,
          });
          const debt = await repos.debts.get(input.id);
          if (debt === null) {
            throw new AppError('INTERNAL_ERROR');
          }
          return { created: true, snapshot: await snapshotOf(repos, debt) };
        },
        { userLock: ctx.userId },
      );
      return { created, debt: toDto(snapshot, todayFor(ctx.timezone, ctx.now)) };
    },

    async list(ctx, view) {
      const { snapshots, base } = await uow.run(
        async (repos) => {
          const settings = await repos.userSettings.fxSettings(ctx.userId);
          if (settings === null) {
            throw new AppError('SESSION_EXPIRED');
          }
          const result: DebtSnapshot[] = [];
          for (const debt of await repos.debts.list()) {
            result.push(await snapshotOf(repos, debt));
          }
          return { snapshots: result, base: settings.baseCurrency };
        },
        { userLock: ctx.userId, readOnly: true },
      );
      const today = todayFor(ctx.timezone, ctx.now);
      const debts = snapshots.map((snapshot) => toDto(snapshot, today));
      const summary = await summaryOf(
        ctx,
        base,
        snapshots.map(({ debt }) => debt),
        debts,
        view,
      );
      return { debts, summary };
    },

    async pay(ctx, debtId, input) {
      const { created, snapshot } = await uow.run(
        async (repos) => {
          const debt = await repos.debts.lockForUpdate(debtId);
          if (debt === null) {
            throw new AppError('NOT_FOUND');
          }
          const existing = (await repos.debtPayments.list(debt.id)).find(
            (payment) => payment.id === input.id,
          );
          if (existing !== undefined) {
            if (!samePayment(existing, input)) {
              throw new AppError('IDEMPOTENCY_CONFLICT');
            }
            return { created: false, snapshot: await snapshotOf(repos, debt) };
          }
          if (debt.status !== 'active') {
            throw new AppError('DEBT_CLOSED');
          }

          // The interest is carried to today first, so what accrued is never recalculated (ADR-14).
          const today = todayFor(ctx.timezone, ctx.now);
          const interestUnpaid = interestToday(debt, today);
          assertPayment(ctx, debt, interestUnpaid, input);

          const movements =
            input.account === undefined
              ? null
              : await createPaymentMovements(repos, ctx, debt, input, input.account);

          const interestPart = new Decimal(input.interestPart);
          const capitalPart = new Decimal(input.capitalPart);
          const capitalOutstanding = debt.capitalOutstanding.minus(capitalPart);
          const remaining = interestUnpaid.minus(interestPart);
          // Below half a cent is what the rounded interest already covered: it is never negative.
          const interestLeft = round2(remaining).lessThanOrEqualTo(0) ? new Decimal(0) : remaining;
          const paid = capitalOutstanding.isZero() && interestLeft.isZero();

          await repos.debtPayments.insert({
            id: input.id,
            debtId: debt.id,
            amount: new Decimal(input.amount),
            interestPart,
            capitalPart,
            date: input.date,
            accountId: input.account?.accountId ?? null,
            declaredRate: movements?.declaredRate ?? null,
            accountAmount: movements?.accountAmount ?? null,
            capitalTransactionId: movements?.capitalTransactionId ?? null,
            interestTransactionId: movements?.interestTransactionId ?? null,
            note: input.note ?? null,
          });
          await repos.debts.update(debt.id, {
            capitalOutstanding,
            interestUnpaid: interestLeft,
            accruedThrough: today,
            ...(paid ? { status: 'paid' as const } : {}),
          });
          const updated = await repos.debts.get(debt.id);
          if (updated === null) {
            throw new AppError('INTERNAL_ERROR');
          }
          return { created: true, snapshot: await snapshotOf(repos, updated) };
        },
        { userLock: ctx.userId },
      );
      return { created, debt: toDto(snapshot, todayFor(ctx.timezone, ctx.now)) };
    },
  };
}
