import type { Decimal } from 'decimal.js';

import type { RecurrenceEnd, RecurrenceFrequency } from '../../domain/index.js';
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

/** The general settings of a user, as stored (plan §3.4). */
export interface UserSettingsData {
  numberFormat: 'dot_comma' | 'comma_dot';
  dateFormat: 'dmy' | 'iso' | 'short_text';
  weekStart: 'monday' | 'sunday';
  theme: 'system' | 'light' | 'dark';
  sidebarCollapsed: boolean;
  defaultAccountId: string | null;
  alwaysShowNote: boolean;
  dashboardBlocks: DashboardBlock[];
  favorites: { expense: string[]; income: string[] };
}

/** The general settings the user can change now; absent fields stay as they are. */
export type UserSettingsChanges = Partial<
  Pick<
    UserSettingsData,
    | 'numberFormat'
    | 'dateFormat'
    | 'weekStart'
    | 'theme'
    | 'sidebarCollapsed'
    | 'defaultAccountId'
    | 'alwaysShowNote'
    | 'dashboardBlocks'
  >
>;

/** Favorite categories of one kind, in their order; they replace the ones of that kind. */
export interface FavoriteCategoriesChange {
  kind: CategoryKind;
  ids: string[];
}

/** The `favorite_category` rows of a user (plan §3.4). */
export interface FavoriteCategoryRepository {
  /** Replaces the favorites of `kind` with `ids`, keeping their order as the position. */
  replace(userId: string, kind: CategoryKind, ids: string[]): Promise<void>;
}

/** The exchange-rate settings of a user, as stored in `user_settings` (plan §3.4). */
export interface UserFxSettings {
  baseCurrency: string;
  usdReference: MarketRateKind;
  /** Active manual USD value, or `null` when the manual value is off. */
  manualUsdValue: Decimal | null;
  manualUsdSince: Date | null;
}

/**
 * Exchange-rate settings to write; absent fields stay as they are. `manualUsd: null` turns the
 * manual value off, an object turns it on from `since` (plan §4.3.3).
 */
export interface UserFxSettingsChanges {
  baseCurrency?: string;
  usdReference?: MarketRateKind;
  manualUsd?: { value: Decimal; since: Date } | null;
}

export type OnboardingStep = 1 | 2 | 3;

/** Where the Onboarding of a user is, as stored in `user_settings` (plan §4.10.3). */
export interface OnboardingProgress {
  /** The pending step; once finished, the step it was finished from. */
  step: OnboardingStep;
  completed: boolean;
}

/**
 * A move of the Onboarding out of step `from`: to the step `to`, or to Terminado with `'done'`,
 * which keeps the step (plan §4.10.3). `baseCurrency`, when given, is stored with it.
 */
export interface OnboardingTransition {
  from: OnboardingStep;
  to: 2 | 3 | 'done';
  baseCurrency?: string;
}

/** Reads and writes the `user_settings` row of the user the transaction is locked to. */
export interface UserSettingsRepository {
  /** The settings of the user, or `null` when it has none. */
  find(userId: string): Promise<UserSettingsData | null>;
  /** The exchange-rate settings of the user, or `null` when it has none. */
  fxSettings(userId: string): Promise<UserFxSettings | null>;
  /** Updates only the given fields; the last write wins (EC-M9-01). */
  update(userId: string, changes: UserSettingsChanges): Promise<void>;
  /** Replaces the favorite categories of one kind (RF-M7-04). */
  replaceFavorites(userId: string, change: FavoriteCategoriesChange): Promise<void>;
  /** Clears the default account of the user when it is that account (RF-M4-12, EC-M7-05). */
  clearDefaultAccount(userId: string, accountId: string): Promise<void>;
  /** Turns the manual USD value on with its start, or off with `null` (plan §4.3.3, RF-M3-03). */
  setManualUsd(userId: string, manual: { value: Decimal; since: Date } | null): Promise<void>;
  /** Updates only the given exchange-rate fields of `user_settings`. */
  updateFx(userId: string, changes: UserFxSettingsChanges): Promise<void>;
  /** The Onboarding progress of the user, or `null` when it has no settings. */
  onboarding(userId: string): Promise<OnboardingProgress | null>;
  /**
   * Applies the transition only while the Onboarding is in step `from` and not finished
   * (`UPDATE … WHERE onboarding_step = N AND onboarding_completed_at IS NULL`, plan §4.10.3), so a
   * double submit or two devices never advance twice. Returns the new progress, or `null` when
   * nothing changed.
   */
  advanceOnboarding(
    userId: string,
    transition: OnboardingTransition,
  ): Promise<OnboardingProgress | null>;
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
  categories: CategoryRepository;
  userSettings: UserSettingsRepository;
  shortcuts: ShortcutRepository;
  dashboard: DashboardRepository;
  exports: ExportRepository;
  notifications: NotificationRepository;
  notificationPreferences: NotificationPreferenceRepository;
  recurringRules: RecurringRuleRepository;
  recurringOccurrences: RecurringOccurrenceRepository;
  debts: DebtRepository;
  debtPayments: DebtPaymentRepository;
  goals: GoalRepository;
  goalAllocations: GoalAllocationRepository;
  budgets: BudgetRepository;
  budgetPeriods: BudgetPeriodRepository;
}

