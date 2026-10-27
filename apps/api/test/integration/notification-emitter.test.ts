import type { Release } from '@finanzas/contracts';
import { uuidv7 } from 'uuidv7';
import { afterAll, describe, expect, it } from 'vitest';

import type { Repositories } from '../../src/application/ports/repositories.js';
import type { UnitOfWork } from '../../src/application/ports/unit-of-work.js';
import { createNotificationEmitter } from '../../src/application/shared/notification-emitter.js';
import { createEmailOutboxRepository } from '../../src/infrastructure/persistence/repositories/email-outbox.repository.js';
import { createNotificationPreferenceRepository } from '../../src/infrastructure/persistence/repositories/notification-preference.repository.js';
import { createNotificationRepository } from '../../src/infrastructure/persistence/repositories/notification.repository.js';
import { createUnitOfWork } from '../../src/infrastructure/persistence/unit-of-work.js';
import { createUser, deleteCreatedUsers } from '../factories/user.factory.js';
import { disconnectTestPrisma, testPrisma } from './setup/db.js';

/**
 * The task fixes `emit(tx, userId, { type, eventKey, params, targetRoute, decision? })` and
 * `resolveDecision(tx, userId, kind, ref)` (plan §4.15.3, `notifications.emit(tx, …)`). These tests
 * assume:
 * - `notification-emitter.ts` exports `createNotificationEmitter({ release })`, which returns
 *   `{ emit, resolveDecision }`. The release comes from the deps, like `createJobs` and
 *   `createExportService` (ADR-18).
 * - `tx` is the `Repositories` of the running `UnitOfWork` (plan §1.4). The emitter reaches the
 *   tables through `tx.notifications` (`createNotificationRepository(tx)`) and
 *   `tx.notificationPreferences` (`createNotificationPreferenceRepository(tx)`).
 * - `decision` is `{ kind, ref }`; the notification is created with `decision_status = 'waiting'`.
 */
const uowCache = new Map<string, UnitOfWork>();

function uowFor(userId: string): UnitOfWork {
  let uow = uowCache.get(userId);
  if (!uow) {
    uow = createUnitOfWork(testPrisma(), (tx) => ({
      notifications: createNotificationRepository(tx),
      notificationPreferences: createNotificationPreferenceRepository(tx),
      emailOutbox: createEmailOutboxRepository(tx),
    }));
    uowCache.set(userId, uow);
  }
  return uow;
}

afterAll(async () => {
  await deleteCreatedUsers();
  await disconnectTestPrisma();
});

// ---------- Helpers ----------

interface NotificationRow {
  type: string;
  eventKey: string;
  params: unknown;
  targetRoute: string;
  decisionKind: string | null;
  decisionRef: string | null;
  decisionStatus: string | null;
  readAt: Date | null;
}

const notificationsOf = (userId: string) =>
  testPrisma().$queryRaw<NotificationRow[]>`
    SELECT type::text AS type, event_key AS "eventKey", params, target_route AS "targetRoute",
           decision_kind AS "decisionKind", decision_ref::text AS "decisionRef",
           decision_status::text AS "decisionStatus", read_at AS "readAt"
      FROM notification WHERE user_id = ${userId}::uuid ORDER BY event_key`;

async function outboxCount(): Promise<number> {
  const rows = await testPrisma().$queryRaw<{ n: number }[]>`
    SELECT COUNT(*)::int AS n FROM email_outbox`;
  return rows[0]?.n ?? 0;
}

async function setPreference(userId: string, type: string, enabled: boolean): Promise<void> {
  await testPrisma().$executeRawUnsafe(
    `UPDATE notification_preference SET enabled = $1
      WHERE user_id = $2::uuid AND type = $3::notification_type`,
    enabled,
    userId,
    type,
  );
}

async function newUserId(): Promise<string> {
  const user = await createUser();
  return user.id;
}

type Emitter = ReturnType<typeof createNotificationEmitter>;
type EmitInput = Parameters<Emitter['emit']>[2];

function inTx<T>(userId: string, fn: (repos: Repositories) => Promise<T>): Promise<T> {
  return uowFor(userId).run(fn, { userLock: userId });
}

function emitOnce(release: Release, userId: string, input: EmitInput): Promise<unknown> {
  const emitter = createNotificationEmitter({ release });
  return inTx(userId, (tx) => emitter.emit(tx, userId, input));
}

