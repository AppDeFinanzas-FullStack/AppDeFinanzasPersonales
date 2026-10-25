import type { RecurringOverviewDto, RuleDto } from '@finanzas/contracts';

import type { LocalDate } from '../../application/ports/clock.js';

/** Builds the answers of `/api/recurring` (plan §4.14.2). Money travels as text (ADR-03). */
export const RecurringPresenter = {
  overview(overview: RecurringOverviewDto): RecurringOverviewDto {
    return overview;
  },

  rule(rule: RuleDto): RuleDto {
    return rule;
  },

  skipped(dates: LocalDate[]): { dates: LocalDate[] } {
    return { dates };
  },

  confirmed(result: { transactionId: string }): { transactionId: string } {
    return { transactionId: result.transactionId };
  },
};
