import type { Decimal } from 'decimal.js';

import type { Instant, LocalDate } from './clock.js';
import type { EmailKind, EmailPayload } from './email-gateway.js';

/** An email to leave in the outbox (plan §3.3). */
export interface OutboxEmail {
  id: string;
  to: string;
  kind: EmailKind;
  payload: EmailPayload;
}

/** A pending row of the outbox that is due to be sent. */
export interface DueOutboxEmail extends OutboxEmail {
  attempts: number;
}

/** Transient mail queue: the row is deleted once the email is sent (plan §3.3, RNF-22). */
export interface EmailOutboxRepository {
  enqueue(email: OutboxEmail): Promise<void>;
  /** Pending rows whose `next_attempt_at` is not after `now`, oldest first. */
  findDue(now: Instant, limit: number): Promise<DueOutboxEmail[]>;
  /** Deletes the row of an email that was sent. */
  remove(id: string): Promise<void>;
  /** Records a failed send: the new attempt count, and when to retry (`null` marks it failed). */
  recordFailure(
    id: string,
    attempts: number,
    nextAttemptAt: Instant | null,
    error: string,
  ): Promise<void>;
}

export type EmailLinkPurpose = 'confirm_email' | 'reset_password';

/** Why a link could not be consumed: invalid (expired, invalidated, unknown) or already used. */
export type EmailLinkFailure = 'LINK_INVALID' | 'LINK_ALREADY_USED';

export type ConsumeEmailLinkResult =
  { ok: true; userId: string; purpose: EmailLinkPurpose } | { ok: false; reason: EmailLinkFailure };

/** Single-use links sent by email; only the SHA-256 of each token is stored (plan §4.1.3). */
export interface EmailLinkRepository {
  /** Invalidates the user's current link of that purpose and issues a new one. */
  create(userId: string, purpose: EmailLinkPurpose): Promise<{ token: string; expiresAt: Date }>;
  /** Marks the link as used. Of simultaneous calls with the same token, only one succeeds. */
  consume(token: string, purpose: EmailLinkPurpose): Promise<ConsumeEmailLinkResult>;
  /**
   * The owner of the link with that token, whatever its state (expired, invalidated or used), or
   * `null` when the token is unknown. Locks the owner's row until the transaction ends.
   */
  findOwner(token: string, purpose: EmailLinkPurpose): Promise<EmailLinkOwner | null>;
}

export interface EmailLinkOwner {
  userId: string;
  email: string;
  emailVerified: boolean;
}

/** Account emails sent per email, keyed by the HMAC-SHA256 of the email (plan §3.3). */
export interface EmailSendLogRepository {
  /** Records a send of that kind now. */
  record(emailHmac: string, kind: EmailKind): Promise<void>;
  /** Sends of that kind in the last `seconds` seconds. */
  countSince(emailHmac: string, kind: EmailKind, seconds: number): Promise<number>;
}

/** Failed login attempts per email, keyed by the HMAC-SHA256 of the email (plan §3.9, §4.1.3). */
export interface LoginThrottleRepository {
  /** Seconds left of the wait, rounded up; `0` when there is none. */
  remainingSeconds(emailHmac: string): Promise<number>;
  /** Atomically counts a failure and sets the wait: 1 min at 5 failures, 15 min from 10 on. */
  recordFailure(emailHmac: string): Promise<void>;
  /** Forgets the failures of that email. */
  reset(emailHmac: string): Promise<void>;
  /** `true` when no alert went out in the last hour, and records this one. Atomic. */
  claimAlert(emailHmac: string): Promise<boolean>;
}

export type CategoryKind = 'expense' | 'income';
export type SystemCategoryKey = 'debts' | 'debts_interest';

/** A category row to create for a new user (plan §4.5.3). */
export interface NewCategory {
  id: string;
  userId: string;
  kind: CategoryKind;
  parentId: string | null;
  name: string;
  color: string;
  icon: string;
  systemKey: SystemCategoryKey | null;
  seedOrder: number;
  sortOrder: number;
}

export interface DashboardBlock {
  key: string;
  visible: boolean;
}

export type NotificationType =
  | 'payment_upcoming'
  | 'budget_alert'
  | 'period_close'
  | 'recurring_pending'
  | 'log_day'
  | 'goal_progress';

export interface NewNotificationPreference {
  type: NotificationType;
  enabled: boolean;
  hour: number | null;
  leadDays: number | null;
  weekdays: number[] | null;
}

export interface NewUnconfirmedUser {
  id: string;
  name: string;
  email: string;
  passwordHash: string;
  /** IANA zone of the device; the user gets America/La_Paz without it (RF-M1-11). */
  timezone?: string;
}

/** The password credential of a user, to check a sign-in against. */
export interface UserCredential {
  id: string;
  emailVerified: boolean;
  passwordHash: string;
}