const budgetAlert = (eventKey: string): EmitInput => ({
  type: 'budget_alert',
  eventKey,
  params: { budgetName: 'Comida', percent: 80 },
  targetRoute: '/presupuestos',
});

// ---------- Tests ----------

describe('NotificationEmitter.emit', () => {
  it('RN-10 emitir dos veces la misma eventKey en una transacción deja un solo aviso', async () => {
    const userId = await newUserId();
    const emitter = createNotificationEmitter({ release: '1.1' });
    const key = `budget:${uuidv7()}:2026-10:80`;

    await inTx(userId, async (tx) => {
      await emitter.emit(tx, userId, budgetAlert(key));
      await emitter.emit(tx, userId, budgetAlert(key));
    });

    const rows = await notificationsOf(userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      type: 'budget_alert',
      eventKey: key,
      params: { budgetName: 'Comida', percent: 80 },
      targetRoute: '/presupuestos',
      decisionStatus: null,
      readAt: null,
    });
  });

  it('RNF-12 emitir la misma eventKey en transacciones distintas deja un solo aviso', async () => {
    const userId = await newUserId();
    const key = `budget:${uuidv7()}:2026-10:100`;

    await emitOnce('1.1', userId, budgetAlert(key));
    await emitOnce('1.1', userId, budgetAlert(key));

    expect(await notificationsOf(userId)).toHaveLength(1);
  });

  it('RF-M15-04 dos emisiones concurrentes del mismo evento dejan un solo aviso, sin error', async () => {
    const userId = await newUserId();
    const key = `budget:${uuidv7()}:2026-10:90`;
    const emitter = createNotificationEmitter({ release: '1.1' });
    const input = budgetAlert(key);

    // Without the user lock, so both inserts really race on UNIQUE (user_id, event_key).
    const run = () => uowFor(userId).run((tx) => emitter.emit(tx, userId, input));
    await Promise.all([run(), run()]);

    expect(await notificationsOf(userId)).toHaveLength(1);
  });

  it('RF-M15-04 eventKeys distintas generan avisos distintos', async () => {
    const userId = await newUserId();
    const budget = uuidv7();

    await emitOnce('1.1', userId, budgetAlert(`budget:${budget}:2026-10:80`));
    await emitOnce('1.1', userId, budgetAlert(`budget:${budget}:2026-10:100`));

    expect(await notificationsOf(userId)).toHaveLength(2);
  });

  it('TASK-176 la misma eventKey de dos usuarios genera un aviso para cada uno', async () => {
    const userA = await newUserId();
    const userB = await newUserId();
    const key = `budget:${uuidv7()}:2026-10:80`;

    await emitOnce('1.1', userA, budgetAlert(key));
    await emitOnce('1.1', userB, budgetAlert(key));

    expect(await notificationsOf(userA)).toHaveLength(1);
    expect(await notificationsOf(userB)).toHaveLength(1);
  });

  it('RF-M15-03 con la preferencia desactivada no se crea el aviso', async () => {
    const userId = await newUserId();
    await setPreference(userId, 'budget_alert', false);

    await emitOnce('1.1', userId, budgetAlert(`budget:${uuidv7()}:2026-10:80`));

    expect(await notificationsOf(userId)).toHaveLength(0);
  });

  it('RF-M15-03 desactivar un tipo no impide los avisos de otro tipo activo', async () => {
    const userId = await newUserId();
    await setPreference(userId, 'budget_alert', false);

    await emitOnce('1.1', userId, {
      type: 'payment_upcoming',
      eventKey: `debt:${uuidv7()}:due:2026-10-20:d-3`,
      params: { debtName: 'Préstamo' },
      targetRoute: '/deudas',
    });

    const rows = await notificationsOf(userId);
    expect(rows.map((row) => row.type)).toEqual(['payment_upcoming']);
  });

  it('RF-M15-07 con RELEASE=1.1 un log_day no se crea, aunque su preferencia esté activa', async () => {
    const userId = await newUserId();
    await setPreference(userId, 'log_day', true);

    await emitOnce('1.1', userId, {
      type: 'log_day',
      eventKey: 'log_day:2026-10-21',
      params: {},
      targetRoute: '/registrar',
    });

    expect(await notificationsOf(userId)).toHaveLength(0);
  });

  it('RF-M15-07 con RELEASE=1.2 el mismo log_day sí se crea', async () => {
    const userId = await newUserId();
    await setPreference(userId, 'log_day', true);

    await emitOnce('1.2', userId, {
      type: 'log_day',
      eventKey: 'log_day:2026-10-21',
      params: {},
      targetRoute: '/registrar',
    });

    const rows = await notificationsOf(userId);
    expect(rows.map((row) => row.type)).toEqual(['log_day']);
  });

  it('RF-M15-07 con RELEASE=1.1 se crean budget_alert, period_close y payment_upcoming', async () => {
    const userId = await newUserId();
    const ref = uuidv7();

    await emitOnce('1.1', userId, budgetAlert(`budget:${ref}:2026-10:80`));
    await emitOnce('1.1', userId, {
      type: 'period_close',
      eventKey: `close:${ref}:2026-10`,
      params: {},
      targetRoute: '/presupuestos',
    });
    await emitOnce('1.1', userId, {
      type: 'payment_upcoming',
      eventKey: `debt:${ref}:due:2026-10-20:d-3`,
      params: {},
      targetRoute: '/deudas',
    });

    const types = (await notificationsOf(userId)).map((row) => row.type).sort();
    expect(types).toEqual(['budget_alert', 'payment_upcoming', 'period_close']);
  });

  it('RF-M15-01 emitir no inserta filas en email_outbox', async () => {
    const userId = await newUserId();
    const before = await outboxCount();

    await emitOnce('1.1', userId, budgetAlert(`budget:${uuidv7()}:2026-10:80`));
    await emitOnce('1.1', userId, {
      type: 'period_close',
      eventKey: `close:${uuidv7()}:2026-10`,
      params: {},
      targetRoute: '/presupuestos',
      decision: { kind: 'budget_period', ref: uuidv7() },
    });

    expect(await notificationsOf(userId)).toHaveLength(2);
    expect(await outboxCount()).toBe(before);
  });
});

