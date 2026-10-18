import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** Applies every migration to the test database before the suite runs. */
export default function setup(): void {
  const url = process.env['TEST_DATABASE_URL'];
  if (!url) {
    throw new Error('TEST_DATABASE_URL is not set');
  }
  const cwd = fileURLToPath(new URL('..', import.meta.url));
  const result = spawnSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
    cwd,
    env: { ...process.env, DATABASE_URL: url, DATABASE_URL_DIRECT: url },
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (result.status !== 0) {
    throw new Error('Could not apply migrations to the test database');
  }
}