/** A user with its email, its password credential and whether it finished the onboarding. */
export interface UserAccount {
  id: string;
  email: string;
  emailVerified: boolean;
  /** `null` when the user has no password credential. */
  passwordHash: string | null;
  onboardingCompleted: boolean;
}

/** Writes the initial rows of a new user (plan §3.4, §4.5.3, §4.15.1). */
export interface UserRepository {
  /** The user with that normalized email, or `null`. */
  findByEmail(email: string): Promise<{ id: string; emailVerified: boolean } | null>;
  /** The password credential of the user with that normalized email, or `null`. */
  findCredential(email: string): Promise<UserCredential | null>;
  /** The user with that id, or `null`. */
  findAccount(userId: string): Promise<UserAccount | null>;
  /** Replaces the password hash of the user's credential (RF-M1-10). */
  setPassword(userId: string, passwordHash: string): Promise<void>;
  /** Marks the email of the user as verified, which makes the account active (EC-M1-10). */
  markEmailVerified(userId: string): Promise<void>;
  /**
   * Creates an unconfirmed user with its credential, accepting the terms now. Returns `false`
   * when the email is already taken (unique index), without failing the transaction.
   */
  createUnconfirmed(user: NewUnconfirmedUser): Promise<boolean>;
  /**
   * Replaces the name and the password hash of the unconfirmed user with that email and restarts
   * its 7 day period. Returns the user id, or `null` when there is no unconfirmed user.
   */
  replaceUnconfirmed(email: string, name: string, passwordHash: string): Promise<string | null>;
  /** `true` when no `register_attempt` went out for that email in the last hour; records it. Atomic. */
  claimRegisterAttempt(emailHmac: string): Promise<boolean>;
  /** Creates BOB and USD, active and marked as system (RF-M3-01). */
  createSystemCurrencies(userId: string): Promise<void>;
  /** Creates `user_settings` with the column defaults and the given dashboard blocks. */
  createSettings(userId: string, dashboardBlocks: DashboardBlock[]): Promise<void>;
  /** Inserts the categories in the given order, so each parent comes before its children. */
  createCategories(categories: NewCategory[]): Promise<void>;
  createNotificationPreferences(
    userId: string,
    preferences: NewNotificationPreference[],
  ): Promise<void>;
}

/**
 * Repositories bound to a transaction and to a user (ADR-05).
 * Each module adds its own repository here.
 */
export interface Repositories {
  emailOutbox: EmailOutboxRepository;
  emailLinks: EmailLinkRepository;
  emailSendLog: EmailSendLogRepository;
  loginThrottle: LoginThrottleRepository;
  users: UserRepository;
  marketRates: MarketRateRepository;
  currencies: CurrencyRepository;
  userFxEvents: UserFxEventRepository;
  accounts: AccountRepository;
  ledger: LedgerRepository;
  undoActions: UndoActionRepository;
}

// ---------- Monedas y tipo de cambio (M3) ----------

export type MarketRateKind = 'parallel_bid' | 'parallel_ask' | 'parallel_median' | 'official';
export type RateSource = 'paralelo_bo' | 'bcb' | 'seed';
export type CurrencyStatus = 'active' | 'inactive';
export type FxEventKind = 'reference_set' | 'manual_usd_on' | 'manual_usd_off' | 'custom_rate';

export interface MarketRateRow {
  kind: MarketRateKind;
  rateDate: LocalDate;
  value: Decimal;
  observedAt: Date;
  source: RateSource;
}

/** Global market data (ADR-12): not bound to any user. */
export interface MarketRateRepository {
  /** Stores the day's rate unless a rate observed at the same instant or later is already there. */
  upsertIfNewer(rate: MarketRateRow): Promise<void>;
  /** Row of the most recent day of that kind, or null. */
  latest(kind: MarketRateKind): Promise<MarketRateRow | null>;
  /** Days of the range, both ends included, in ascending order. */
  series(kind: MarketRateKind, from: LocalDate, to: LocalDate): Promise<MarketRateRow[]>;
}

export interface CurrencyRow {
  code: string;
  symbol: string;
  isSystem: boolean;
  status: CurrencyStatus;
  createdAt: Date;
}

/** Currencies of the user bound to the transaction (RN-09). */
export interface CurrencyRepository {
  list(): Promise<CurrencyRow[]>;
  get(code: string): Promise<CurrencyRow | null>;
  lockForUpdate(code: string): Promise<CurrencyRow | null>;
  lockForShare(code: string): Promise<CurrencyRow | null>;
  insert(currency: { code: string; symbol: string }): Promise<void>;
}

export interface UserFxEventRow {
  id: string;
  kind: FxEventKind;
  currencyCode: string | null;
  reference: MarketRateKind | null;
  value: Decimal | null;
  effectiveAt: Date;
}

