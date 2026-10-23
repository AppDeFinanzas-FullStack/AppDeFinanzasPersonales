import { BOLIVIA_TIME_ZONE } from '@finanzas/domain';

import type { Clock } from '../ports/clock.js';
import type { UnitOfWork } from '../ports/unit-of-work.js';
import type { RecurringGenerator, UserTimezones } from '../shared/recurring-generator.js';

/** The users that have an active recurring rule, read across users by the job (plan §4.14.3). */
export interface RecurringUsers extends UserTimezones {
  withActiveRules(): Promise<string[]>;
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

  return {
    generateForUser,

    async generate() {
      let failure: Error | null = null;
      for (const userId of await users.withActiveRules()) {
        try {
          await generateForUser(userId);
        } catch (error) {
          // One user's failure does not stop the others; the next tick retries it (RNF-13).
          failure = error instanceof Error ? error : new Error(String(error));
        }
      }
      if (failure !== null) {
        throw failure;
      }
    },
  };
}
