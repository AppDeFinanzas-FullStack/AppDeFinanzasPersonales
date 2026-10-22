import { uuidv7 } from 'uuidv7';
import { afterAll, describe, expect, it } from 'vitest';

import { createMaintenance } from '../../src/application/jobs/maintenance.js';
import type { Clock } from '../../src/application/ports/clock.js';
import { createMaintenanceStore } from '../../src/infrastructure/persistence/maintenance-store.js';
import { createUser, deleteCreatedUsers } from '../factories/user.factory.js';
import { disconnectTestPrisma, testPrisma } from './setup/db.js';

/**
 * The `maintenance` job (`createMaintenance({ store, clock })` with `createMaintenanceStore(prisma)`,
 * as in `maintenance-auth.test.ts`) also applies the notifications retention (plan §4.15.3, §3.9):
 * it deletes the notifications created more than 90 days before `clock.now()` whose
 * `decision_status` is NULL or 'resolved'. Rows are placed in the past relative to the real time,
 * which is also the job's clock.
 */
const DAY = 24 * 60 * 60_000;

const clock: Clock = {
  now: () => new Date(),
  todayFor: () => new Date().toISOString().slice(0, 10),
};

const runMaintenance = createMaintenance({
  store: createMaintenanceStore(testPrisma()),
  clock,
});

const db = () => testPrisma();
const ago = (ms: number) => new Date(Date.now() - ms);

afterAll(async () => {
  await deleteCreatedUsers();
  await disconnectTestPrisma();
});

type Decision = 'none' | 'waiting' | 'resolved';

async function insertNotification(
  userId: string,
  options: { createdAgo: number; decision: Decision },
): Promise<string> {
  const id = uuidv7();
  const eventKey = `budget:${id}:2026-07:80`;
  const createdAt = ago(options.createdAgo);
  if (options.decision === 'none') {
    await db().$executeRaw`
      INSERT INTO notification (id, user_id, type, event_key, params, target_route, created_at)
      VALUES (${id}::uuid, ${userId}::uuid, 'budget_alert'::notification_type, ${eventKey},
              '{}'::jsonb, '/presupuestos', ${createdAt})`;
  } else {
    await db().$executeRaw`
      INSERT INTO notification (id, user_id, type, event_key, params, target_route,
                                decision_kind, decision_ref, decision_status, created_at)
      VALUES (${id}::uuid, ${userId}::uuid, 'period_close'::notification_type, ${eventKey},
              '{}'::jsonb, '/presupuestos', 'budget_period', ${uuidv7()}::uuid,
              ${options.decision}::decision_status, ${createdAt})`;
  }
  return id;
}

async function notificationExists(id: string): Promise<boolean> {
  const rows = await db().$queryRaw<{ n: number }[]>`
    SELECT count(*)::int AS n FROM notification WHERE id = ${id}::uuid`;
  return rows[0]?.n === 1;
}

async function newUserId(): Promise<string> {
  const user = await createUser();
  return user.id;
}

describe('maintenance: retención de avisos', () => {
  it('RF-M15-05 un aviso de 91 días sin decisión se borra', async () => {
    const userId = await newUserId();
    const old = await insertNotification(userId, { createdAgo: 91 * DAY, decision: 'none' });
    await runMaintenance();
    expect(await notificationExists(old)).toBe(false);
  });

  it('RF-M15-05 un aviso de 91 días con la decisión resuelta se borra', async () => {
    const userId = await newUserId();
    const old = await insertNotification(userId, { createdAgo: 91 * DAY, decision: 'resolved' });
    await runMaintenance();
    expect(await notificationExists(old)).toBe(false);
  });

  it('RF-M15-05 un aviso de 91 días que espera una decisión se conserva', async () => {
    const userId = await newUserId();
    const waiting = await insertNotification(userId, { createdAgo: 91 * DAY, decision: 'waiting' });
    await runMaintenance();
    expect(await notificationExists(waiting)).toBe(true);
  });

  it('RF-M15-05 un aviso de 89 días se conserva', async () => {
    const userId = await newUserId();
    const recent = await insertNotification(userId, { createdAgo: 89 * DAY, decision: 'none' });
    const recentResolved = await insertNotification(userId, {
      createdAgo: 89 * DAY,
      decision: 'resolved',
    });
    await runMaintenance();
    expect(await notificationExists(recent)).toBe(true);
    expect(await notificationExists(recentResolved)).toBe(true);
  });

  it('RNF-26 la retención de avisos a 90 días borra los viejos y respeta los demás en una sola corrida', async () => {
    const userId = await newUserId();
    const old = await insertNotification(userId, { createdAgo: 91 * DAY, decision: 'none' });
    const waiting = await insertNotification(userId, {
      createdAgo: 120 * DAY,
      decision: 'waiting',
    });
    const recent = await insertNotification(userId, { createdAgo: 89 * DAY, decision: 'none' });
    await runMaintenance();
    expect(await notificationExists(old)).toBe(false);
    expect(await notificationExists(waiting)).toBe(true);
    expect(await notificationExists(recent)).toBe(true);
    await expect(runMaintenance()).resolves.toBeUndefined();
  });
});
