import type { DebtDto } from '@finanzas/contracts';
import { describe, expect, it } from 'vitest';

import { closedOn, isSettled, settledDebts } from '../src/features/debts/settled';

function debt(overrides: Partial<DebtDto> & Pick<DebtDto, 'id' | 'status'>): DebtDto {
  return {
    direction: 'i_owe',
    person: 'Juan',
    principal: '100.00',
    currencyCode: 'BOB',
    startDate: '2026-10-01',
    capitalOutstanding: '0.00',
    interestAccrued: '0.00',
    pending: '0.00',
    payments: [],
    canDeleteLastPayment: false,
    ...overrides,
  };
}

const payment = (date: string) => ({
  id: date,
  amount: '10.00',
  interestPart: '0.00',
  capitalPart: '10.00',
  date,
});

describe('settled debts', () => {
  it('only paid and forgiven debts are settled', () => {
    expect(isSettled(debt({ id: 'a', status: 'paid' }))).toBe(true);
    expect(isSettled(debt({ id: 'b', status: 'forgiven' }))).toBe(true);
    expect(isSettled(debt({ id: 'c', status: 'active' }))).toBe(false);
    expect(isSettled(debt({ id: 'd', status: 'overdue' }))).toBe(false);
  });

  it('a debt closed on its last payment day, else on its start day', () => {
    const paid = debt({
      id: 'a',
      status: 'paid',
      payments: [payment('2026-10-20'), payment('2026-11-05'), payment('2026-10-25')] as never,
    });
    expect(closedOn(paid)).toBe('2026-11-05');
    expect(closedOn(debt({ id: 'b', status: 'forgiven', startDate: '2026-10-09' }))).toBe(
      '2026-10-09',
    );
  });

  it('lists the settled ones only, the most recently closed first, ties by person', () => {
    const list = settledDebts([
      debt({ id: 'open', status: 'active' }),
      debt({ id: 'old', status: 'forgiven', startDate: '2026-09-01' }),
      debt({ id: 'new', status: 'paid', payments: [payment('2026-11-10')] as never }),
      debt({ id: 'tie-b', status: 'paid', person: 'Beto', startDate: '2026-10-15' }),
      debt({ id: 'tie-a', status: 'paid', person: 'Ana', startDate: '2026-10-15' }),
    ]);
    expect(list.map((item) => item.id)).toEqual(['new', 'tie-a', 'tie-b', 'old']);
  });

  it('does not change the list it receives', () => {
    const input = [
      debt({ id: 'x', status: 'paid', startDate: '2026-10-01' }),
      debt({ id: 'y', status: 'paid', startDate: '2026-11-01' }),
    ];
    settledDebts(input);
    expect(input.map((item) => item.id)).toEqual(['x', 'y']);
  });
});
