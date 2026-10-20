import { AppError } from '../errors.js';

export const LIMITS = {
  accounts: 50,
  categories: 300,
  goals: 50,
  debts: 200,
  budgets: 100,
  recurringRules: 100,
  shortcuts: 12,
} as const;

export type LimitedEntity = keyof typeof LIMITS;

export function assertLimit(currentCount: number, entity: LimitedEntity): void {
  const max = LIMITS[entity];
  if (currentCount >= max) {
    throw new AppError('LIMIT_REACHED', { entity, max });
  }
}