// ---------- Bandeja de avisos (M15) ----------

/** The decision a notification waits for (plan §4.15.3). */
export type NotificationDecisionKind = 'budget_period' | 'occurrence';

/** An in-app notification to create (plan §3.7, §4.15.3). */
export interface NewNotification {
  id: string;
  userId: string;
  type: NotificationType;
  /** The event that produces it; one event never produces two notifications (RN-10). */
  eventKey: string;
  /** Data for the i18n text. */
  params: Record<string, unknown>;
  targetRoute: string;
  /** When present, the notification is created waiting for that decision. */
  decision?: { kind: NotificationDecisionKind; ref: string };
}

/** The `notification` rows of a user (plan §3.7). */
export interface NotificationRepository {
  /**
   * Inserts the notification unless the user already has one with that `eventKey`
   * (`ON CONFLICT (user_id, event_key) DO NOTHING`). `true` when it was inserted.
   */
  insertIfAbsent(notification: NewNotification): Promise<boolean>;
  /** Marks as `resolved` the user's notifications waiting for that decision; returns how many. */
  resolveDecision(userId: string, kind: NotificationDecisionKind, ref: string): Promise<number>;
}

/** The `notification_preference` rows of a user (plan §3.7). */
export interface NotificationPreferenceRepository {
  /** `true` when the user has that type turned on; `false` when it is off or has no row. */
  isEnabled(userId: string, type: NotificationType): Promise<boolean>;
  /** Every preference of the user, one per type, in the order of the types. */
  list(userId: string): Promise<NotificationPreferenceData[]>;
  /**
   * Turns the type on or off; `hour`, `leadDays` and `weekdays` change only when present, and the
   * others stay as they are.
   */
  update(userId: string, change: NotificationPreferenceChange): Promise<void>;
}

/** A stored notification preference (plan §3.7). */
export type NotificationPreferenceData = NewNotificationPreference;

/** A change of one preference (`PreferenceInput`, plan §4.15.1). */
export interface NotificationPreferenceChange {
  type: NotificationType;
  enabled: boolean;
  hour?: number | undefined;
  leadDays?: number | undefined;
  weekdays?: number[] | undefined;
}

// ---------- Exportación de datos (M1) ----------

/**
 * A table of the export, every cell already as text (RF-M1-14): decimals with a dot and no
 * thousands separator (`1234.56`, ADR-03), dates as `YYYY-MM-DD`, instants in ISO 8601 UTC and an
 * absent value as an empty cell.
 */
export interface ExportTable {
  columns: string[];
  rows: string[][];
}

/** Every row of the user bound to the transaction, archived ones included (RNF-16, RN-09). */
export interface ExportRepository {
  /** The user's profile: one row. */
  profile(): Promise<ExportTable>;
  /** The general and exchange-rate settings: one row. */
  settings(): Promise<ExportTable>;
  /** The favorite categories of Registrar, in their order. */
  favoriteCategories(): Promise<ExportTable>;
  currencies(): Promise<ExportTable>;
  /** The exchange-rate events: reference changes, manual USD values and custom rates. */
  fxEvents(): Promise<ExportTable>;
  accounts(): Promise<ExportTable>;
  categories(): Promise<ExportTable>;
  /** The movements that are not deleted, with the rates stored in each one (RN-05). */
  transactions(): Promise<ExportTable>;
  /** The entries of the movements that are not deleted (ADR-04). */
  entries(): Promise<ExportTable>;
  shortcuts(): Promise<ExportTable>;
}

// ---------- Inicio (M8) ----------

/** Income and expense of a date range in the base currency; `expense` is positive. */
export interface PeriodTotals {
  income: Decimal;
  expense: Decimal;
}

