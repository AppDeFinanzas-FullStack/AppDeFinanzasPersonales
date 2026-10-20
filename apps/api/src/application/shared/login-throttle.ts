import { createHmac } from 'node:crypto';

import type { UnitOfWork } from '../ports/unit-of-work.js';

export interface LoginThrottle {
  /** Seconds left of the wait for that email; `0` when it can try. */
  check(email: string): Promise<number>;
  /** Counts a failed attempt, whether or not an account has that email (EC-M1-12). */
  fail(email: string): Promise<void>;
  /** A successful login forgets the failures. */
  reset(email: string): Promise<void>;
  /** `true` at most once per hour per email. */
  shouldAlert(email: string): Promise<boolean>;
}

export interface LoginThrottleDeps {
  uow: UnitOfWork;
  hmacSecret: string;
}

/** Progressive wait after failed logins (RF-M1-08), keyed by HMAC-SHA256 of the email (plan §3.9). */
export function createLoginThrottle({ uow, hmacSecret }: LoginThrottleDeps): LoginThrottle {
  const keyOf = (email: string) =>
    createHmac('sha256', hmacSecret).update(email.toLowerCase()).digest('hex');

  return {
    check: (email) =>
      uow.run((repos) => repos.loginThrottle.remainingSeconds(keyOf(email)), { readOnly: true }),
    fail: (email) => uow.run((repos) => repos.loginThrottle.recordFailure(keyOf(email))),
    reset: (email) => uow.run((repos) => repos.loginThrottle.reset(keyOf(email))),
    shouldAlert: (email) => uow.run((repos) => repos.loginThrottle.claimAlert(keyOf(email))),
  };
}
