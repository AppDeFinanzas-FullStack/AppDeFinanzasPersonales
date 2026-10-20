import { uuidv7 } from 'uuidv7';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { createOutboxSend } from '../../src/application/jobs/outbox.js';
import type { Clock } from '../../src/application/ports/clock.js';
import type { SendEmailInput } from '../../src/application/ports/email-gateway.js';
import type { UnitOfWork } from '../../src/application/ports/unit-of-work.js';
import { FakeEmailGateway } from '../../src/infrastructure/integrations/resend.fake.js';
import { createEmailOutboxRepository } from '../../src/infrastructure/persistence/repositories/email-outbox.repository.js';
import { createUnitOfWork } from '../../src/infrastructure/persistence/unit-of-work.js';
import { disconnectTestPrisma, testPrisma } from './setup/db.js';

/**
 * The plan fixes the `email_outbox` table (§3.3), `enqueue(tx, email)` and the retry sequence
 * (1, 5, 15 and 60 min, then `failed`), but not the names of the pieces. These tests use:
 * - `createEmailOutboxRepository(tx)`: the repository bound to the transaction of a `UnitOfWork`
 *   run (plan §1.4), exposed as `repos.emailOutbox`, with `enqueue({ id, to, kind, payload })`;
 * - `createOutboxSend({ uow, emailGateway, clock })`: the `outbox.send` job. It returns a
 *   `JobHandler` (`() => Promise<void>`) that takes the due pending rows, sends each one through
 *   the gateway and deletes the sent ones. The attempt counter counts the sends tried: after the
 *   n-th failure the next attempt is 1, 5, 15 or 60 min later; after the 5th failure the row is
 *   marked `failed` and is no longer picked up.
 * The time comes from the job's `Clock`.
 */
const uow: UnitOfWork = createUnitOfWork(
  testPrisma(),
  (tx) => ({ emailOutbox: createEmailOutboxRepository(tx) }),
);

const ADDRESS_SUFFIX = '@outbox-test.example';
const MINUTE = 60_000;
const RETRY_MINUTES = [1, 5, 15, 60] as const;

interface FakeClock extends Clock {
  set(at: Date): void;
}

/** Clock that stays still until a test moves it. */
function fakeClock(start: Date): FakeClock {
  let current = start.getTime();
  return {
    now: () => new Date(current),
    todayFor: () => new Date(current).toISOString().slice(0, 10),
    set: (at) => {
      current = at.getTime();
    },
  };
}

/** Fake gateway that can be told to fail, like a mail service that is down (EC-M1-07). */
class FlakyGateway extends FakeEmailGateway {
  failing = false;
  calls = 0;

  override async send(input: SendEmailInput): Promise<void> {
    this.calls += 1;
    if (this.failing) {
      throw new Error('mail service down');
    }
    return super.send(input);
  }
}

interface OutboxRow {
  id: string;
  toAddress: string;
  kind: string;
  payload: unknown;
  status: string;
  attempts: number;
  nextAttemptAt: Date;
  lastError: string | null;
}

const addressOf = (name: string) => `${name}-${uuidv7().slice(-8)}${ADDRESS_SUFFIX}`;

async function rowsOf(to: string): Promise<OutboxRow[]> {
  return testPrisma().$queryRaw<OutboxRow[]>`
    SELECT id::text AS id, to_address AS "toAddress", kind::text AS kind, payload,
           status::text AS status, attempts, next_attempt_at AS "nextAttemptAt",
           last_error AS "lastError"
    FROM email_outbox WHERE to_address = ${to}`;
}

async function rowOf(to: string): Promise<OutboxRow | undefined> {
  return (await rowsOf(to))[0];
}

async function enqueue(to: string, link = 'https://app.example/confirmar?t=abc'): Promise<string> {
  const id = uuidv7();
  await uow.run((repos) =>
    (
      repos
    ).emailOutbox.enqueue({
      id,
      to,
      kind: 'confirm',
      payload: { link },
    }),
  );
  return id;
}

/** Start of the fake clock: a day ahead of the real one, so every freshly enqueued row is due. */
const t0 = new Date(Math.floor(Date.now() / 1000) * 1000 + 24 * 60 * MINUTE);
const at = (ms: number) => new Date(t0.getTime() + ms);

beforeEach(async () => {
  await testPrisma()
    .$executeRaw`DELETE FROM email_outbox WHERE to_address LIKE ${'%' + ADDRESS_SUFFIX}`;
});

afterAll(async () => {
  await testPrisma()
    .$executeRaw`DELETE FROM email_outbox WHERE to_address LIKE ${'%' + ADDRESS_SUFFIX}`;
  await disconnectTestPrisma();
});

function setup() {
  const clock = fakeClock(t0);
  const gateway = new FlakyGateway();
  const job = createOutboxSend({ uow, emailGateway: gateway, clock });
  return { clock, gateway, job };
}