/** Reads of the dashboard for the user bound to the transaction (RN-09). */
export interface DashboardRepository {
  /**
   * Totals of two inclusive date ranges in one query: each movement is converted with its stored
   * rates (RN-05) and what RN-02 leaves out does not count. A movement dated before the initial
   * balance of its account still counts (RN-12).
   */
  totals(
    current: { from: LocalDate; to: LocalDate },
    previous: { from: LocalDate; to: LocalDate },
    base: string,
  ): Promise<{ current: PeriodTotals; previous: PeriodTotals }>;
  /** Month (`YYYY-MM`) of the first movement or the first initial balance, or `null` without any. */
  firstMonth(): Promise<string | null>;
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
  /** Replaces the symbol of the user's currency with that code. */
  updateSymbol(code: string, symbol: string): Promise<void>;
  /** Sets the status of the user's currency with that code (plan §4.3.3). */
  setStatus(code: string, status: CurrencyStatus): Promise<void>;
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
  /** Archives the account if it is active (`UPDATE … WHERE status = 'active'`); `false` otherwise. */
  archive(id: string): Promise<boolean>;
  /** Restores the archived account with that name; `false` when it was not archived. */
  restore(id: string, name: string): Promise<boolean>;
  /** Deletes the account; its shortcuts go with it (RF-M4-13). */
  remove(id: string): Promise<void>;
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

/** What an edit rewrites of the header of a movement; its kind and origin never change (RF-M6-06). */
export type LedgerTransactionChanges = Pick<
  LedgerTransactionHeader,
  'date' | 'note' | 'categoryId' | 'rateCurBob' | 'rateUsdBob' | 'declaredRate'
>;

/** An entry of an edited movement: its account and its signed amount (ADR-04). */
export type LedgerEntryChange = Omit<LedgerEntryInput, 'id'>;

export interface BalancePoint {
  date: LocalDate;
  balance: Decimal;
}

/** Filters of the movement list once the month is resolved (`ListQuery`, plan §4.6.1). */
export interface LedgerListFilters {
  /** First day of the range, included. */
  from: LocalDate;
  /** Last day of the range, included. */
  to: LocalDate;
  /** Page size. */
  limit: number;
  /** Movements with an entry on that account, transfers included. */
  accountId?: string;
  /** The category or any of its subcategories (RF-M5-03). */
  categoryId?: string;
  kind?: TransactionKind;
  /** A fragment of the note, ignoring case and accents, or an exact amount in its own currency. */
  q?: string;
}

/** An entry as it is read, with the currency of its account. */
export interface LedgerEntryView {
  accountId: string;
  currencyCode: string;
  /** Signed: positive comes into the account, negative goes out (ADR-04). */
  amount: Decimal;
}

/** A movement of the ledger as it is read, with its entries. */
export interface LedgerTransactionView {
  id: string;
  kind: TransactionKind;
  date: LocalDate;
  note: string | null;
  categoryId: string | null;
  origin: TransactionOrigin;
  /** The debt, payment or goal it comes from, for "Ir a…". */
  originId: string | null;
  parentTransactionId: string | null;
  recurringLabel: string | null;
  rateCurBob: Decimal;
  rateUsdBob: Decimal | null;
  declaredRate: Decimal | null;
  createdAt: Date;
  entries: LedgerEntryView[];
}

/** A movement with its fee: the transaction with `origin = fee` whose parent it is (RF-M6-05). */
export interface LedgerTransactionDetail extends LedgerTransactionView {
  fee: LedgerTransactionView | null;
}

/** Income minus expense of a day in the base currency, without what RN-02 leaves out. */
export interface DayNet {
  date: LocalDate;
  net: Decimal;
}

export interface LedgerPage {
  /** From the most recent to the oldest by `(date, created_at, id)` (RF-M6-02). */
  items: LedgerTransactionView[];
  /** Opaque; `null` on the last page. */
  nextCursor: string | null;
  /** One per day of the page, most recent first (RF-M6-12). */
  dayNets: DayNet[];
}

/** Totals in the base currency; `expense` is positive and `net = income - expense`. */
export interface LedgerTotals {
  income: Decimal;
  expense: Decimal;
  net: Decimal;
}

/** Which state of a movement `get` reads (plan §4.6.3, ADR-07). */
export interface LedgerGetOptions {
  /**
   * `true` reads the movement only while it is deleted and not yet purged, with its fee only when
   * it is deleted too, for the undo. By default only a movement that is not deleted is read.
   */
  deleted?: boolean;
}

/** Ledger of the user bound to the transaction (ADR-04, RN-09). */
export interface LedgerRepository {
  /**
   * Inserts the header and its entries, which take the header's date. A header whose id already
   * exists is left as it is, with no new entries (ADR-11). Returns `true` when it was inserted.
   */
  insertTransaction(header: LedgerTransactionHeader, entries: LedgerEntryInput[]): Promise<boolean>;
  /**
   * Rewrites in place the header of the user's movement that is not deleted and its entries, which
   * take the header's date: the entries, in the order `get` returns them, take the account and the
   * amount of the change in the same position. No copy nor history is kept (RNF-24). Returns
   * `false` when the user has no such movement.
   */
  updateTransaction(
    id: string,
    changes: LedgerTransactionChanges,
    entries: LedgerEntryChange[],
  ): Promise<boolean>;
  /**
   * Balance of each of the user's accounts among the ids: initial balance plus the entries from the
   * initial balance date on, without deleted transactions (RN-01).
   */
  balances(accountIds: string[]): Promise<Map<string, Decimal>>;
  /** Balance at the end of each day of the range, both ends included, in ascending order (RN-01). */
  balanceSeries(accountId: string, from: LocalDate, to: LocalDate): Promise<BalancePoint[]>;
  /**
   * A page of the movements that are not deleted and match the filters, after `cursor` (the
   * `nextCursor` of the previous page, or `null`). `dayNets` covers every matching movement of the
   * days of the page, in the user's base currency with the rates stored in each one (RN-05).
   * A malformed cursor fails with `VALIDATION_ERROR`.
   */
  list(filters: LedgerListFilters, cursor: string | null): Promise<LedgerPage>;
  /**
   * Income, expense and net of the matching movements in the `base` currency, each converted with
   * its stored rates (RN-05) and without what RN-02 leaves out (RF-M6-12).
   */
  summary(filters: LedgerListFilters, base: string): Promise<LedgerTotals>;
  /**
   * The movement with its entries and its fee, or `null` when the user has no such movement in the
   * state that `options` asks for (not deleted, by default).
   */
  get(id: string, options?: LedgerGetOptions): Promise<LedgerTransactionDetail | null>;
  /**
   * Sets `deleted_at` on the user's movements among the ids that are not deleted; their entries
   * stay until the purge (plan §4.6.3). Returns the ids that changed.
   */
  softDelete(ids: string[]): Promise<string[]>;
  /**
   * Clears `deleted_at` on the user's movements among the ids that are deleted and not yet purged
   * (ADR-07). Returns the ids that changed.
   */
  restore(ids: string[]): Promise<string[]>;
  /**
   * Turns the user's movements among the ids that are not deleted into normal movements
   * (`origin = manual`, without `origin_id`), keeping their category and entries (RF-M13-11).
   * Returns the ids that changed.
   */
  detachOrigin(ids: string[]): Promise<string[]>;
}

// ---------- Categorías (M5) ----------

export interface CategoryRow {
  id: string;
  kind: CategoryKind;
  parentId: string | null;
  name: string;
  color: string;
  icon: string;
  isSystem: boolean;
  status: LifecycleStatus;
  archivedAt: Date | null;
  sortOrder: number;
}

/** A category created by the user: it is always active and never of the system. */
export type NewUserCategory = Pick<
  CategoryRow,
  'id' | 'kind' | 'parentId' | 'name' | 'color' | 'icon' | 'sortOrder'
>;

/** Editable fields of a category; the kind never changes (RF-M5-01). */
export type CategoryPatch = Partial<Pick<CategoryRow, 'name' | 'color' | 'icon' | 'parentId'>>;

/** A node of the two-level tree (`CategoryNode`, plan §4.5.1). */
export interface CategoryTreeNode {
  id: string;
  kind: CategoryKind;
  name: string;
  color: string;
  icon: string;
  isSystem: boolean;
  status: LifecycleStatus;
  children: CategoryTreeNode[];
}

/** What points to a category: its budgets, recurring rules and shortcuts (plan §4.5.1). */
export interface CategoryUsage {
  budgets: { id: string }[];
  recurring: { id: string; name: string }[];
  shortcuts: { id: string; name: string }[];
}

/** Categories of the user bound to the transaction; another user's category does not exist (RN-09). */
export interface CategoryRepository {
  /**
   * The categories of that kind and status as a two-level tree, each level by `sortOrder`. A root
   * is a category without a parent, or one whose parent has another status.
   */
  tree(kind: CategoryKind, status: LifecycleStatus): Promise<CategoryTreeNode[]>;
  get(id: string): Promise<CategoryRow | null>;
  insert(category: NewUserCategory): Promise<void>;
  update(id: string, patch: CategoryPatch): Promise<void>;
  /** Gives each category the position of its id in the list as its `sortOrder`. */
  setOrder(ids: string[]): Promise<void>;
  /** How many categories the user has, active or archived. */
  count(): Promise<number>;
  /** `true` when any transaction uses the category, including deleted ones not yet purged. */
  hasMovements(id: string): Promise<boolean>;
  /** The budgets, recurring rules and shortcuts that use the category. */
  usage(id: string): Promise<CategoryUsage>;
  /** The id of the category and those of its subcategories; `[]` when it does not exist. */
  idsWithChildren(id: string): Promise<string[]>;
  /** The subcategories of the category with that status, by `sortOrder`. */
  children(id: string, status: LifecycleStatus): Promise<CategoryRow[]>;
  /** Gives the categories that status, stamping or clearing `archivedAt` to match. */
  setStatus(ids: string[], status: LifecycleStatus): Promise<void>;
  /** Deletes the categories, subcategories first; their shortcuts go with them (plan §3.8). */
  remove(ids: string[]): Promise<void>;
  /** How many live transactions use the category. */
  countMovements(id: string): Promise<number>;
  /** Moves the transactions, recurring rules and shortcuts of one category to another (merge). */
  moveUsage(fromId: string, toId: string): Promise<void>;
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

// ---------- Registrar: atajos (M7) ----------

export type ShortcutKind = 'expense' | 'income' | 'transfer';

export interface ShortcutRow {
  id: string;
  name: string;
  kind: ShortcutKind;
  amount: Decimal | null;
  accountId: string;
  /** Only in a transfer (RF-M7-09). */
  destAccountId: string | null;
  /** Never in a transfer (RF-M7-09). */
  categoryId: string | null;
  note: string | null;
  sortOrder: number;
}

/** The fields of a shortcut that change; absent fields stay as they are. */
export type ShortcutPatch = Partial<Omit<ShortcutRow, 'id' | 'sortOrder'>>;

/** Shortcuts of the user bound to the transaction (RN-09). */
export interface ShortcutRepository {
  insert(shortcut: ShortcutRow): Promise<void>;
  get(id: string): Promise<ShortcutRow | null>;
  /** Every shortcut, hidden ones included, by `sortOrder`. */
  list(): Promise<ShortcutRow[]>;
  /**
   * The visible shortcuts by `sortOrder`: their account, and their destination or their category,
   * are active (plan §4.7.3).
   */
  listVisible(): Promise<ShortcutRow[]>;
  update(id: string, patch: ShortcutPatch): Promise<void>;
  /** Gives each shortcut the position of its id in the list as its `sortOrder`. */
  setOrder(ids: string[]): Promise<void>;
  /** Deletes the shortcut; `false` when the user has no such shortcut. */
  remove(id: string): Promise<boolean>;
  /** How many shortcuts the user has, hidden ones included (RF-M7-09). */
  count(): Promise<number>;
}

// ---------- Recurrentes (M14) ----------

export type RuleKind = 'expense' | 'income' | 'transfer';
export type RuleMode = 'auto' | 'confirm';
export type RuleStatus = 'active' | 'paused' | 'finished';
export type OccurrenceStatus = 'pending' | 'registered' | 'skipped' | 'omitted';

/** A recurring rule of the user (plan §3.6, §4.14.1). */
export interface RecurringRuleRow {
  id: string;
  name: string;
  kind: RuleKind;
  /** `null` when the amount is "to be defined" (only in confirm mode). */
  amount: Decimal | null;
  accountId: string;
  /** Only in a transfer. */
  destAccountId: string | null;
  /** Never in a transfer. */
  categoryId: string | null;
  note: string | null;
  frequency: RecurrenceFrequency;
  startDate: LocalDate;
  end: RecurrenceEnd;
  mode: RuleMode;
  status: RuleStatus;
  pausedAt: Instant | null;
  generatedCount: number;
  lastGeneratedDate: LocalDate | null;
}

/** A new rule: it is always created active, with nothing generated. */
export type NewRecurringRule = Omit<
  RecurringRuleRow,
  'status' | 'pausedAt' | 'generatedCount' | 'lastGeneratedDate'
>;

/** The fields of a rule that change; absent fields stay as they are. */
export type RecurringRulePatch = Partial<Omit<RecurringRuleRow, 'id'>>;

/** Recurring rules of the user bound to the transaction (RN-09). */
export interface RecurringRuleRepository {
  insert(rule: NewRecurringRule): Promise<void>;
  /** The rule, or `null` when the user has no such rule. */
  get(id: string): Promise<RecurringRuleRow | null>;
  /** Like `get`, locking the row (`FOR UPDATE`) until the end of the transaction. */
  lockForUpdate(id: string): Promise<RecurringRuleRow | null>;
  list(): Promise<RecurringRuleRow[]>;
  update(id: string, patch: RecurringRulePatch): Promise<void>;
  /** Deletes the rule and its occurrences; `false` when the user has no such rule. */
  remove(id: string): Promise<boolean>;
}

/** An occurrence of a rule on a date (plan §3.6). */
export interface RecurringOccurrenceRow {
  id: string;
  ruleId: string;
  scheduledDate: LocalDate;
  status: OccurrenceStatus;
  transactionId: string | null;
  pendingSince: Instant | null;
  decidedAt: Instant | null;
}

/** Occurrences of the user bound to the transaction (RN-09). */
export interface RecurringOccurrenceRepository {
  /**
   * Inserts a pending occurrence of the user's rule on that date and returns it, or `null` when the
   * rule already has one on that date or the user has no such rule (RF-M14-12).
   */
  insertIfAbsent(ruleId: string, date: LocalDate): Promise<RecurringOccurrenceRow | null>;
  /** The user's occurrence in any status; `null` when it does not exist or is another user's. */
  get(id: string): Promise<RecurringOccurrenceRow | null>;
  /** The user's pending occurrences, by date. */
  pending(): Promise<RecurringOccurrenceRow[]>;
  /**
   * Changes the status only when the occurrence is in the expected one; `true` when it changed.
   * Of simultaneous calls, only one succeeds.
   */
  decideIf(id: string, expectedStatus: OccurrenceStatus, newStatus: OccurrenceStatus): Promise<boolean>;
  /** The user's pending occurrences whose `pendingSince` is before the instant. */
  expiredPending(before: Instant): Promise<RecurringOccurrenceRow[]>;
}

// ---------- Deudas y préstamos (M13) ----------

export type DebtDirection = 'i_owe' | 'owed_to_me';
/** Stored status; `overdue` is derived when reading (plan §4.13.2). */
export type StoredDebtStatus = 'active' | 'paid' | 'forgiven';
export type DebtInterestPeriod = 'monthly' | 'yearly';

/** A `debt` row of the user (plan §3.6). */
export interface DebtRow {
  id: string;
  direction: DebtDirection;
  person: string;
  /** `lower(unaccent(person))`: groups a person regardless of case and accents (EC-M13-06). */
  personKey: string;
  principal: Decimal;
  currencyCode: string;
  startDate: LocalDate;
  dueDate: LocalDate | null;
  note: string | null;
  interestRate: Decimal | null;
  interestPeriod: DebtInterestPeriod | null;
  status: StoredDebtStatus;
  forgivenAmount: Decimal | null;
  initialTransactionId: string | null;
  capitalOutstanding: Decimal;
  interestUnpaid: Decimal;
  accruedThrough: LocalDate;
  createdAt: Date;
  updatedAt: Date;
}

/** A new debt: the repository derives `personKey`; it is created active and without interest owed. */
export type NewDebt = Omit<
  DebtRow,
  'personKey' | 'status' | 'forgivenAmount' | 'interestUnpaid' | 'createdAt' | 'updatedAt'
>;

/** The fields of a debt that change; absent fields stay as they are. */
export type DebtPatch = Partial<
  Pick<
    DebtRow,
    | 'person'
    | 'note'
    | 'dueDate'
    | 'principal'
    | 'status'
    | 'forgivenAmount'
    | 'capitalOutstanding'
    | 'interestUnpaid'
    | 'accruedThrough'
    | 'initialTransactionId'
  >
>;

/** Debts of the user bound to the transaction; another user's debt does not exist (RN-09). */
export interface DebtRepository {
  insert(debt: NewDebt): Promise<void>;
  get(id: string): Promise<DebtRow | null>;
  /** Locks the debt row (`SELECT … FOR UPDATE`) and returns it; `null` when there is none. */
  lockForUpdate(id: string): Promise<DebtRow | null>;
  /** Every debt of the user, whatever its status. */
  list(): Promise<DebtRow[]>;
  /** Updates the given fields; a new `person` also recalculates `personKey`. */
  update(id: string, patch: DebtPatch): Promise<void>;
  /** Deletes the debt; its payments go with it. */
  delete(id: string): Promise<void>;
  /** The distinct `person` values the user already used, for the autocompletion (plan §4.13.4). */
  persons(): Promise<string[]>;
}

/** A `debt_payment` row of the user (plan §3.6). */
export interface DebtPaymentRow {
  id: string;
  debtId: string;
  amount: Decimal;
  interestPart: Decimal;
  capitalPart: Decimal;
  date: LocalDate;
  accountId: string | null;
  declaredRate: Decimal | null;
  accountAmount: Decimal | null;
  capitalTransactionId: string | null;
  interestTransactionId: string | null;
  note: string | null;
  createdAt: Date;
}

export type NewDebtPayment = Omit<DebtPaymentRow, 'createdAt'>;

/** Payments of the user's debts bound to the transaction (RN-09). */
export interface DebtPaymentRepository {
  insert(payment: NewDebtPayment): Promise<void>;
  /** The payments of the debt, oldest first. */
  list(debtId: string): Promise<DebtPaymentRow[]>;
  /** The payment with the greatest `created_at`; `null` when the debt has none. */
  last(debtId: string): Promise<DebtPaymentRow | null>;
  delete(id: string): Promise<void>;
}

// ---------- Metas de ahorro (M12) ----------

export type AllocationOrigin =
  'manual' | 'budget' | 'dedicated_account' | 'confirmed_spend' | 'use_and_close' | 'adjustment';

/** A savings goal as stored (plan §3.6). */
export interface GoalRow {
  id: string;
  name: string;
  target: Decimal;
  currencyCode: string;
  /** `YYYY-MM-DD`. */
  targetDate: LocalDate | null;
  icon: string;
  color: string;
  dedicatedAccountId: string | null;
  celebratedAt: Instant | null;
  archivedAt: Instant | null;
}

export type NewGoal = Pick<
  GoalRow,
  'id' | 'name' | 'target' | 'currencyCode' | 'targetDate' | 'icon' | 'color' | 'dedicatedAccountId'
>;

/** The fields of a goal that change; absent fields stay as they are. */
export type GoalPatch = Partial<
  Pick<GoalRow, 'name' | 'target' | 'currencyCode' | 'targetDate' | 'icon' | 'color'>
>;

/** Goals of the user bound to the transaction (RN-09). */
export interface GoalRepository {
  insert(goal: NewGoal): Promise<void>;
  get(id: string): Promise<GoalRow | null>;
  update(id: string, patch: GoalPatch): Promise<void>;
  /** Sets the dedicated account of the goal. */
  setDedicatedAccount(id: string, accountId: string): Promise<void>;
  /** How many goals the user has, archived ones included (RNF-28). */
  count(): Promise<number>;
  /** The goals that are not archived, oldest first. */
  list(): Promise<GoalRow[]>;
  /** The goal that has the account as its dedicated one, if any. */
  findByDedicatedAccount(accountId: string): Promise<GoalRow | null>;
  /** Removes the dedicated account of the goal, which turns it into a normal account. */
  clearDedicatedAccount(id: string): Promise<void>;
  /** Archives the goal, or restores it when `archived` is false. */
  setArchived(id: string, archived: boolean): Promise<void>;
  /** Marks `celebrated_at` once; a goal already celebrated keeps its date. */
  markCelebrated(id: string): Promise<void>;
  /** Deletes the goal. */
  remove(id: string): Promise<void>;
}

export interface NewAllocationEvent {
  id: string;
  goalId: string;
  accountId: string;
  /** Signed: an earmark (+) or a withdrawal (-). */
  amount: Decimal;
  origin: AllocationOrigin;
  relatedTransactionId: string | null;
}

export interface GoalEarmark {
  goalId: string;
  amount: Decimal;
}

export interface AccountEarmark {
  accountId: string;
  amount: Decimal;
}

/** An item of the history of a goal, with its origin (RF-M12-07). */
export interface GoalHistoryItem {
  accountId: string;
  amount: Decimal;
  origin: AllocationOrigin;
  /** `YYYY-MM-DD` date of the item. */
  date: LocalDate;
  createdAt: Instant;
  /** The kind of the ledger movement for items taken from the ledger; `null` for events. */
  ledgerKind: string | null;
}

/** Allocation events of the user bound to the transaction (RN-09). */
export interface GoalAllocationRepository {
  insert(event: NewAllocationEvent): Promise<void>;
  /** Σ of the events on the account, one item per goal. */
  earmarkedByAccount(accountId: string): Promise<GoalEarmark[]>;
  /** Σ of the events of the goal, one item per account. */
  earmarkedByGoal(goalId: string): Promise<AccountEarmark[]>;
  /** The events of the goal plus the ledger entries of its dedicated account (RF-M12-07). */
  history(goalId: string): Promise<GoalHistoryItem[]>;
  /** Deletes all the events of the goal. */
  deleteByGoal(goalId: string): Promise<void>;
}

// ---------- Presupuestos (M11) ----------

export type BudgetScope = 'category' | 'general';
export type BudgetDefaultAction = 'discard' | 'carry';
export type BudgetStatus = 'active' | 'paused' | 'finalizing' | 'finalized';
export type BudgetPeriodStatus = 'open' | 'closed_pending' | 'decided' | 'defaulted';

/** A budget as stored (plan §3.6). */
export interface BudgetRow {
  id: string;
  scope: BudgetScope;
  /** `null` in the general budget. */
  categoryId: string | null;
  amount: Decimal;
  currencyCode: string;
  startDay: number;
  /** The start day that applies from the next period on (RF-M11-06). */
  nextStartDay: number | null;
  defaultAction: BudgetDefaultAction;
  thresholds: number[];
  status: BudgetStatus;
  frozenCarryover: Decimal | null;
}

export type NewBudget = Pick<
  BudgetRow,
  | 'id'
  | 'scope'
  | 'categoryId'
  | 'amount'
  | 'currencyCode'
  | 'startDay'
  | 'defaultAction'
  | 'thresholds'
>;

/** The fields of a budget that change; absent fields stay as they are. */
export type BudgetPatch = Partial<
  Pick<
    BudgetRow,
    | 'amount'
    | 'defaultAction'
    | 'thresholds'
    | 'startDay'
    | 'nextStartDay'
    | 'status'
    | 'frozenCarryover'
  >
>;

/** Budgets of the user bound to the transaction (RN-09). */
export interface BudgetRepository {
  insert(budget: NewBudget): Promise<void>;
  get(id: string): Promise<BudgetRow | null>;
  update(id: string, patch: BudgetPatch): Promise<void>;
  /** Deletes the budget with its periods, late adjustments and threshold notices. */
  delete(id: string): Promise<void>;
  /** How many budgets the user has, in any status. */
  count(): Promise<number>;
  /** The budgets of the user, in any status, oldest first. */
  list(): Promise<BudgetRow[]>;
  /**
   * The id of the active, paused or finalizing budget of that category, or of the general one when
   * `categoryId` is `null` (RF-M11-01); `null` when there is none.
   */
  findLive(categoryId: string | null): Promise<string | null>;
  /** The system key of the category of the user, `null` for one of the user or a missing one. */
  categorySystemKey(categoryId: string): Promise<SystemCategoryKey | null>;
  /** The closed period of the budget that waits for a decision, with its deadline (RF-M11-08). */
  pendingClose(budgetId: string): Promise<PendingClosePeriod | null>;
  /**
   * The budgets, in any status, whose scope includes any of the categories: the general one, the
   * budget of the category and that of its parent (RF-M11-02).
   */
  listAffected(categoryIds: string[]): Promise<BudgetRow[]>;
  /**
   * Moves the active or paused budgets of the categories to `finalizing`: they last until the end of
   * their period in course (RF-M5-07, EC-M11-04).
   */
  finalizeForCategories(categoryIds: string[]): Promise<void>;
  /** Moves every budget of the category `fromId`, in any status, to the category `toId` (RF-M5-08). */
  moveToCategory(fromId: string, toId: string): Promise<void>;
  /** `true` when an active or paused budget uses the currency (EC-M3-05). */
  usesCurrency(code: string): Promise<boolean>;
  /**
   * The users, of every user and not only the bound one, with an `open` period whose end is
   * before their today at `now`, in the timezone of each user (`budgets.close` tick, RNF-20).
   */
  ownersWithEndedPeriods(now: Instant): Promise<string[]>;
  /**
   * The users, of every user and not only the bound one, with a `closed_pending` period whose
   * decision deadline is before `now` (`budgets.defaultDecision` tick).
   */
  ownersWithOverdueDecisions(now: Instant): Promise<string[]>;
}

/** A closed period that waits for its decision, with the deadline to make it. */
export interface PendingClosePeriod {
  id: string;
  /** `YYYY-MM-DD`. */
  startDate: LocalDate;
  /** `YYYY-MM-DD`. */
  endDate: LocalDate;
  amount: Decimal;
  carryoverIn: Decimal;
  deadline: Instant | null;
}

/** A period of a budget as stored (plan §3.6). */
export interface BudgetPeriodRow {
  id: string;
  budgetId: string;
  /** `YYYY-MM-DD`. */
  startDate: LocalDate;
  /** `YYYY-MM-DD`. */
  endDate: LocalDate;
  /** The amount of the budget in force in the period. */
  amount: Decimal;
  carryoverIn: Decimal;
  status: BudgetPeriodStatus;
}

export type NewBudgetPeriod = Pick<
  BudgetPeriodRow,
  'id' | 'budgetId' | 'startDate' | 'endDate' | 'amount' | 'carryoverIn'
>;

/** The fields of a period that change; absent fields stay as they are. */
export type BudgetPeriodPatch = Partial<Pick<BudgetPeriodRow, 'endDate' | 'amount' | 'carryoverIn'>>;

export interface NewLateAdjustment {
  id: string;
  /** The period in course. */
  periodId: string;
  /** The closed period the late movement belongs to. */
  sourcePeriodId: string;
  /** Signed amount, in the currency of the budget. */
  amount: Decimal;
}

export interface LateAdjustmentRow {
  id: string;
  sourcePeriodId: string;
  amount: Decimal;
  /** Set by "Reiniciar arrastre". */
  voidedAt: Instant | null;
}

/** A closed period with what was frozen when its decision was made (RF-M11-11). */
export interface ClosedBudgetPeriod {
  id: string;
  /** `YYYY-MM-DD`. */
  startDate: LocalDate;
  /** `YYYY-MM-DD`. */
  endDate: LocalDate;
  /** The `DecisionInput` that was applied, as stored in the `decision` jsonb. */
  decision: unknown;
  spentAtDecision: Decimal | null;
  /** Σ of the late adjustments already made for this period, voided ones included. */
  adjusted: Decimal;
}

/** What a decision freezes on its closed period (plan §4.11.3). */
export interface PeriodDecision {
  spentAtDecision: Decimal;
  /** Surplus (positive) or deficit (negative): available − spent. */
  resultAtDecision: Decimal;
  /** The `DecisionInput` that was applied, kept in the `decision` jsonb. */
  decision: unknown;
}

/** Periods, late adjustments and threshold notices of the user bound to the transaction (RN-09). */
export interface BudgetPeriodRepository {
  insert(period: NewBudgetPeriod): Promise<void>;
  get(id: string): Promise<BudgetPeriodRow | null>;
  /** The periods of the budget, newest first, at most `limit`. */
  listByBudget(budgetId: string, limit: number): Promise<BudgetPeriodRow[]>;
  update(id: string, patch: BudgetPeriodPatch): Promise<void>;
  /** Deletes the period with its late adjustments and threshold notices. */
  delete(id: string): Promise<void>;
  insertLateAdjustment(adjustment: NewLateAdjustment): Promise<void>;
  /** The late adjustments of the period, oldest first, voided ones included. */
  lateAdjustments(periodId: string): Promise<LateAdjustmentRow[]>;
  /** Voids the live late adjustments of the period ("Reiniciar arrastre"). */
  voidLateAdjustments(periodId: string): Promise<void>;
  /** Saves the notice of the threshold; `false` when the period already had it (RN-10). */
  recordThresholdHit(periodId: string, threshold: number): Promise<boolean>;
  /** The `open` period of the budget, the one in course. */
  current(budgetId: string): Promise<BudgetPeriodRow | null>;
  /**
   * The `open` periods whose end is before the today of the user at `now`, in their timezone
   * (RNF-20), oldest first.
   */
  listEnded(now: Instant): Promise<BudgetPeriodRow[]>;
  /**
   * Moves the period from `open` to `closed_pending` with its decision deadline; `false` when it
   * was no longer open (RNF-13).
   */
  close(id: string, deadline: Instant): Promise<boolean>;
  /**
   * Moves the period from `closed_pending` to `decided` with what was frozen at the decision;
   * `false` when it was no longer pending (RNF-11).
   */
  decide(id: string, decision: PeriodDecision): Promise<boolean>;
  /**
   * `true` when a budget of the category, in any status, has a closed period that waits for its
   * decision (RF-M5-08).
   */
  hasPendingCloseInCategory(categoryId: string): Promise<boolean>;
  /** The `closed_pending` periods whose decision deadline is before `now`, oldest first. */
  listOverdue(now: Instant): Promise<BudgetPeriodRow[]>;
  /**
   * Moves the period from `closed_pending` to `defaulted` with what was frozen when the default
   * action applied; `false` when it was no longer pending (RNF-12).
   */
  applyDefault(id: string, decision: PeriodDecision): Promise<boolean>;
  /** The decided or defaulted periods of the budget that contain any of the dates (RF-M11-11). */
  closedContaining(budgetId: string, dates: LocalDate[]): Promise<ClosedBudgetPeriod[]>;
  /**
   * Σ of the expenses of the scope of the budget within the period (a category with its
   * subcategories; the general one, every expense), without what RN-02 leaves out, converted to the
   * currency of the budget with the rates each movement stored (RF-M11-02, RF-M11-03).
   */
  spent(
    budget: Pick<BudgetRow, 'scope' | 'categoryId' | 'currencyCode'>,
    period: Pick<BudgetPeriodRow, 'startDate' | 'endDate'>,
  ): Promise<Decimal>;
}
