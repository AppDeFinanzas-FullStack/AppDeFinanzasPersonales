import type { DebtDto } from '@finanzas/contracts';

/** A debt is closed when it was paid in full or forgiven (RF-M13-12); the rest is still open. */
export const isSettled = (debt: DebtDto): boolean =>
  debt.status === 'paid' || debt.status === 'forgiven';

/** Day a closed debt was last touched: its last payment, else the day it started. */
export const closedOn = (debt: DebtDto): string =>
  debt.payments.reduce(
    (latest, payment) => (payment.date > latest ? payment.date : latest),
    debt.startDate,
  );

/** The closed debts, the most recently closed first; ties go by person. */
export const settledDebts = (debts: readonly DebtDto[]): DebtDto[] =>
  debts
    .filter(isSettled)
    .sort((a, b) => closedOn(b).localeCompare(closedOn(a)) || a.person.localeCompare(b.person));
