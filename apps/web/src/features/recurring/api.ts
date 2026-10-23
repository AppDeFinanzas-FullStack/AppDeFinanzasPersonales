import type { ConfirmOccurrenceInput, RecurringOverviewDto } from '@finanzas/contracts';
import { z } from 'zod';

import type { Endpoint } from '@/lib/api-client';

const isObject = (value: unknown): boolean => typeof value === 'object' && value !== null;

/** The rules, the pendings and the next 30 days of `/recurrentes` (RF-M14-13). */
export const overviewEndpoint: Endpoint<undefined, RecurringOverviewDto> = {
  method: 'GET',
  path: '/api/recurring',
  input: z.undefined(),
  output: z.custom<RecurringOverviewDto>(isObject),
};

/** Registers a pending occurrence as a movement (RF-M14-08). */
export const confirmOccurrenceEndpoint = (
  occurrenceId: string,
): Endpoint<ConfirmOccurrenceInput, { transactionId: string }> => ({
  method: 'POST',
  path: `/api/recurring/occurrences/${encodeURIComponent(occurrenceId)}/confirm`,
  input: z.custom<ConfirmOccurrenceInput>(isObject),
  output: z.object({ transactionId: z.string() }),
});

/** "Omitir": decides a pending occurrence without registering it. */
export const skipOccurrenceEndpoint = (occurrenceId: string): Endpoint<undefined, void> => ({
  method: 'POST',
  path: `/api/recurring/occurrences/${encodeURIComponent(occurrenceId)}/skip`,
  input: z.undefined(),
  output: z.void(),
});
