import {
  buildPrismaClient,
  type PrismaClient,
} from '../../../src/infrastructure/persistence/prisma-client.js';

/** Connections of the test client's pool: concurrency tests hold several transactions at once. */
const CONNECTION_LIMIT = '10';

/** URL of the test database, migrated by the global setup (TEST_DATABASE_URL). */
export function testDatabaseUrl(): string {
  const url = process.env['TEST_DATABASE_URL'];
  if (!url) {
    throw new Error('TEST_DATABASE_URL is not set');
  }
  return url;
}

function withConnectionLimit(url: string): string {
  const parsed = new URL(url);
  if (!parsed.searchParams.has('connection_limit')) {
    parsed.searchParams.set('connection_limit', CONNECTION_LIMIT);
  }
  return parsed.toString();
}

let client: PrismaClient | undefined;

/**
 * Prisma client over the test database, built like the API's (`buildPrismaClient`) and shared by
 * the whole test file. Each transaction takes its own connection from the pool.
 */
export function testPrisma(): PrismaClient {
  client ??= buildPrismaClient({ DATABASE_URL: withConnectionLimit(testDatabaseUrl()) });
  return client;
}

/** Closes the test client. Each integration test file calls it in `afterAll`. */
export async function disconnectTestPrisma(): Promise<void> {
  if (client) {
    await client.$disconnect();
    client = undefined;
  }
}
