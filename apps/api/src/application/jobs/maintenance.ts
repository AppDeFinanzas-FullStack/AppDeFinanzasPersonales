import type { Clock } from '../ports/clock.js';
import type { MaintenanceStore } from '../ports/maintenance-store.js';
import type { JobHandler } from './tick.js';

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;

/** Unconfirmed registrations are discarded after 7 days (RF-M1-06, RNF-26). */
const UNCONFIRMED_RETENTION_MS = 7 * DAY_MS;
/** The email send log is kept for 24 h (RNF-26). */
const SEND_LOG_RETENTION_MS = DAY_MS;
/** A login throttle without activity for 1 h is dropped (RNF-26). */
const THROTTLE_RETENTION_MS = HOUR_MS;

export interface MaintenanceDeps {
  store: MaintenanceStore;
  clock: Clock;
}

/**
 * The `maintenance` job: discards the unconfirmed registrations and purges the security tables
 * (plan §4.1.3, §3.9). Each deletion is independent and idempotent.
 */
export function createMaintenance({ store, clock }: MaintenanceDeps): JobHandler {
  return async () => {
    const now = clock.now().getTime();
    await store.deleteUnconfirmedUsers(new Date(now - UNCONFIRMED_RETENTION_MS));
    await store.deleteSendLogs(new Date(now - SEND_LOG_RETENTION_MS));
    await store.deleteLoginThrottles(new Date(now - THROTTLE_RETENTION_MS));
  };
}