describe('NotificationEmitter.resolveDecision', () => {
  it('TASK-176 un aviso con decisión se crea en espera', async () => {
    const userId = await newUserId();
    const ref = uuidv7();

    await emitOnce('1.1', userId, {
      type: 'period_close',
      eventKey: `close:${ref}:2026-10`,
      params: {},
      targetRoute: '/presupuestos',
      decision: { kind: 'budget_period', ref },
    });

    const rows = await notificationsOf(userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      decisionKind: 'budget_period',
      decisionRef: ref,
      decisionStatus: 'waiting',
    });
  });

  it('TASK-176 resolveDecision deja el aviso en resolved', async () => {
    const userId = await newUserId();
    const ref = uuidv7();
    const emitter = createNotificationEmitter({ release: '1.1' });

    await inTx(userId, (tx) =>
      emitter.emit(tx, userId, {
        type: 'period_close',
        eventKey: `close:${ref}:2026-10`,
        params: {},
        targetRoute: '/presupuestos',
        decision: { kind: 'budget_period', ref },
      }),
    );
    await inTx(userId, (tx) => emitter.resolveDecision(tx, userId, 'budget_period', ref));

    const rows = await notificationsOf(userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.decisionStatus).toBe('resolved');
  });

  it('TASK-176 resolveDecision no toca los avisos de otra decisión ni de otro usuario', async () => {
    const userId = await newUserId();
    const otherUser = await newUserId();
    const ref = uuidv7();
    const otherRef = uuidv7();
    const emitter = createNotificationEmitter({ release: '1.1' });
    const closeOf = (decisionRef: string): EmitInput => ({
      type: 'period_close',
      eventKey: `close:${decisionRef}:2026-10`,
      params: {},
      targetRoute: '/presupuestos',
      decision: { kind: 'budget_period', ref: decisionRef },
    });

    await inTx(userId, async (tx) => {
      await emitter.emit(tx, userId, closeOf(ref));
      await emitter.emit(tx, userId, closeOf(otherRef));
    });
    await inTx(otherUser, (tx) => emitter.emit(tx, otherUser, closeOf(ref)));

    await inTx(userId, (tx) => emitter.resolveDecision(tx, userId, 'budget_period', ref));

    const mine = await notificationsOf(userId);
    const byRef = new Map(mine.map((row) => [row.decisionRef, row.decisionStatus]));
    expect(byRef.get(ref)).toBe('resolved');
    expect(byRef.get(otherRef)).toBe('waiting');
    const theirs = await notificationsOf(otherUser);
    expect(theirs[0]?.decisionStatus).toBe('waiting');
  });
});
