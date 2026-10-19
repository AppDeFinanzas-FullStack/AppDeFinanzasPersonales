import { randomUUID } from 'node:crypto';
import pg from 'pg';

let pool: pg.Pool | undefined;

/** Raw SQL client over TEST_DATABASE_URL, shared by the whole test file. */
export function sql(): pg.Pool {
  if (!pool) {
    const url = process.env['TEST_DATABASE_URL'];
    if (!url) {
      throw new Error('TEST_DATABASE_URL is not set');
    }
    pool = new pg.Pool({ connectionString: url });
  }
  return pool;
}

export async function closeSql(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}

/** Inserts a minimal user (unique id and email per call) and returns its id. */
export async function createUser(): Promise<string> {
  const id = randomUUID();
  await sql().query('INSERT INTO "user" (id, email) VALUES ($1, $2)', [id, `${id}@test.local`]);
  return id;
}
