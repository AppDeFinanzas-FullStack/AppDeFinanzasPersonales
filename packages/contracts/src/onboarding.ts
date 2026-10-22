import { Decimal } from 'decimal.js';
import { z } from 'zod';

import { AccountType, CreateAccountInput } from './accounts.js';
import { CategoryNode, CreateCategoryInput } from './categories.js';
import { CurrencyCode, Money, Uuid } from './common.js';
import { RatesCurrentDto } from './fx.js';

const MAX_ABS_BALANCE = '999999999.99';
/** Most accounts created in step 2 at once. */
const MAX_STEP2_ACCOUNTS = 20;

/** The name rules of an account (RF-M4-01). */
const AccountName = CreateAccountInput.shape.name;

// Zod 4 keeps running refinements after a failed regex, and Decimal throws on garbage,
// so the bound is only checked when the format is valid.
const AmountAbs = Money.refine((v) => {
  try {
    return new Decimal(v).abs().lte(MAX_ABS_BALANCE);
  } catch {
    return false;
  }
});

export const OnboardingStep = z.union([z.literal(1), z.literal(2), z.literal(3)]);
export type OnboardingStep = z.infer<typeof OnboardingStep>;

/** A suggested account of step 2, checked or not by default. */
export const AccountPreset = z.object({
  name: z.string(),
  type: AccountType,
  currencyCode: CurrencyCode,
  checked: z.boolean(),
});
export type AccountPreset = z.infer<typeof AccountPreset>;

export const OnboardingDto = z.object({
  step: OnboardingStep,
  completed: z.boolean(),
  presets: z.object({
    accounts: z.array(AccountPreset),
    categories: z.array(CategoryNode),
  }),
  rate: RatesCurrentDto.shape.inUse.nullable(),
});
export type OnboardingDto = z.infer<typeof OnboardingDto>;

export const Step1Input = z.object({ baseCurrency: z.enum(['BOB', 'USD']) });
export type Step1Input = z.infer<typeof Step1Input>;

/** The balance date is always today, set by the server (RF-M10-04). */
export const Step2Input = z.object({
  accounts: z
    .array(
      z.object({
        id: Uuid,
        name: AccountName,
        type: AccountType,
        currencyCode: CurrencyCode,
        balance: AmountAbs,
      }),
    )
    .max(MAX_STEP2_ACCOUNTS),
});
export type Step2Input = z.infer<typeof Step2Input>;

export const Step3Input = z.object({
  removeCategoryIds: z.array(Uuid),
  newCategories: z.array(CreateCategoryInput),
});
export type Step3Input = z.infer<typeof Step3Input>;

export const SkipInput = z.object({ step: OnboardingStep });
export type SkipInput = z.infer<typeof SkipInput>;
