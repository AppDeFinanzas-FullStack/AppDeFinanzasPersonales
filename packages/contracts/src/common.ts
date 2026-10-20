import { Decimal } from 'decimal.js';
import { z } from 'zod';

const MAX_AMOUNT = '999999999.99';
const MIN_AMOUNT = '0.01';

export const Money = z.string().regex(/^-?\d{1,12}(\.\d{1,2})?$/);

export const Rate = z
  .string()
  .regex(/^\d{1,12}(\.\d{1,2})?$/)
  .refine((v) => new Decimal(v).gte(MIN_AMOUNT));

export const AmountAbs = Money.refine((v) => new Decimal(v).abs().lte(MAX_AMOUNT));

export const Amount = Money.refine((v) => {
  const d = new Decimal(v);
  return d.gte(MIN_AMOUNT) && d.lte(MAX_AMOUNT);
});

export const Note = z.string().trim().max(140);

export const LocalDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const CurrencyCode = z.string().regex(/^[A-Z]{3}$/);

export const Uuid = z.uuid();

export const Cursor = z.string();

export const TrimmedName = (min: number, max: number) => z.string().trim().min(min).max(max);
