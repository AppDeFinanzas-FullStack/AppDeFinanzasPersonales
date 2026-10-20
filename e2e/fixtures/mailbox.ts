import { expect, test as base } from './base.js';
import type { BaseFixtures } from './base.js';

const API_URL = `http://localhost:${process.env['API_PORT'] ?? '3000'}`;

interface SentEmail {
  kind: string;
  to: string;
  payload: { link?: string };
}

export interface MailboxFixtures {
  mailbox: {
    /** Unique, never-used email address for the current test. */
    newEmail: () => string;
    /** Emails the fake gateway holds for the recipient (`/internal/test/mailbox`). */
    inboxOf: (to: string) => Promise<SentEmail[]>;
    /** Waits for the `count`-th `confirm` email and returns its link. */
    confirmationLink: (to: string, count?: number) => Promise<string>;
  };
}

/** Extends the base `test` with access to the fake mailbox of the API (plan §1.5). */
export const test = base.extend<MailboxFixtures & BaseFixtures>({
  mailbox: async ({ request }, use, testInfo) => {
    const inboxOf = async (to: string): Promise<SentEmail[]> => {
      const res = await request.get(`${API_URL}/internal/test/mailbox`, { params: { to } });
      expect(res.status()).toBe(200);
      return (await res.json()) as SentEmail[];
    };
    const confirmationLink = async (to: string, count = 1): Promise<string> => {
      const confirms = async () => (await inboxOf(to)).filter((e) => e.kind === 'confirm');
      await expect
        .poll(async () => (await confirms()).length, { timeout: 15_000 })
        .toBeGreaterThanOrEqual(count);
      const link = (await confirms())[count - 1]?.payload.link;
      if (link === undefined) {
        throw new Error(`No confirmation link for ${to}`);
      }
      return link;
    };
    let seq = 0;
    const newEmail = () => {
      seq += 1;
      const tag = `${testInfo.project.name}-${testInfo.workerIndex}-${Date.now()}-${seq}`;
      return `e2e-${tag}@example.com`;
    };
    await use({ newEmail, inboxOf, confirmationLink });
  },
});

export { expect };