describe('enqueue', () => {
  it('TASK-049 enqueue inserta una fila pendiente con sus datos en email_outbox', async () => {
    const to = addressOf('enq');
    const id = await enqueue(to);

    const row = await rowOf(to);
    expect(row).toBeDefined();
    expect(row?.id).toBe(id);
    expect(row?.kind).toBe('confirm');
    expect(row?.status).toBe('pending');
    expect(row?.attempts).toBe(0);
    expect(row?.payload).toEqual({ link: 'https://app.example/confirmar?t=abc' });
  });

  it('TASK-049 enqueue dentro de una transacción revertida no deja fila', async () => {
    const to = addressOf('rollback');
    await expect(
      uow.run(async (repos) => {
        await (
          repos
        ).emailOutbox.enqueue({ id: uuidv7(), to, kind: 'confirm', payload: { link: 'x' } });
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    expect(await rowsOf(to)).toHaveLength(0);
  });
});

describe('outbox.send', () => {
  it('RNF-22 un correo enviado borra su fila', async () => {
    const { gateway, job } = setup();
    const to = addressOf('sent');
    await enqueue(to);

    await job();

    const inbox = gateway.inboxOf(to);
    expect(inbox).toHaveLength(1);
    expect(inbox[0]?.kind).toBe('confirm');
    expect(inbox[0]?.payload).toEqual({ link: 'https://app.example/confirmar?t=abc' });
    expect(await rowsOf(to)).toHaveLength(0);
  });

  it('RNF-22 un correo pendiente que falla sigue en la bandeja y se reintenta', async () => {
    const { clock, gateway, job } = setup();
    const to = addressOf('pending');
    await enqueue(to);
    gateway.failing = true;

    await job();
    const afterFailure = await rowOf(to);
    expect(afterFailure?.status).toBe('pending');
    expect(afterFailure?.attempts).toBe(1);
    expect(afterFailure?.lastError).toBeTruthy();

    gateway.failing = false;
    clock.set(at(MINUTE));
    await job();

    expect(gateway.inboxOf(to)).toHaveLength(1);
    expect(await rowsOf(to)).toHaveLength(0);
  });

  it('RNF-22 un correo pendiente que aún no vence no se envía ni se borra', async () => {
    const { gateway, job } = setup();
    const to = addressOf('future');
    await enqueue(to);
    await testPrisma().$executeRaw`
      UPDATE email_outbox SET next_attempt_at = ${at(10 * MINUTE)} WHERE to_address = ${to}`;

    await job();

    expect(gateway.inboxOf(to)).toHaveLength(0);
    expect((await rowOf(to))?.status).toBe('pending');
  });

  it('EC-M1-07 con el servicio de correo caído los reintentos siguen 1, 5, 15 y 60 minutos y luego queda failed', async () => {
    const { clock, gateway, job } = setup();
    const to = addressOf('retries');
    await enqueue(to);
    gateway.failing = true;

    let now = t0;
    for (const [index, minutes] of RETRY_MINUTES.entries()) {
      clock.set(now);
      await job();
      const row = await rowOf(to);
      expect(row?.status).toBe('pending');
      expect(row?.attempts).toBe(index + 1);
      expect(row?.nextAttemptAt.getTime()).toBe(now.getTime() + minutes * MINUTE);

      // One second before the retry is due: the row is not touched.
      const callsBefore = gateway.calls;
      clock.set(new Date(now.getTime() + minutes * MINUTE - 1000));
      await job();
      expect(gateway.calls).toBe(callsBefore);

      now = new Date(now.getTime() + minutes * MINUTE);
    }

    clock.set(now);
    await job();
    const failed = await rowOf(to);
    expect(failed?.status).toBe('failed');
    expect(failed?.attempts).toBe(5);
    expect(failed?.lastError).toBeTruthy();
    expect(gateway.inboxOf(to)).toHaveLength(0);

    // A failed row is not picked up again.
    const calls = gateway.calls;
    clock.set(new Date(now.getTime() + 24 * 60 * MINUTE));
    await job();
    expect(gateway.calls).toBe(calls);
    expect((await rowOf(to))?.status).toBe('failed');
  });

  it('EC-M1-07 el job no repite el envío de un correo ya enviado', async () => {
    const { gateway, job } = setup();
    const to = addressOf('once');
    await enqueue(to);

    await job();
    await job();

    expect(gateway.inboxOf(to)).toHaveLength(1);
  });

  it('EC-M1-07 un correo que falla no impide enviar los demás de la bandeja', async () => {
    const { gateway, job } = setup();
    const bad = addressOf('bad');
    const good = addressOf('good');
    await enqueue(bad);
    await enqueue(good);

    const original = gateway.send.bind(gateway);
    gateway.send = async (input) => {
      if (input.to === bad) {
        throw new Error('rejected');
      }
      return original(input);
    };

    await job();

    expect(gateway.inboxOf(good)).toHaveLength(1);
    expect(await rowsOf(good)).toHaveLength(0);
    const badRow = await rowOf(bad);
    expect(badRow?.status).toBe('pending');
    expect(badRow?.attempts).toBe(1);
  });
});
