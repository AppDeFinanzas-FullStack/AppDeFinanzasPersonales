// `@finanzas/db` declares no `exports` map, so its entry point is imported by path.
import { createPrismaClient, type PrismaClient } from '@finanzas/db/src/index.js';

import type { Env } from '../config/env.js';

export { forUser, type PrismaClient, type ScopedPrismaClient } from '@finanzas/db/src/index.js';

/**
 * The API's single Prisma client, built from the validated env. The composition root creates it
 * once and every user-scoped access wraps it with `forUser` (ADR-05).
 */
export const buildPrismaClient = (env: Pick<Env, 'DATABASE_URL'>): PrismaClient =>
  createPrismaClient(env.DATABASE_URL);
