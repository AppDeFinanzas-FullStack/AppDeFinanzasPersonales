import {
  Amount,
  type BatchDeleteInput,
  type BatchRecategorizeInput,
  type CreateTransactionInput,
  type EarmarkWithdrawals,
  type ListQuery,
  type UpdateTransactionInput,
} from '@finanzas/contracts';
import {
  amountInFrom,
  customRateOn,
  isFutureFor,
  monthRange,
  rateFromAmounts,
  todayFor,
  type FxEvent,
} from '@finanzas/domain';
import { Decimal } from 'decimal.js';
import { uuidv7 } from 'uuidv7';

import { AppError } from '../errors.js';
import type {
  AccountRow,
  LedgerEntryChange,
  LedgerEntryInput,
  LedgerEntryView,
  LedgerGetOptions,
  LedgerListFilters,
  LedgerPage,
  LedgerTotals,
  LedgerTransactionChanges,
  LedgerTransactionDetail,
  LedgerTransactionView,
  Repositories,
  TransactionKind,
  TransactionOrigin,
  UndoAction,
} from '../ports/repositories.js';
import type { UnitOfWork } from '../ports/unit-of-work.js';
import { BalanceGuard, type BalanceDelta, type BalanceGuardOptions } from '../shared/balance-guard.js';
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
  transaction: DescribedTransactionDetail;
  /** The `undo_action(create)` of a new movement; `null` when it already existed. */
  undoToken: string | null;
}

/** A creation before its movement is described for the answer. */
type CreatedMovement = Omit<CreateTransactionResult, 'transaction'> & {
  transaction: LedgerTransactionDetail;
};

export interface DeleteTransactionResult {
  /** The `undo_action(delete)` that restores the movement with its fee (ADR-07). */
  undoToken: string;
}

/** The payload of an `undo_action(create)` or `undo_action(delete)`: the movements it touched. */
export interface UndoMovementsPayload {
  transactionIds: string[];
}

/** The category a movement had before a recategorization. */
export interface PreviousCategory {
  transactionId: string;
  categoryId: string;
}

/** The payload of an `undo_action(recategorize)`: the categories it replaced (plan §3.5). */
export interface UndoRecategorizePayload {
  categories: PreviousCategory[];
}

/** The outcome of a batch action over the selected movements (RF-M6-13). */
export interface BatchResult {
  /** Selected movements the action was applied to. */
  processed: number;
  /** Selected movements left out: linked, of a kind it does not apply to or blocked (RF-M6-13). */
  skipped: number;
  /** The single `undo_action` of the batch; `null` when nothing changed. */
  undoToken: string | null;
}

/** A movement as the answers show it (`TransactionDto`, plan §4.6.1). */
export interface DescribedTransaction extends LedgerTransactionView {
  /**
   * Its signed amount in the base currency, with the rates it stored or, for a base it did not
   * store, the user's rate on its date (RN-04); for a transfer, what leaves the origin account.
   * `null` when there is no rate to convert it (EC-M3-02).
   */
  amountInBase: Decimal | null;
  /** Dated before the initial balance of one of its accounts, so it does not change it (RN-12). */
  beforeInitialBalance: boolean;
  /** Linked to a debt, a goal or a transfer: its amount, account and date are locked (RF-M6-09). */
  linkedLocked: boolean;
  /** Its category with the name; `null` for transfers and adjustments. */
  category: { id: string; name: string } | null;
}

/** A movement with its fee, as the answers show it (RF-M6-05). */
export interface DescribedTransactionDetail extends DescribedTransaction {
  fee: DescribedTransaction | null;
}

/** A page of the movement list (RF-M6-02, RF-M6-12). */
export interface TransactionListPage extends Omit<LedgerPage, 'items'> {
  items: DescribedTransaction[];
}

export interface TransactionsService {
  /**
   * Creates an expense, an income or a transfer with its fee, idempotent by the client's id
   * (ADR-11, plan §4.6.2).
   */
  create(ctx: RatesContext, input: CreateTransactionInput): Promise<CreateTransactionResult>;
  /**
   * Edits the user's movement in place, with its fee: the last edit wins and no history is kept
   * (EC-M6-01, RNF-24, plan §4.6.2).
   */
  update(
    ctx: RatesContext,
    id: string,
    input: UpdateTransactionInput,
  ): Promise<DescribedTransactionDetail>;
  /**
   * The user's movement with its fee and its origin for "Ir a…"; another user's or a deleted one
   * gives `NOT_FOUND` (RNF-09, RNF-14, plan §4.6.2).
   */
  get(ctx: RatesContext, id: string): Promise<DescribedTransactionDetail>;
  /**
   * Deletes the user's movement with its fee (EC-M6-05); it can be undone with the returned token
   * until it expires (plan §4.6.2, §4.6.3).
   */
  delete(
    ctx: RatesContext,
    id: string,
    options?: WithdrawalOptions,
  ): Promise<DeleteTransactionResult>;
  /**
   * Consumes the single-use token and reverts its action: a deletion is restored, a creation is
   * deleted and a recategorization gets its categories back (plan §4.6.2).
   */
  undo(ctx: RatesContext, undoToken: string, options?: WithdrawalOptions): Promise<void>;
  /**
   * Deletes the selected movements with their fees, leaving out the linked ones and those that
   * would leave an account below zero; one `undo` restores them all (RF-M6-13, plan §4.6.2).
   */
  batchDelete(ctx: RatesContext, input: BatchDeleteInput): Promise<BatchResult>;
  /**
   * Moves the selected expenses or incomes to the category, leaving out transfers, adjustments
   * and the linked ones in a system category; one `undo` restores them all (RF-M6-13).
   */
  batchRecategorize(ctx: RatesContext, input: BatchRecategorizeInput): Promise<BatchResult>;
  /**
   * A page of the user's movements that match the query, the current month by default, with the
   * net of each of its days in the base currency (RF-M6-11, RF-M6-12, plan §4.6.2).
   */
  list(ctx: RatesContext, query: ListQuery): Promise<TransactionListPage>;
  /**
   * Income, expense and net in the base currency of the movements that match the query, each with
   * its stored rates and without what RN-02 leaves out (RF-M6-12, RN-05).
   */
  summary(ctx: RatesContext, query: ListQuery): Promise<LedgerTotals>;
}

