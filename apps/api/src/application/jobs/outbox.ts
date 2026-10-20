import type { Clock } from '../ports/clock.js';
import type { EmailGateway } from '../ports/email-gateway.js';
import type { UnitOfWork } from '../ports/unit-of-work.js';
import type { JobHandler } from './tick.js';

/** Wait before each retry after the n-th failure: 1, 5, 15 and 60 min (plan §4.1.3, EC-M1-07). */
const RETRY_MINUTES = [1, 5, 15, 60] as const;

/** Rows taken per run, so one run stays within the tick budget (plan §4.0). */
const BATCH_SIZE = 50;

const MINUTE_MS = 60_000;

export interface OutboxSendDeps {
  uow: UnitOfWork;
  emailGateway: EmailGateway;
  clock: Clock;
}

const describeError = (error: unknown): string =>
  error instanceof Error ? `${error.name}: ${error.message}` : String(error);

/**
 * The `outbox.send` job: sends the due pending emails and deletes each one that was sent. A failed
 * send is retried after 1, 5, 15 and 60 min; after the fifth failure the row is marked `failed`.
 * A failure of one email does not stop the others (RNF-22, EC-M1-07).
 */
export function createOutboxSend({ uow, emailGateway, clock }: OutboxSendDeps): JobHandler {
  return async () => {
    const due = await uow.run((repos) => repos.emailOutbox.findDue(clock.now(), BATCH_SIZE), {
      readOnly: true,
    });

    for (const email of due) {
      try {
        await emailGateway.send({ to: email.to, kind: email.kind, payload: email.payload });
      } catch (error) {
        const attempts = email.attempts + 1;
        const wait = RETRY_MINUTES[attempts - 1];
        const failedAt = clock.now();
        const nextAttemptAt =
          wait === undefined ? null : new Date(failedAt.getTime() + wait * MINUTE_MS);
        await uow.run((repos) =>
          repos.emailOutbox.recordFailure(email.id, attempts, nextAttemptAt, describeError(error)),
        );
        continue;
      }
      await uow.run((repos) => repos.emailOutbox.remove(email.id));
    }
  };
}
