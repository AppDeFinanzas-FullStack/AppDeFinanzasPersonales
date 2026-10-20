import { uuidv7 } from 'uuidv7';

import type { UnitOfWork } from '../../src/application/ports/unit-of-work.js';
import { bootstrapUser } from '../../src/application/shared/user-bootstrap.js';
import { createUserRepository } from '../../src/infrastructure/persistence/repositories/user.repository.js';
import { createUnitOfWork } from '../../src/infrastructure/persistence/unit-of-work.js';
import { testPrisma } from '../integration/setup/db.js';

export interface TestUser {
  id: string;
  email: string;
  name: string;
  timezone: string;
}

export interface CreateUserOptions {
  name?: string;
  timezone?: string;
}

const createdUserIds: string[] = [];

/**
 * Creates a confirmed user and gives it the initial rows of a new user through `user-bootstrap`
 * (`bootstrapUser(repos, userId)` over `repos.users`), in one transaction: the system currencies,
 * `user_settings`, the preset and system categories and the default notification preferences.
 * Each test uses a new user (plan §5.1).
 */
export async function createUser(options: CreateUserOptions = {}): Promise<TestUser> {
  const id = uuidv7();
  const user: TestUser = {
    id,
    email: `${id}@test.local`,
    name: options.name ?? 'Usuario de prueba',
    timezone: options.timezone ?? 'America/La_Paz',
  };
  const db = testPrisma();

  await db.$executeRaw`
    INSERT INTO auth_user (id, name, email, email_verified, timezone, terms_accepted_at, registered_at)
    VALUES (${user.id}::uuid, ${user.name}, ${user.email}, true, ${user.timezone}, now(), now())`;
  createdUserIds.push(user.id);

  const uow: UnitOfWork = createUnitOfWork(db, (tx) => ({ users: createUserRepository(tx) }));
  await uow.run((repos) => bootstrapUser(repos, user.id), { userLock: user.id });

  return user;
}

/** Deletes every user created by this file; their rows go with them by cascade (plan §3.8). */
export async function deleteCreatedUsers(): Promise<void> {
  const ids = createdUserIds.splice(0);
  if (ids.length > 0) {
    await testPrisma().$executeRaw`DELETE FROM auth_user WHERE id = ANY(${ids}::uuid[])`;
  }
}