/** The earmarks the user agreed to take money from to cover the operation (RF-M12-05). */
export interface WithdrawalOptions {
  earmarkWithdrawals?: EarmarkWithdrawals | undefined;
}

export interface TransactionsServiceDeps {
  uow: UnitOfWork;
  rates: RatesService;
  ledgerHooks: LedgerHooks;
}

/** The preset category of the fees (plan §4.6.3). */
const FEE_PARENT_NAME = 'Servicios';
const FEE_CATEGORY_NAME = 'Comisiones bancarias';

/** The guard options of an interactive operation with the earmark withdrawals the user confirmed. */
function interactive(withdrawals: EarmarkWithdrawals | undefined): BalanceGuardOptions {
  return {
    mode: 'interactive',
    earmarkWithdrawals: (withdrawals ?? []).map((w) => ({
      goalId: w.goalId,
      accountId: w.accountId,
      amount: new Decimal(w.amount),
    })),
  };
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

type UpdateField = keyof UpdateTransactionInput;

/** The fields of `UpdateTransactionInput` that do not belong to each kind (plan §4.6.2). */
const FIELDS_NOT_OF_KIND: Record<TransactionKind, readonly UpdateField[]> = {
  expense: ['fromAccountId', 'toAccountId', 'declaredRate'],
  income: ['fromAccountId', 'toAccountId', 'declaredRate'],
  adjustment: ['fromAccountId', 'toAccountId', 'declaredRate', 'categoryId'],
  transfer: ['accountId', 'amountInNewCurrency', 'categoryId'],
};

/** The amount, the account and the date of a linked movement change only from its origin (RF-M6-09). */
const LINKED_LOCKED_FIELDS: readonly UpdateField[] = [
  'amount',
  'amountInNewCurrency',
  'declaredRate',
  'accountId',
  'fromAccountId',
  'toAccountId',
  'date',
];

/** The origins whose movements are not linked (glosario, RF-M6-10). */
const UNLINKED_ORIGINS: ReadonlySet<TransactionOrigin> = new Set<TransactionOrigin>([
  'manual',
  'recurring',
]);

function invalidField(path: string, code: string): AppError {
  return new AppError('VALIDATION_ERROR', { issues: [{ path, code }] });
}

/** A field that does not belong to the kind of the movement is rejected (plan §4.6.2). */
function assertFieldsOfKind(kind: TransactionKind, input: UpdateTransactionInput): void {
  const issues = FIELDS_NOT_OF_KIND[kind]
    .filter((field) => input[field] !== undefined)
    .map((path) => ({ path, code: 'unrecognized_keys' }));
  if (issues.length > 0) {
    throw new AppError('VALIDATION_ERROR', { issues });
  }
}

/** Within the range of RF-M6-01, else `AMOUNT_OUT_OF_RANGE` (EC-M6-07). */
function assertAmountInRange(amount: Decimal): void {
  if (!Amount.safeParse(amount.toFixed(2)).success) {
    throw new AppError('AMOUNT_OUT_OF_RANGE');
  }
}

/** The only entry of an expense, an income, an adjustment or a fee. */
function singleEntry(movement: LedgerTransactionView): LedgerEntryView {
  const entry = movement.entries[0];
  if (movement.entries.length !== 1 || entry === undefined) {
    throw new Error('The movement was expected to have a single entry');
  }
  return entry;
}

/** An account the movement already uses, whatever its status. */
async function storedAccount(repos: Repositories, accountId: string): Promise<AccountRow> {
  const account = await repos.accounts.get(accountId);
  if (account === null) {
    throw new AppError('NOT_FOUND');
  }
  return account;
}

/**
 * The account that replaces a side of a transfer: the same one, or an active account of the same
 * currency (RF-M6-04, RF-M6-07).
 */
async function replacementAccount(
  repos: Repositories,
  current: AccountRow,
  accountId: string,
  path: 'fromAccountId' | 'toAccountId',
): Promise<AccountRow> {
  if (accountId === current.id) {
    return current;
  }
  const account = await activeAccount(repos, accountId);
  if (account.currencyCode !== current.currencyCode) {
    throw invalidField(path, 'CURRENCY_MISMATCH');
  }
  return account;
}

/**
 * The rates of a transfer between currencies whose declared rate changes (RF-M3-09, plan §4.6.1):
 * in BOB↔USD it is the `rate_usd_bob`, and it is the origin's rate when the destination is BOB.
 * Otherwise the stored rates are kept (RF-M3-10).
 */
function declaredTransferRates(
  from: string,
  to: string,
  stored: MovementRates,
  declaredRate: Decimal | null,
): MovementRates {
  if (declaredRate === null || (from !== 'BOB' && to !== 'BOB')) {
    return stored;
  }
  return {
    rateCurBob: from === 'BOB' ? new Decimal(1) : declaredRate,
    rateUsdBob: from === 'USD' || to === 'USD' ? declaredRate : stored.rateUsdBob,
  };
}

/** Each value once, without the `null` ones. */
function distinct<T>(values: (T | null)[]): T[] {
  return [...new Set(values.filter((value): value is T => value !== null))];
}

/** Rewrites the movement in place; it no longer exists when it was deleted meanwhile (RNF-09). */
async function rewrite(
  repos: Repositories,
  id: string,
  changes: LedgerTransactionChanges,
  entries: LedgerEntryChange[],
): Promise<void> {
  if (!(await repos.ledger.updateTransaction(id, changes, entries))) {
    throw new AppError('NOT_FOUND');
  }
}

/** The movement and its fee, which is deleted and restored with it (RF-M6-05, EC-M6-05). */
function withFee(movement: LedgerTransactionDetail): LedgerTransactionView[] {
  return movement.fee === null ? [movement] : [movement, movement.fee];
}

/** What the movements touched, for the hooks (plan §4.0). */
function changeOf(movements: LedgerTransactionView[]): LedgerChange {
  return {
    dates: distinct(movements.map((movement) => movement.date)),
    categoryIds: distinct(movements.map((movement) => movement.categoryId)),
    accountIds: distinct(
      movements.flatMap((movement) => movement.entries.map((entry) => entry.accountId)),
    ),
  };
}

/** The movements of the ids in that state, each with its fee and each one once. */
async function movementsOf(
  repos: Repositories,
  ids: string[],
  options: LedgerGetOptions,
): Promise<LedgerTransactionView[]> {
  const byId = new Map<string, LedgerTransactionView>();
  for (const id of ids) {
    const movement = await repos.ledger.get(id, options);
    for (const item of movement === null ? [] : withFee(movement)) {
      byId.set(item.id, item);
    }
  }
  return [...byId.values()];
}

/**
 * The deltas of the entries of the movements when they come back (`restore`) or leave (`remove`),
 * without the entries dated before the initial balance of their account (RN-12).
 */
async function entryDeltas(
  repos: Repositories,
  movements: LedgerTransactionView[],
  direction: 'restore' | 'remove',
): Promise<BalanceDelta[]> {
  const accounts = new Map<string, AccountRow>();
  const deltas: BalanceDelta[] = [];
  for (const movement of movements) {
    for (const entry of movement.entries) {
      const account =
        accounts.get(entry.accountId) ?? (await storedAccount(repos, entry.accountId));
      accounts.set(account.id, account);
      const amount = direction === 'restore' ? entry.amount : entry.amount.negated();
      deltas.push(...deltaFor(account, movement.date, amount));
    }
  }
  return deltas;
}

/**
 * Deletes the movements, whose entries leave their accounts: removing an income can leave the
 * cash below zero (EC-M4-01, RF-M6-08). Returns the ids that were deleted.
 */
async function removeMovements(
  repos: Repositories,
  ctx: RatesContext,
  movements: LedgerTransactionView[],
  withdrawals?: EarmarkWithdrawals,
): Promise<string[]> {
  const deltas = await entryDeltas(repos, movements, 'remove');
  await BalanceGuard.apply(repos, ctx.userId, deltas, interactive(withdrawals));
  return repos.ledger.softDelete(movements.map((movement) => movement.id));
}

/** Restores the deleted movements as they were, checked against the negative block (EC-M6-03). */
async function restoreMovements(
  repos: Repositories,
  ctx: RatesContext,
  movements: LedgerTransactionView[],
  withdrawals?: EarmarkWithdrawals,
): Promise<void> {
  const deltas = await entryDeltas(repos, movements, 'restore');
  await BalanceGuard.apply(repos, ctx.userId, deltas, interactive(withdrawals));
  await repos.ledger.restore(movements.map((movement) => movement.id));
}

/** Rewrites the movement with another category; its date, rates and entries stay as they are. */
async function recategorize(
  repos: Repositories,
  movement: LedgerTransactionView,
  categoryId: string,
): Promise<void> {
  await rewrite(
    repos,
    movement.id,
    {
      date: movement.date,
      note: movement.note,
      categoryId,
      rateCurBob: movement.rateCurBob,
      rateUsdBob: movement.rateUsdBob,
      declaredRate: movement.declaredRate,
    },
    movement.entries.map(({ accountId, amount }) => ({ accountId, amount })),
  );
}

/** Gives each movement back the category it had; the balances do not change. */
async function restoreCategories(
  repos: Repositories,
  previous: PreviousCategory[],
): Promise<LedgerChange | null> {
  const movements: LedgerTransactionView[] = [];
  const restored: string[] = [];
  for (const { transactionId, categoryId } of previous) {
    const movement = await repos.ledger.get(transactionId);
    if (movement === null || movement.categoryId === categoryId) {
      continue;
    }
    await recategorize(repos, movement, categoryId);
    movements.push(movement);
    restored.push(categoryId);
  }
  if (movements.length === 0) {
    return null;
  }
  const change = changeOf(movements);
  return { ...change, categoryIds: distinct([...change.categoryIds, ...restored]) };
}

/** Expenses and incomes, the only movements with a category (plan §3.5). */
function isCategorized(kind: TransactionKind): kind is 'expense' | 'income' {
  return kind === 'expense' || kind === 'income';
}

/** A linked movement in a system category keeps it (RF-M6-09, RF-M6-13). */
async function keepsSystemCategory(
  repos: Repositories,
  movement: LedgerTransactionView,
): Promise<boolean> {
  return (
    !UNLINKED_ORIGINS.has(movement.origin) &&
    movement.categoryId !== null &&
    (await repos.categories.get(movement.categoryId))?.isSystem === true
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isPreviousCategory(value: unknown): value is PreviousCategory {
  return (
    isRecord(value) &&
    typeof value.transactionId === 'string' &&
    typeof value.categoryId === 'string'
  );
}

/** The ids of an `undo_action(create)` or `undo_action(delete)`. */
function movementIds(action: UndoAction): string[] {
  const ids: unknown = isRecord(action.payload) ? action.payload.transactionIds : undefined;
  if (!Array.isArray(ids)) {
    throw new Error(`The payload of the undo action (${action.kind}) is malformed`);
  }
  const items: unknown[] = ids;
  if (!items.every((id): id is string => typeof id === 'string')) {
    throw new Error(`The payload of the undo action (${action.kind}) is malformed`);
  }
  return items;
}

/** The previous categories of an `undo_action(recategorize)`. */
function previousCategories(action: UndoAction): PreviousCategory[] {
  const categories: unknown = isRecord(action.payload) ? action.payload.categories : undefined;
  if (!Array.isArray(categories)) {
    throw new Error(`The payload of the undo action (${action.kind}) is malformed`);
  }
  const items: unknown[] = categories;
  if (!items.every(isPreviousCategory)) {
    throw new Error(`The payload of the undo action (${action.kind}) is malformed`);
  }
  return items;
}

/**
 * The filters of the query: its month, else its date or range (a single date is that day), else
 * the current month in the user's timezone (RF-M6-02, plan §4.6.1).
 */
function filtersOf(ctx: RatesContext, query: ListQuery): LedgerListFilters {
  const from = query.from ?? query.to;
  const to = query.to ?? query.from;
  const range =
    query.month !== undefined
      ? monthRange(query.month)
      : from !== undefined && to !== undefined
        ? { from, to }
        : monthRange(todayFor(ctx.timezone, ctx.now).slice(0, 7));
  return {
    ...range,
    limit: query.limit,
    accountId: query.accountId,
    categoryId: query.categoryId,
    kind: query.kind,
    q: query.q,
  };
}

/** The base currency of the user (plan §3.4). */
async function baseCurrency(repos: Repositories, ctx: RatesContext): Promise<string> {
  return (await repos.userSettings.fxSettings(ctx.userId))?.baseCurrency ?? 'BOB';
}

/**
 * Bs per unit of the base currency for the movement: the USD rate it stored, or the user's rate of
 * a currency it did not store on its date (RN-04); `null` when there is none.
 */
function baseRateOf(
  movement: LedgerTransactionView,
  base: string,
  events: FxEvent[],
  timezone: string,
): Decimal | null {
  if (base === 'BOB') {
    return new Decimal(1);
  }
  if (base === 'USD') {
    return movement.rateUsdBob;
  }
  return customRateOn(events, base, movement.date, timezone);
}

/** The signed amount of the movement in the base currency, as the totals count it (RN-04, RN-05). */
function amountInBase(
  movement: LedgerTransactionView,
  base: string,
  events: FxEvent[],
  timezone: string,
): Decimal | null {
  // A transfer stores the rate of its origin currency, the one of what leaves (plan §4.6.1).
  const entry =
    movement.kind === 'transfer'
      ? movement.entries.find((item) => item.amount.isNegative())
      : singleEntry(movement);
  if (entry === undefined) {
    throw new Error('The transfer has no outgoing entry');
  }
  if (entry.currencyCode === base) {
    return entry.amount;
  }
  const rate = baseRateOf(movement, base, events, timezone);
  return rate === null
    ? null
    : entry.amount
        .times(movement.rateCurBob)
        .dividedBy(rate)
        .toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
}

/** Describes movements for the answers, reading each account and category once per call. */
interface Describer {
  movement(movement: LedgerTransactionView): Promise<DescribedTransaction>;
  detail(movement: LedgerTransactionDetail): Promise<DescribedTransactionDetail>;
}

async function describerFor(repos: Repositories, ctx: RatesContext): Promise<Describer> {
  const base = await baseCurrency(repos, ctx);
  const events = await repos.userFxEvents.eventsUntil(ctx.now);
  const accounts = new Map<string, AccountRow>();
  const categoryNames = new Map<string, string>();

  async function categoryOf(id: string | null): Promise<DescribedTransaction['category']> {
    if (id === null) {
      return null;
    }
    const name = categoryNames.get(id) ?? (await repos.categories.get(id))?.name;
    if (name === undefined) {
      throw new Error('The category of the movement could not be read');
    }
    categoryNames.set(id, name);
    return { id, name };
  }

  async function movement(item: LedgerTransactionView): Promise<DescribedTransaction> {
    let beforeInitialBalance = false;
    for (const { accountId } of item.entries) {
      const account = accounts.get(accountId) ?? (await storedAccount(repos, accountId));
      accounts.set(account.id, account);
      beforeInitialBalance ||= item.date < account.initialBalanceDate;
    }
    return {
      ...item,
      amountInBase: amountInBase(item, base, events, ctx.timezone),
      beforeInitialBalance,
      linkedLocked: !UNLINKED_ORIGINS.has(item.origin),
      category: await categoryOf(item.categoryId),
    };
  }

  return {
    movement,
    async detail(item) {
      return {
        ...(await movement(item)),
        fee: item.fee === null ? null : await movement(item.fee),
      };
    },
  };
}

async function listMovements(
  repos: Repositories,
  ctx: RatesContext,
  query: ListQuery,
): Promise<TransactionListPage> {
  const page = await repos.ledger.list(filtersOf(ctx, query), query.cursor ?? null);
  const describer = await describerFor(repos, ctx);
  const items: DescribedTransaction[] = [];
  for (const item of page.items) {
    items.push(await describer.movement(item));
  }
  return { ...page, items };
}

async function getMovement(
  repos: Repositories,
  ctx: RatesContext,
  id: string,
): Promise<DescribedTransactionDetail> {
  const movement = await repos.ledger.get(id);
  if (movement === null) {
    // Deleted, or another user's (RNF-09, RNF-14).
    throw new AppError('NOT_FOUND');
  }
  return (await describerFor(repos, ctx)).detail(movement);
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
  ): Promise<CreatedMovement> {
    await ledgerHooks.afterChange(repos, ctx.userId, change);
    const payload: UndoMovementsPayload = { transactionIds: [id] };
    const undo = await repos.undoActions.create('create', payload);

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
  ): Promise<CreatedMovement> {
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
    await BalanceGuard.apply(repos, ctx.userId, deltaFor(account, input.date, amount),
      interactive(input.earmarkWithdrawals),
    );

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
  ): Promise<CreatedMovement> {
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
    await BalanceGuard.apply(repos, ctx.userId, deltas, interactive(input.earmarkWithdrawals));

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

  /**
   * The rates an edited movement of `currencyCode` stores (RF-M3-10): the stored ones, unless the
   * user edits them by hand. A movement that moves to another currency takes the rate of the new
   * currency from its stored USD rate or, without it, from the history on its date (RF-M6-07).
   */
  async function editedRates(
    repos: Repositories,
    ctx: RatesContext,
    stored: MovementRates,
    currencyCode: string,
    currencyChanged: boolean,
    date: string,
    input: UpdateTransactionInput,
  ): Promise<MovementRates> {
    const manualUsd = input.rateUsdBob === undefined ? null : new Decimal(input.rateUsdBob);
    const manualCur = input.rateCurBob === undefined ? null : new Decimal(input.rateCurBob);

    if (currencyCode === 'BOB') {
      if (manualCur !== null) {
        throw invalidField('rateCurBob', 'unrecognized_keys');
      }
      return { rateCurBob: new Decimal(1), rateUsdBob: manualUsd ?? stored.rateUsdBob };
    }

    if (currencyCode === 'USD') {
      if (manualUsd !== null && manualCur !== null && !manualUsd.equals(manualCur)) {
        throw invalidField('rateCurBob', 'custom');
      }
      const manual = manualCur ?? manualUsd;
      if (manual !== null) {
        return { rateCurBob: manual, rateUsdBob: manual };
      }
      if (!currencyChanged) {
        return stored;
      }
      if (stored.rateUsdBob !== null) {
        return { rateCurBob: stored.rateUsdBob, rateUsdBob: stored.rateUsdBob };
      }
      return rates.ratesForMovement(repos, ctx, 'USD', date);
    }

    const rateUsdBob = manualUsd ?? stored.rateUsdBob;
    if (manualCur !== null) {
      return { rateCurBob: manualCur, rateUsdBob };
    }
    if (!currencyChanged) {
      return { rateCurBob: stored.rateCurBob, rateUsdBob };
    }
    const events = await repos.userFxEvents.eventsUntil(ctx.now);
    const rateCurBob = customRateOn(events, currencyCode, date, ctx.timezone);
    if (rateCurBob === null) {
      throw new AppError('RATE_REQUIRED');
    }
    return { rateCurBob, rateUsdBob };
  }

  /**
   * The amount of an edited single-entry movement in the currency of its account, with the sign of
   * the stored entry. A change to an account of another currency needs `amountInNewCurrency`
   * (RF-M6-07), within the range of RF-M6-01 (EC-M6-07).
   */
  async function editedAmount(
    repos: Repositories,
    entry: LedgerEntryView,
    account: AccountRow,
    currencyChanged: boolean,
    input: UpdateTransactionInput,
  ): Promise<Decimal> {
    let value: Decimal;
    if (currencyChanged) {
      if (input.amount !== undefined) {
        throw invalidField('amount', 'unrecognized_keys');
      }
      if (input.amountInNewCurrency === undefined) {
        throw invalidField('amountInNewCurrency', 'invalid_type');
      }
      value = new Decimal(input.amountInNewCurrency);
      assertAmountInRange(value);
      await assertActiveCurrency(repos, account.currencyCode);
    } else {
      if (input.amountInNewCurrency !== undefined) {
        throw invalidField('amountInNewCurrency', 'unrecognized_keys');
      }
      value = input.amount === undefined ? entry.amount.abs() : new Decimal(input.amount);
    }
    return entry.amount.isNegative() ? value.negated() : value;
  }

  /** Edits an expense, an income, an adjustment or a fee; returns what the edit touched. */
  async function updateSimple(
    repos: Repositories,
    ctx: RatesContext,
    existing: LedgerTransactionDetail,
    input: UpdateTransactionInput,
  ): Promise<LedgerChange> {
    const entry = singleEntry(existing);
    const previousAccount = await storedAccount(repos, entry.accountId);
    const account =
      input.accountId === undefined || input.accountId === previousAccount.id
        ? previousAccount
        : await activeAccount(repos, input.accountId);

    const categoryId = input.categoryId ?? existing.categoryId;
    if (
      input.categoryId !== undefined &&
      input.categoryId !== existing.categoryId &&
      (existing.kind === 'expense' || existing.kind === 'income')
    ) {
      await assertCategory(repos, input.categoryId, existing.kind);
    }

    const currencyChanged = account.currencyCode !== previousAccount.currencyCode;
    const amount = await editedAmount(repos, entry, account, currencyChanged, input);
    const date = input.date ?? existing.date;
    const { rateCurBob, rateUsdBob } = await editedRates(
      repos,
      ctx,
      { rateCurBob: existing.rateCurBob, rateUsdBob: existing.rateUsdBob },
      account.currencyCode,
      currencyChanged,
      date,
      input,
    );

    // The stored entry leaves its account and the edited one comes in (RF-M6-08).
    await BalanceGuard.apply(
      repos,
      ctx.userId,
      [
        ...deltaFor(previousAccount, existing.date, entry.amount.negated()),
        ...deltaFor(account, date, amount),
      ],
      interactive(input.earmarkWithdrawals),
    );

    await rewrite(
      repos,
      existing.id,
      {
        date,
        note: input.note === undefined ? existing.note : input.note,
        categoryId,
        rateCurBob,
        rateUsdBob,
        declaredRate: existing.declaredRate,
      },
      [{ accountId: account.id, amount }],
    );

    return {
      dates: distinct([existing.date, date]),
      categoryIds: distinct([existing.categoryId, categoryId]),
      accountIds: distinct([previousAccount.id, account.id]),
    };
  }

  /**
   * Edits a transfer and its fee, which follows its date and its origin and keeps its amount
   * (RF-M6-05). Each side changes only to an active account of the same currency (RF-M6-07).
   */
  async function updateTransfer(
    repos: Repositories,
    ctx: RatesContext,
    existing: LedgerTransactionDetail,
    input: UpdateTransactionInput,
  ): Promise<LedgerChange> {
    const out = existing.entries.find((entry) => entry.amount.isNegative());
    const arrival = existing.entries.find((entry) => !entry.amount.isNegative());
    if (existing.entries.length !== 2 || out === undefined || arrival === undefined) {
      throw new Error('The transfer was expected to have an outgoing and an incoming entry');
    }

    const fromId = input.fromAccountId ?? out.accountId;
    const toId = input.toAccountId ?? arrival.accountId;
    if (fromId === toId) {
      throw invalidField(
        input.toAccountId === undefined ? 'fromAccountId' : 'toAccountId',
        'SAME_ACCOUNT',
      );
    }
    const previousFrom = await storedAccount(repos, out.accountId);
    const previousTo = await storedAccount(repos, arrival.accountId);
    const from = await replacementAccount(repos, previousFrom, fromId, 'fromAccountId');
    const to = await replacementAccount(repos, previousTo, toId, 'toAccountId');

    const crossCurrency = from.currencyCode !== to.currencyCode;
    if (!crossCurrency && input.declaredRate !== undefined) {
      throw invalidField('declaredRate', 'unrecognized_keys');
    }
    if (crossCurrency && input.rateUsdBob !== undefined) {
      throw invalidField('rateUsdBob', 'unrecognized_keys');
    }
    if (crossCurrency && input.rateCurBob !== undefined) {
      throw invalidField('rateCurBob', 'unrecognized_keys');
    }

    const amountOut = input.amount === undefined ? out.amount.negated() : new Decimal(input.amount);
    const declaredRate =
      input.declaredRate === undefined ? existing.declaredRate : new Decimal(input.declaredRate);
    let amountIn = crossCurrency ? arrival.amount : amountOut;
    if (crossCurrency && (input.amount !== undefined || input.declaredRate !== undefined)) {
      // The declared rate is kept unless the user edits it (RF-M3-10).
      if (declaredRate === null) {
        throw new AppError('RATE_REQUIRED');
      }
      amountIn = amountInFrom(amountOut, declaredRate, from.currencyCode);
      assertAmountInRange(amountIn);
    }

    const date = input.date ?? existing.date;
    const stored = { rateCurBob: existing.rateCurBob, rateUsdBob: existing.rateUsdBob };
    const { rateCurBob, rateUsdBob } = crossCurrency
      ? declaredTransferRates(
          from.currencyCode,
          to.currencyCode,
          stored,
          input.declaredRate === undefined ? null : declaredRate,
        )
      : await editedRates(repos, ctx, stored, from.currencyCode, false, date, input);
    const ratesEdited =
      input.declaredRate !== undefined ||
      input.rateUsdBob !== undefined ||
      input.rateCurBob !== undefined;

    const fee = existing.fee;
    const feeEntry = fee === null ? null : singleEntry(fee);

    // The amount and the fee are checked together against the negative block (RF-M6-05, RF-M6-08).
    const deltas: BalanceDelta[] = [
      ...deltaFor(previousFrom, existing.date, out.amount.negated()),
      ...deltaFor(previousTo, existing.date, arrival.amount.negated()),
      ...deltaFor(from, date, amountOut.negated()),
      ...deltaFor(to, date, amountIn),
    ];
    if (fee !== null && feeEntry !== null) {
      deltas.push(
        ...deltaFor(previousFrom, fee.date, feeEntry.amount.negated()),
        ...deltaFor(from, date, feeEntry.amount),
      );
    }
    await BalanceGuard.apply(repos, ctx.userId, deltas, interactive(input.earmarkWithdrawals));

    await rewrite(
      repos,
      existing.id,
      {
        date,
        note: input.note === undefined ? existing.note : input.note,
        categoryId: existing.categoryId,
        rateCurBob,
        rateUsdBob,
        declaredRate,
      },
      existing.entries.map((entry) =>
        entry === out
          ? { accountId: from.id, amount: amountOut.negated() }
          : { accountId: to.id, amount: amountIn },
      ),
    );
    if (fee !== null && feeEntry !== null) {
      await rewrite(
        repos,
        fee.id,
        {
          date,
          note: fee.note,
          categoryId: fee.categoryId,
          rateCurBob: ratesEdited ? rateCurBob : fee.rateCurBob,
          rateUsdBob: ratesEdited ? rateUsdBob : fee.rateUsdBob,
          declaredRate: fee.declaredRate,
        },
        [{ accountId: from.id, amount: feeEntry.amount }],
      );
    }

    return {
      dates: distinct([existing.date, date, fee?.date ?? null]),
      categoryIds: distinct([fee?.categoryId ?? null]),
      accountIds: distinct([previousFrom.id, previousTo.id, from.id, to.id]),
    };
  }

  async function updateMovement(
    repos: Repositories,
    ctx: RatesContext,
    id: string,
    input: UpdateTransactionInput,
  ): Promise<LedgerTransactionDetail> {
    const existing = await repos.ledger.get(id);
    if (existing === null) {
      // Deleted in another device, or another user's (EC-M6-02, RNF-09).
      throw new AppError('NOT_FOUND');
    }
    assertFieldsOfKind(existing.kind, input);

    if (!UNLINKED_ORIGINS.has(existing.origin)) {
      const lockedCategory =
        input.categoryId !== undefined &&
        existing.categoryId !== null &&
        input.categoryId !== existing.categoryId &&
        (await repos.categories.get(existing.categoryId))?.isSystem === true;
      if (lockedCategory || LINKED_LOCKED_FIELDS.some((field) => input[field] !== undefined)) {
        throw new AppError('LINKED_FIELD_LOCKED', {
          originType: existing.origin,
          originId: existing.originId,
        });
      }
    }
    if (input.date !== undefined && isFutureFor(input.date, ctx.timezone, ctx.now)) {
      throw new AppError('FUTURE_DATE');
    }

    const change =
      existing.kind === 'transfer'
        ? await updateTransfer(repos, ctx, existing, input)
        : await updateSimple(repos, ctx, existing, input);
    await ledgerHooks.afterChange(repos, ctx.userId, change);

    const transaction = await repos.ledger.get(id);
    if (transaction === null) {
      throw new Error('The edited transaction could not be read back');
    }
    return transaction;
  }

  async function deleteMovement(
    repos: Repositories,
    ctx: RatesContext,
    id: string,
    withdrawals?: EarmarkWithdrawals,
  ): Promise<DeleteTransactionResult> {
    const existing = await repos.ledger.get(id);
    if (existing === null) {
      // Deleted in another device, or another user's (RNF-09).
      throw new AppError('NOT_FOUND');
    }
    if (!UNLINKED_ORIGINS.has(existing.origin)) {
      // A linked movement is deleted only from its origin (RF-M6-09, plan §4.6.2).
      throw new AppError('LINKED_DELETE_FORBIDDEN');
    }

    const movements = withFee(existing);
    const deleted = await removeMovements(repos, ctx, movements, withdrawals);
    await ledgerHooks.afterChange(repos, ctx.userId, changeOf(movements));
    const payload: UndoMovementsPayload = { transactionIds: deleted };
    const undo = await repos.undoActions.create('delete', payload);
    return { undoToken: undo.id };
  }

  /** Reverts the action; `null` when nothing is left to revert. */
  async function revert(
    repos: Repositories,
    ctx: RatesContext,
    action: UndoAction,
    withdrawals?: EarmarkWithdrawals,
  ): Promise<LedgerChange | null> {
    switch (action.kind) {
      case 'delete': {
        const movements = await movementsOf(repos, movementIds(action), { deleted: true });
        if (movements.length === 0) {
          return null;
        }
        await restoreMovements(repos, ctx, movements, withdrawals);
        return changeOf(movements);
      }
      case 'create': {
        // The new movement is deleted with the same checks as a deletion (RF-M7-07).
        const movements = await movementsOf(repos, movementIds(action), {});
        if (movements.length === 0) {
          return null;
        }
        await removeMovements(repos, ctx, movements, withdrawals);
        return changeOf(movements);
      }
      case 'recategorize':
        return restoreCategories(repos, previousCategories(action));
    }
  }

  async function undoAction(
    repos: Repositories,
    ctx: RatesContext,
    undoToken: string,
    withdrawals?: EarmarkWithdrawals,
  ): Promise<void> {
    const action = await repos.undoActions.consume(undoToken);
    if (action === null) {
      // Unknown, already used, expired or another user's: a repeated undo does nothing (RNF-11).
      throw new AppError('UNDO_EXPIRED');
    }
    const change = await revert(repos, ctx, action, withdrawals);
    if (change !== null) {
      await ledgerHooks.afterChange(repos, ctx.userId, change);
    }
  }

  async function batchDeleteMovements(
    repos: Repositories,
    ctx: RatesContext,
    ids: string[],
  ): Promise<BatchResult> {
    const selected = distinct(ids);
    const deleted = new Set<string>();
    const movements: LedgerTransactionView[] = [];
    for (const id of selected) {
      const existing = await repos.ledger.get(id);
      // Deleted meanwhile, another user's, or linked: deleted only from its origin (RF-M6-13).
      if (existing === null || !UNLINKED_ORIGINS.has(existing.origin)) {
        continue;
      }
      // Each one is checked against the balances the previous ones already left (RF-M6-13).
      const items = withFee(existing);
      const deltas = await entryDeltas(repos, items, 'remove');
      if ((await BalanceGuard.apply(repos, ctx.userId, deltas, { mode: 'batch' })) === 'skip') {
        continue;
      }
      for (const removed of await repos.ledger.softDelete(items.map((item) => item.id))) {
        deleted.add(removed);
      }
      movements.push(...items);
    }

    // A fee selected with its transfer counts as processed, whatever their order.
    const processed = selected.filter((id) => deleted.has(id)).length;
    if (deleted.size === 0) {
      return { processed, skipped: selected.length - processed, undoToken: null };
    }
    await ledgerHooks.afterChange(repos, ctx.userId, changeOf(movements));
    const payload: UndoMovementsPayload = { transactionIds: [...deleted] };
    const undo = await repos.undoActions.create('delete', payload);
    return { processed, skipped: selected.length - processed, undoToken: undo.id };
  }

  async function batchRecategorizeMovements(
    repos: Repositories,
    ctx: RatesContext,
    input: BatchRecategorizeInput,
  ): Promise<BatchResult> {
    const selected = distinct(input.ids);
    const candidates: LedgerTransactionDetail[] = [];
    for (const id of selected) {
      const movement = await repos.ledger.get(id);
      // Deleted meanwhile or another user's; transfers and adjustments have no category.
      if (movement !== null && isCategorized(movement.kind)) {
        candidates.push(movement);
      }
    }
    const kinds = distinct(candidates.map((movement) => movement.kind)).filter(isCategorized);
    if (kinds.length > 1) {
      throw new AppError('MIXED_KINDS');
    }
    const kind = kinds[0];
    if (kind === undefined) {
      return { processed: 0, skipped: selected.length, undoToken: null };
    }
    await assertCategory(repos, input.categoryId, kind);

    // The balances do not change, so no movement can be blocked by a negative (RF-M6-13).
    let processed = 0;
    const previous: PreviousCategory[] = [];
    const changed: LedgerTransactionView[] = [];
    for (const movement of candidates) {
      if (await keepsSystemCategory(repos, movement)) {
        continue;
      }
      processed += 1;
      if (movement.categoryId === input.categoryId) {
        continue;
      }
      if (movement.categoryId === null) {
        throw new Error('An expense or income has no category');
      }
      await recategorize(repos, movement, input.categoryId);
      previous.push({ transactionId: movement.id, categoryId: movement.categoryId });
      changed.push(movement);
    }

    if (changed.length === 0) {
      return { processed, skipped: selected.length - processed, undoToken: null };
    }
    const change = changeOf(changed);
    await ledgerHooks.afterChange(repos, ctx.userId, {
      ...change,
      categoryIds: distinct([...change.categoryIds, input.categoryId]),
    });
    const payload: UndoRecategorizePayload = { categories: previous };
    const undo = await repos.undoActions.create('recategorize', payload);
    return { processed, skipped: selected.length - processed, undoToken: undo.id };
  }

  return {
    async create(ctx, input) {
      return uow.run(
        async (repos) => {
          const result =
            input.kind === 'transfer'
              ? await createTransfer(repos, ctx, input)
              : await createSimple(repos, ctx, input);
          const describer = await describerFor(repos, ctx);
          return { ...result, transaction: await describer.detail(result.transaction) };
        },
        { userLock: ctx.userId },
      );
    },

    async update(ctx, id, input) {
      return uow.run(
        async (repos) => {
          const transaction = await updateMovement(repos, ctx, id, input);
          return (await describerFor(repos, ctx)).detail(transaction);
        },
        { userLock: ctx.userId },
      );
    },

    async get(ctx, id) {
      return uow.run((repos) => getMovement(repos, ctx, id), {
        userLock: ctx.userId,
        readOnly: true,
      });
    },

    async delete(ctx, id, options) {
      return uow.run((repos) => deleteMovement(repos, ctx, id, options?.earmarkWithdrawals), {
        userLock: ctx.userId,
      });
    },

    async undo(ctx, undoToken, options) {
      return uow.run((repos) => undoAction(repos, ctx, undoToken, options?.earmarkWithdrawals), {
        userLock: ctx.userId,
      });
    },

    async batchDelete(ctx, input) {
      return uow.run((repos) => batchDeleteMovements(repos, ctx, input.ids), {
        userLock: ctx.userId,
      });
    },

    async batchRecategorize(ctx, input) {
      return uow.run((repos) => batchRecategorizeMovements(repos, ctx, input), {
        userLock: ctx.userId,
      });
    },

    async list(ctx, query) {
      return uow.run((repos) => listMovements(repos, ctx, query), {
        userLock: ctx.userId,
        readOnly: true,
      });
    },

    async summary(ctx, query) {
      return uow.run(
        async (repos) => repos.ledger.summary(filtersOf(ctx, query), await baseCurrency(repos, ctx)),
        { userLock: ctx.userId, readOnly: true },
      );
    },
  };
}
