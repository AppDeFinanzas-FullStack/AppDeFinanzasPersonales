import type { Instant } from './clock.js';
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
}
