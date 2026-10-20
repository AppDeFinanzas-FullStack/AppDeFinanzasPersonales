import { describe, expect, it } from 'vitest';

import {
  BatchDeleteInput,
  BatchRecategorizeInput,
  CreateTransactionInput,
  ListQuery,
  UndoInput,
  UpdateTransactionInput,
} from '../src/index.js';

const ok = (schema: { safeParse: (v: unknown) => { success: boolean } }, v: unknown) =>
  schema.safeParse(v).success;

const id = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
const id2 = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c';
const id3 = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5d';

const expense = {
  kind: 'expense',
  id,
  accountId: id2,
  categoryId: id3,
  amount: '10.50',
  date: '2026-10-01',
};

const transfer = {
  kind: 'transfer',
  id,
  fromAccountId: id2,
  toAccountId: id3,
  amountOut: '100.00',
  date: '2026-10-01',
};

describe('CreateTransactionInput', () => {
  it('TASK-118 acepta un gasto y un ingreso validos', () => {
    expect(ok(CreateTransactionInput, expense)).toBe(true);
    expect(ok(CreateTransactionInput, { ...expense, kind: 'income' })).toBe(true);
  });

  it('TASK-118 acepta un gasto con earmarkWithdrawals y manualUsdRate opcionales', () => {
    expect(
      ok(CreateTransactionInput, {
        ...expense,
        manualUsdRate: '6.96',
        earmarkWithdrawals: [{ goalId: id, accountId: id2, amount: '5.00' }],
      }),
    ).toBe(true);
  });

  it('TASK-118 rechaza un kind desconocido o ausente', () => {
    expect(ok(CreateTransactionInput, { ...expense, kind: 'adjustment' })).toBe(false);
    expect(ok(CreateTransactionInput, { ...expense, kind: undefined })).toBe(false);
  });

  it('TASK-118 rechaza un id que no es UUID', () => {
    expect(ok(CreateTransactionInput, { ...expense, id: 'abc' })).toBe(false);
  });

  it('RF-M6-01 acepta los limites de monto 0.01 y 999999999.99', () => {
    expect(ok(CreateTransactionInput, { ...expense, amount: '0.01' })).toBe(true);
    expect(ok(CreateTransactionInput, { ...expense, amount: '999999999.99' })).toBe(true);
  });

  it('RF-M6-01 rechaza montos fuera de rango, cero, negativos o con mas de 2 decimales', () => {
    expect(ok(CreateTransactionInput, { ...expense, amount: '0.00' })).toBe(false);
    expect(ok(CreateTransactionInput, { ...expense, amount: '0.009' })).toBe(false);
    expect(ok(CreateTransactionInput, { ...expense, amount: '-5.00' })).toBe(false);
    expect(ok(CreateTransactionInput, { ...expense, amount: '1000000000.00' })).toBe(false);
    expect(ok(CreateTransactionInput, { ...expense, amount: '10.123' })).toBe(false);
  });

  it('RF-M6-01 aplica los limites a amountOut, amountIn y la comision de una transferencia', () => {
    expect(ok(CreateTransactionInput, { ...transfer, amountOut: '0.00' })).toBe(false);
    expect(ok(CreateTransactionInput, { ...transfer, amountIn: '1000000000.00' })).toBe(false);
    expect(ok(CreateTransactionInput, { ...transfer, amountIn: '50.00' })).toBe(true);
    expect(ok(CreateTransactionInput, { ...transfer, fee: { id: id2, amount: '0.00' } })).toBe(
      false,
    );
    expect(ok(CreateTransactionInput, { ...transfer, fee: { id: id2, amount: '1.00' } })).toBe(
      true,
    );
  });

  it('RF-M6-01 aplica los limites a los montos de earmarkWithdrawals', () => {
    expect(
      ok(CreateTransactionInput, {
        ...expense,
        earmarkWithdrawals: [{ goalId: id, accountId: id2, amount: '0.00' }],
      }),
    ).toBe(false);
  });

  it('RF-M6-03 la nota es opcional', () => {
    expect(ok(CreateTransactionInput, expense)).toBe(true);
    expect(ok(CreateTransactionInput, { ...transfer, note: 'hola' })).toBe(true);
  });

  it('RF-M6-03 acepta una nota de 140 caracteres y rechaza una de 141', () => {
    expect(ok(CreateTransactionInput, { ...expense, note: 'a'.repeat(140) })).toBe(true);
    expect(ok(CreateTransactionInput, { ...expense, note: 'a'.repeat(141) })).toBe(false);
    expect(ok(CreateTransactionInput, { ...transfer, note: 'a'.repeat(141) })).toBe(false);
  });

  it('RF-M6-04 una transferencia con el mismo origen y destino es invalida', () => {
    expect(ok(CreateTransactionInput, { ...transfer, toAccountId: id2 })).toBe(false);
  });

  it('RF-M6-04 una transferencia con origen y destino distintos es valida', () => {
    expect(ok(CreateTransactionInput, transfer)).toBe(true);
  });
});

