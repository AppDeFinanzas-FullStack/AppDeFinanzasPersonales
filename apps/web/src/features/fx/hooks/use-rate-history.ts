import { RateHistoryQuery, type UsdReference } from '@finanzas/contracts';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { z } from 'zod';

import { call, type Endpoint } from '@/lib/api-client';

export type RateHistoryRange = RateHistoryQuery['range'];

/** One point per day, the value as decimal text (ADR-03). */
const RateHistoryOutput = z.object({
  points: z.array(z.object({ date: z.string(), value: z.string() })),
});
export type RateHistory = z.infer<typeof RateHistoryOutput>;

const getRateHistoryEndpoint: Endpoint<RateHistoryQuery, RateHistory> = {
  method: 'GET',
  path: '/api/rates/history',
  input: RateHistoryQuery,
  output: RateHistoryOutput,
};

// Plan §4.3.4: the history of one reference over one range.
export function useRateHistory(kind: UsdReference, range: RateHistoryRange) {
  return useQuery({
    queryKey: ['rates', 'history', kind, range],
    queryFn: ({ signal }) => call(getRateHistoryEndpoint, { kind, range }, { signal }),
    placeholderData: keepPreviousData,
  });
}
