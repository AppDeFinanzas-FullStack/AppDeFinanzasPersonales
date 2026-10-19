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
  | { ok: true; userId: string; purpose: EmailLinkPurpose }
  | { ok: false; reason: EmailLinkFailure };

/** Single-use links sent by email; only the SHA-256 of each token is stored (plan §4.1.3). */
export interface EmailLinkRepository {
  /** Invalidates the user's current link of that purpose and issues a new one. */
  create(userId: string, purpose: EmailLinkPurpose): Promise<{ token: string; expiresAt: Date }>;
  /** Marks the link as used. Of simultaneous calls with the same token, only one succeeds. */
  consume(token: string, purpose: EmailLinkPurpose): Promise<ConsumeEmailLinkResult>;
}

/**
 * Repositories bound to a transaction and to a user (ADR-05).
 * Each module adds its own repository here.
 */
export interface Repositories {
  emailOutbox: EmailOutboxRepository;
  emailLinks: EmailLinkRepository;
}