describe('UpdateTransactionInput', () => {
  it('RF-M6-06 rechaza kind', () => {
    expect(ok(UpdateTransactionInput, { kind: 'income' })).toBe(false);
    expect(ok(UpdateTransactionInput, { amount: '5.00', kind: 'expense' })).toBe(false);
  });

  it('RF-M6-06 acepta un objeto vacio y campos parciales', () => {
    expect(ok(UpdateTransactionInput, {})).toBe(true);
    expect(ok(UpdateTransactionInput, { amount: '5.00', date: '2026-10-02' })).toBe(true);
  });

  it('RF-M6-03 la nota admite null y hasta 140 caracteres', () => {
    expect(ok(UpdateTransactionInput, { note: null })).toBe(true);
    expect(ok(UpdateTransactionInput, { note: 'a'.repeat(140) })).toBe(true);
    expect(ok(UpdateTransactionInput, { note: 'a'.repeat(141) })).toBe(false);
  });

  it('RF-M6-01 aplica los limites de monto', () => {
    expect(ok(UpdateTransactionInput, { amount: '0.01' })).toBe(true);
    expect(ok(UpdateTransactionInput, { amount: '0.00' })).toBe(false);
    expect(ok(UpdateTransactionInput, { amount: '1000000000.00' })).toBe(false);
    expect(ok(UpdateTransactionInput, { amountInNewCurrency: '0.00' })).toBe(false);
  });

  it('TASK-118 rechaza campos desconocidos (strict)', () => {
    expect(ok(UpdateTransactionInput, { foo: 1 })).toBe(false);
  });
});

describe('ListQuery', () => {
  it('TASK-118 limit por defecto es 50', () => {
    const r = ListQuery.parse({}) as { limit: number };
    expect(r.limit).toBe(50);
  });

  it('TASK-118 limit va de 1 a 100', () => {
    expect(ok(ListQuery, { limit: 1 })).toBe(true);
    expect(ok(ListQuery, { limit: 100 })).toBe(true);
    expect(ok(ListQuery, { limit: 0 })).toBe(false);
    expect(ok(ListQuery, { limit: 101 })).toBe(false);
    expect(ok(ListQuery, { limit: 1.5 })).toBe(false);
  });

  it('TASK-118 valida month, kind y q', () => {
    expect(ok(ListQuery, { month: '2026-10' })).toBe(true);
    expect(ok(ListQuery, { month: '2026-10-01' })).toBe(false);
    expect(ok(ListQuery, { kind: 'adjustment' })).toBe(true);
    expect(ok(ListQuery, { kind: 'otro' })).toBe(false);
    expect(ok(ListQuery, { q: 'a'.repeat(60) })).toBe(true);
    expect(ok(ListQuery, { q: 'a'.repeat(61) })).toBe(false);
  });
});

describe('BatchDeleteInput y BatchRecategorizeInput', () => {
  it('TASK-118 ids entre 1 y 200 UUID', () => {
    expect(ok(BatchDeleteInput, { ids: [id] })).toBe(true);
    expect(ok(BatchDeleteInput, { ids: [] })).toBe(false);
    expect(ok(BatchDeleteInput, { ids: Array.from({ length: 200 }, () => id) })).toBe(true);
    expect(ok(BatchDeleteInput, { ids: Array.from({ length: 201 }, () => id) })).toBe(false);
    expect(ok(BatchDeleteInput, { ids: ['x'] })).toBe(false);
  });

  it('TASK-118 recategorizar exige categoryId', () => {
    expect(ok(BatchRecategorizeInput, { ids: [id], categoryId: id2 })).toBe(true);
    expect(ok(BatchRecategorizeInput, { ids: [id] })).toBe(false);
  });
});

describe('UndoInput', () => {
  it('TASK-118 exige un undoToken UUID', () => {
    expect(ok(UndoInput, { undoToken: id })).toBe(true);
    expect(ok(UndoInput, { undoToken: 'x' })).toBe(false);
    expect(ok(UndoInput, {})).toBe(false);
  });
});