/** Exchange-rate events of the user bound to the transaction (RN-09). */
export interface UserFxEventRepository {
  insert(event: UserFxEventRow): Promise<void>;
  /** Events effective at or before the instant, in ascending order. */
  eventsUntil(instant: Date): Promise<UserFxEventRow[]>;
}

// ---------- Cuentas y libro contable (M4, ADR-04) ----------

export type AccountType = 'cash' | 'bank' | 'ewallet' | 'credit_card' | 'savings' | 'other';
export type LifecycleStatus = 'active' | 'archived';

export interface AccountRow {
  id: string;
  type: AccountType;
  name: string;
  currencyCode: string;
  /** Fixed when the account is created (RF-M4-07); a card stores its debt as negative. */
  initialBalance: Decimal;
  initialBalanceDate: LocalDate;
  color: string;
  icon: string;
  cardCutDay: number | null;
  cardPayDay: number | null;
  cardLimit: Decimal | null;
  status: LifecycleStatus;
  archivedAt: Date | null;
  sortOrder: number;
}

/** A new account: it is always created active. */
export type NewAccount = Omit<AccountRow, 'status' | 'archivedAt'>;

/** Editable fields of an account; the initial balance and its date never change (RF-M4-07). */
export type AccountPatch = Partial<
  Pick<
    AccountRow,
    'type' | 'name' | 'currencyCode' | 'color' | 'icon' | 'cardCutDay' | 'cardPayDay' | 'cardLimit'
  >
>;

/** Accounts of the user bound to the transaction; another user's account does not exist (RN-09). */
export interface AccountRepository {
  insert(account: NewAccount): Promise<void>;
  get(id: string): Promise<AccountRow | null>;
  /** Accounts of that status, by `sortOrder`. */
  list(status: LifecycleStatus): Promise<AccountRow[]>;
  /** Locks the rows of the user's accounts among the ids, in id order, and returns them. */
  lockForUpdate(ids: string[]): Promise<AccountRow[]>;
  update(id: string, patch: AccountPatch): Promise<void>;
  /** Gives each account the position of its id in the list as its `sortOrder`. */
  setOrder(ids: string[]): Promise<void>;
  /** How many accounts the user has, active or archived. */
  count(): Promise<number>;
  /** `true` when the account has any entry, including those of deleted transactions. */
  hasEntries(id: string): Promise<boolean>;
}

export type TransactionKind = 'expense' | 'income' | 'transfer' | 'adjustment';
export type TransactionOrigin =
  'manual' | 'recurring' | 'debt_initial' | 'debt_payment' | 'fee' | 'goal_transfer';

/** Header of a ledger transaction (plan §3.5); its `id` comes from the client (ADR-11). */
export interface LedgerTransactionHeader {
  id: string;
  kind: TransactionKind;
  date: LocalDate;
  note: string | null;
  categoryId: string | null;
  origin: TransactionOrigin;
  originId: string | null;
  parentTransactionId: string | null;
  recurringRuleId: string | null;
  recurringLabel: string | null;
  rateCurBob: Decimal;
  rateUsdBob: Decimal | null;
  declaredRate: Decimal | null;
}

/** A signed entry: positive comes into the account, negative goes out (ADR-04). */
export interface LedgerEntryInput {
  id: string;
  accountId: string;
  amount: Decimal;
}

export interface BalancePoint {
  date: LocalDate;
  balance: Decimal;
}

/** Ledger of the user bound to the transaction (ADR-04, RN-09). */
export interface LedgerRepository {
  /**
   * Inserts the header and its entries, which take the header's date. A header whose id already
   * exists is left as it is, with no new entries (ADR-11). Returns `true` when it was inserted.
   */
  insertTransaction(header: LedgerTransactionHeader, entries: LedgerEntryInput[]): Promise<boolean>;
  /**
   * Balance of each of the user's accounts among the ids: initial balance plus the entries from the
   * initial balance date on, without deleted transactions (RN-01).
   */
  balances(accountIds: string[]): Promise<Map<string, Decimal>>;
  /** Balance at the end of each day of the range, both ends included, in ascending order (RN-01). */
  balanceSeries(accountId: string, from: LocalDate, to: LocalDate): Promise<BalancePoint[]>;
}

export type UndoKind = 'delete' | 'recategorize' | 'create';

export interface UndoAction {
  kind: UndoKind;
  payload: unknown;
}

/** Single-use undo tokens of the user bound to the transaction (ADR-07, RN-09). */
export interface UndoActionRepository {
  /** Stores the action; its `id` is the undoToken and it expires 12 seconds later. */
  create(kind: UndoKind, payload: unknown): Promise<{ id: string; expiresAt: Date }>;
  /**
   * Marks the action as used and returns it, or `null` when it is unknown, already used, expired
   * or of another user. Of simultaneous calls, only one succeeds.
   */
  consume(id: string): Promise<UndoAction | null>;
}
