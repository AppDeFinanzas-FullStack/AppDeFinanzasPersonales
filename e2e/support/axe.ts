import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';

/** Impacts that fail a page (RNF-06, plan §5.1): minor and moderate findings are not blocking. */
export const BLOCKING_IMPACTS: readonly string[] = ['serious', 'critical'];

/** WCAG 2.2 AA rule tags checked by axe (RNF-06). */
export const WCAG_TAGS: readonly string[] = [
  'wcag2a',
  'wcag2aa',
  'wcag21a',
  'wcag21aa',
  'wcag22aa',
];

export interface BlockingViolation {
  id: string;
  impact: string;
  help: string;
  targets: string[];
}

/** Runs axe on the current page and returns only the serious or critical violations. */
export async function findBlockingViolations(page: Page): Promise<BlockingViolation[]> {
  const results = await new AxeBuilder({ page }).withTags([...WCAG_TAGS]).analyze();
  return results.violations
    .filter((violation) => BLOCKING_IMPACTS.includes(violation.impact ?? ''))
    .map((violation) => ({
      id: violation.id,
      impact: violation.impact ?? '',
      help: violation.help,
      targets: violation.nodes.map((node) => node.target.join(' ')),
    }));
}

/** Fails the test when axe finds any serious or critical violation on the current page. */
export async function expectNoBlockingViolations(page: Page): Promise<void> {
  const violations = await findBlockingViolations(page);
  expect(violations, 'serious or critical axe violations').toEqual([]);
}
