import { test as base, expect } from '@playwright/test';

import { expectNoBlockingViolations } from '../support/axe.js';

export interface BaseFixtures {
  /** Fails the test when the current page has serious or critical axe violations (RNF-06). */
  checkA11y: () => Promise<void>;
  /** Viewport width the project runs with, read from its name (`chromium-360` → 360) (RNF-05). */
  projectWidth: number;
}

/** Base `test` for every E2E spec: later fixtures (mailbox, auth...) extend this one. */
export const test = base.extend<BaseFixtures>({
  checkA11y: async ({ page }, use) => {
    await use(() => expectNoBlockingViolations(page));
  },
  // Playwright requires the first fixture argument to be an object pattern.
  // eslint-disable-next-line no-empty-pattern
  projectWidth: async ({}, use, testInfo) => {
    const match = /-(\d+)$/.exec(testInfo.project.name);
    await use(match?.[1] === undefined ? Number.NaN : Number(match[1]));
  },
});

export { expect };
