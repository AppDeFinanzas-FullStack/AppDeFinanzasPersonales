import { Decimal } from 'decimal.js';
import { z } from 'zod';

import { CurrencyCode, Money } from './common.js';

const RATE_FORMAT = /^\d{1,12}(\.\d{1,2})?$/;
const MIN_RATE = '0.01';

// Zod 4 keeps running refinements after a failed regex, and Decimal throws on garbage,
// so the minimum is only checked when the format is valid.
const Rate = z
  .string()
  .regex(RATE_FORMAT)
  .refine((v) => RATE_FORMAT.test(v) && new Decimal(v).gte(MIN_RATE));

export const UsdReference = z.enum(['parallel_bid', 'parallel_ask', 'parallel_median', 'official']);
export type UsdReference = z.infer<typeof UsdReference>;

const UsdReferenceOrManual = z.union([UsdReference, z.literal('manual')]);

const RateReference = z.object({
  value: Rate,
  observedAt: z.string(),
  source: z.enum(['paralelo_bo', 'bcb', 'seed']),
});

export const RatesCurrentDto = z.object({
  references: z.object({
    parallel_bid: RateReference.nullable(),
    parallel_ask: RateReference.nullable(),
    parallel_median: RateReference.nullable(),
    official: RateReference.nullable(),
  }),
  inUse: z.object({
    kind: UsdReferenceOrManual,
    value: Rate.nullable(),
    since: z.string().optional(),
  }),
  gap: z
    .object({
      pct: z.string(),
      bs: Money,
      comparedKind: UsdReferenceOrManual,
    })
    .nullable(),
  base: CurrencyCode,
  other: CurrencyCode,
});
export type RatesCurrentDto = z.infer<typeof RatesCurrentDto>;

export const RateHistoryQuery = z.object({
  kind: UsdReference,
  range: z.enum(['7d', '30d', '90d', '1y']),
});
export type RateHistoryQuery = z.infer<typeof RateHistoryQuery>;

export const FxSettingsInput = z.object({
  usdReference: UsdReference.optional(),
  baseCurrency: CurrencyCode.optional(),
});
export type FxSettingsInput = z.infer<typeof FxSettingsInput>;

export const ManualUsdInput = z.object({ value: Rate });
export type ManualUsdInput = z.infer<typeof ManualUsdInput>;

const CurrencySymbol = z.string().trim().min(1).max(5);

export const CreateCurrencyInput = z.object({
  code: CurrencyCode,
  symbol: CurrencySymbol,
  rate: Rate,
});
export type CreateCurrencyInput = z.infer<typeof CreateCurrencyInput>;

export const UpdateCurrencyInput = z.object({
  symbol: CurrencySymbol.optional(),
  rate: Rate.optional(),
});
export type UpdateCurrencyInput = z.infer<typeof UpdateCurrencyInput>;

export const CurrencyDto = z.object({
  code: CurrencyCode,
  symbol: z.string(),
  rate: Rate,
});
export type CurrencyDto = z.infer<typeof CurrencyDto>;

export const CurrencyStatus = z.enum(['active', 'inactive']);
export type CurrencyStatus = z.infer<typeof CurrencyStatus>;

/** An item of `GET /api/currencies`: the currency with its status, so Ajustes can offer the active ones. */
export const CurrencyListItemDto = CurrencyDto.extend({ status: CurrencyStatus });
export type CurrencyListItemDto = z.infer<typeof CurrencyListItemDto>;
