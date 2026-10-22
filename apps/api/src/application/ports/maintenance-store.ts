import type { Instant } from './clock.js';

/** Deletions of the `maintenance` job (plan §4.1.3, §3.9); each one takes its cutoff instant. */
export interface MaintenanceStore {
  /** Deletes the unconfirmed users registered before the cutoff (RF-M1-06). */
  deleteUnconfirmedUsers(registeredBefore: Instant): Promise<void>;
  /** Deletes the email send log rows sent before the cutoff (RNF-26). */
  deleteSendLogs(sentBefore: Instant): Promise<void>;
  /** Deletes the login throttle rows whose last failure is before the cutoff (RNF-26). */
  deleteLoginThrottles(lastFailureBefore: Instant): Promise<void>;
  /**
   * Deletes for good the movements deleted before the cutoff; their entries and fees go with them
   * (plan §4.6.3, ADR-07).
   */
  deleteRemovedTransactions(deletedBefore: Instant): Promise<void>;
  /** Deletes the undo actions that expired before the cutoff (ADR-07). */
  deleteExpiredUndoActions(expiredBefore: Instant): Promise<void>;
  /**
   * Deletes the notifications created before the cutoff, except those awaiting a decision
   * (RF-M15-05, plan §4.15.3).
   */
  deleteOldNotifications(createdBefore: Instant): Promise<void>;
}
