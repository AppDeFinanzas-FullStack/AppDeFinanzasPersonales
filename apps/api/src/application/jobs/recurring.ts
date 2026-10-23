import { BOLIVIA_TIME_ZONE } from '@finanzas/domain';
import { uuidv7 } from 'uuidv7';

import type { Clock } from '../ports/clock.js';
import type { UnitOfWork } from '../ports/unit-of-work.js';
import type { RecurringGenerator, UserTimezones } from '../shared/recurring-generator.js';

/** The users the recurring jobs walk, read across users (plan §4.14.3). */
export interface RecurringUsers extends UserTimezones {
  /** The users with an active recurring rule, for `recurring.generate`. */
  withActiveRules(): Promise<string[]>;
  /**
   * The users with a pending occurrence whose `pending_since` is before that instant, whatever the
   * status of its rule, for `recurring.expirePending` (RF-M14-07).
   */
  withExpiredPending(before: Date): Promise<string[]>;
}

export interface RecurringJobsDeps {
  uow: UnitOfWork;
  generator: RecurringGenerator;
  users: RecurringUsers;
  clock: Clock;
}

export interface RecurringJobs {
  /** `recurring.generate` for every user with an active rule (plan §4.0, §4.14.3). */
  generate(): Promise<void>;
  /** `recurring.generate` for one user only, under its lock (ADR-01, RNF-13). */
  generateForUser(userId: string): Promise<void>;
  /** `recurring.expirePending` for every user with an expired pending (plan §4.14.3, RF-M14-07). */
  expirePending(): Promise<void>;
  /** `recurring.expirePending` for one user only, under its lock (ADR-01, RNF-13). */
  expirePendingForUser(userId: string): Promise<void>;
}

/** How long a pending occurrence waits for a decision before it is omitted (RF-M14-07). */
const PENDING_LIFETIME_MS = 30 * 86_400_000;

/** Where the notification of an omitted occurrence leads (plan §4.14.4). */
const PENDING_ROUTE = '/recurrentes';

/** Runs the job for each user; one user's failure does not stop the others (RNF-13). */
async function forEachUser(
  userIds: string[],
  run: (userId: string) => Promise<void>,
): Promise<void> {
  let failure: Error | null = null;
  for (const userId of userIds) {
    try {
      await run(userId);
    } catch (error) {
      // The next tick retries the user that failed (RNF-13).
      failure = error instanceof Error ? error : new Error(String(error));
    }
  }
  if (failure !== null) {
    throw failure;
  }
}

export function createRecurringJobs({
  uow,
  generator,
  users,
  clock,
}: RecurringJobsDeps): RecurringJobs {
  async function generateForUser(userId: string): Promise<void> {
    // "Today" is the date in the zone of the user's profile, compared as a date (RNF-20, RF-M14-04).
    const today = clock.todayFor((await users.timezoneOf(userId)) ?? BOLIVIA_TIME_ZONE);
    await uow.run(
      async (repos) => {
        const rules = await repos.recurringRules.list();
        for (const { id, status } of rules) {
          if (status !== 'active') continue;
          const rule = await repos.recurringRules.lockForUpdate(id);
          if (rule === null || rule.status !== 'active') continue;
          await generator.generateDue(repos, userId, rule, today);
        }
      },
      { userLock: userId },
    );
  }

  /** The 30 days count from `pending_since`, also for occurrences recovered after an outage (RNF-13). */
  const expiredBefore = (): Date => new Date(clock.now().getTime() - PENDING_LIFETIME_MS);

  async function expirePendingForUser(userId: string): Promise<void> {
    const before = expiredBefore();
    await uow.run(
      async (repos) => {
        const notify = await repos.notificationPreferences.isEnabled(userId, 'recurring_pending');
        for (const occurrence of await repos.recurringOccurrences.expiredPending(before)) {
          // Only a pending occurrence is omitted, and only once (RNF-11).
          if (!(await repos.recurringOccurrences.decideIf(occurrence.id, 'pending', 'omitted'))) {
            continue;
          }
          await repos.notifications.resolveDecision(userId, 'occurrence', occurrence.id);
          if (!notify) continue;
          const rule = await repos.recurringRules.get(occurrence.ruleId);
          await repos.notifications.insertIfAbsent({
            id: uuidv7(),
            userId,
            type: 'recurring_pending',
            eventKey: `recurring_omitted:${occurrence.id}`,
            params: {
              ruleId: occurrence.ruleId,
              ruleName: rule?.name ?? null,
              date: occurrence.scheduledDate,
            },
            targetRoute: PENDING_ROUTE,
          });
        }
      },
      { userLock: userId },
    );
  }

  return {
    generateForUser,
    expirePendingForUser,

    async generate() {
      await forEachUser(await users.withActiveRules(), generateForUser);
    },

    async expirePending() {
      await forEachUser(await users.withExpiredPending(expiredBefore()), expirePendingForUser);
    },
  };
}
