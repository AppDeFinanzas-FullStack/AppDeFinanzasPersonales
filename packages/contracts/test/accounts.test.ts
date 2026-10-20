import { describe, expect, it } from 'vitest';

import {
  AccountType,
  AdjustInput,
  ArchiveInput,
  CreateAccountInput,
  ReorderInput,
  RestoreInput,
  UpdateAccountInput,
} from '../src/index.js';

const ok = (schema: { safeParse: (v: unknown) => { success: boolean } }, v: unknown) =>
  schema.safeParse(v).success;

const id = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';

const validCreate = {
  id,
  type: 'bank',
  name: 'Banco Union',
  currencyCode: 'BOB',
  initialBalance: '100.50',
  initialBalanceDate: '2026-01-15',
  color: 'blue',
  icon: 'wallet',
};

describe('AccountType', () => {
  it('TASK-096 acepta los seis tipos y rechaza otros', () => {
    for (const t of ['cash', 'bank', 'ewallet', 'credit_card', 'savings', 'other']) {
      expect(ok(AccountType, t)).toBe(true);
    }
    expect(ok(AccountType, 'crypto')).toBe(false);
  });
});

describe('CreateAccountInput', () => {
  it('TASK-096 acepta una entrada valida', () => {
    expect(ok(CreateAccountInput, validCreate)).toBe(true);
  });

  it('RF-M4-01 el nombre debe tener de 1 a 40 caracteres', () => {
    expect(ok(CreateAccountInput, { ...validCreate, name: '' })).toBe(false);
    expect(ok(CreateAccountInput, { ...validCreate, name: '   ' })).toBe(false);
    expect(ok(CreateAccountInput, { ...validCreate, name: 'a'.repeat(40) })).toBe(true);
    expect(ok(CreateAccountInput, { ...validCreate, name: 'a'.repeat(41) })).toBe(false);
  });

  it('RF-M4-02 un saldo inicial de 1.000.000.000,00 es invalido', () => {
    expect(ok(CreateAccountInput, { ...validCreate, initialBalance: '1000000000.00' })).toBe(false);
    expect(ok(CreateAccountInput, { ...validCreate, initialBalance: '-1000000000.00' })).toBe(
      false,
    );
    expect(ok(CreateAccountInput, { ...validCreate, initialBalance: '999999999.99' })).toBe(true);
    expect(ok(CreateAccountInput, { ...validCreate, initialBalance: '-999999999.99' })).toBe(true);
  });

  it('RF-M4-02 el saldo inicial admite 2 decimales como maximo', () => {
    expect(ok(CreateAccountInput, { ...validCreate, initialBalance: '1.234' })).toBe(false);
  });

  it('RF-M4-02 la tarjeta usa la forma kind debt o credit con monto', () => {
    const card = { ...validCreate, type: 'credit_card' };
    expect(
      ok(CreateAccountInput, { ...card, initialBalance: { kind: 'debt', amount: '50.00' } }),
    ).toBe(true);
    expect(
      ok(CreateAccountInput, { ...card, initialBalance: { kind: 'credit', amount: '50.00' } }),
    ).toBe(true);
    expect(
      ok(CreateAccountInput, { ...card, initialBalance: { kind: 'other', amount: '50.00' } }),
    ).toBe(false);
    expect(
      ok(CreateAccountInput, {
        ...card,
        initialBalance: { kind: 'debt', amount: '1000000000.00' },
      }),
    ).toBe(false);
  });

  it('RF-M4-02 el id debe ser un uuid', () => {
    expect(ok(CreateAccountInput, { ...validCreate, id: 'no-es-uuid' })).toBe(false);
  });

  it('RF-M4-08 el dia de corte o de pago fuera de 1-31 es invalido', () => {
    const withCard = (card: object) => ({
      ...validCreate,
      type: 'credit_card',
      card: { cutDay: null, payDay: null, limit: null, ...card },
    });
    expect(ok(CreateAccountInput, withCard({}))).toBe(true);
    expect(ok(CreateAccountInput, withCard({ cutDay: 1, payDay: 31 }))).toBe(true);
    expect(ok(CreateAccountInput, withCard({ cutDay: 0 }))).toBe(false);
    expect(ok(CreateAccountInput, withCard({ cutDay: 32 }))).toBe(false);
    expect(ok(CreateAccountInput, withCard({ payDay: 0 }))).toBe(false);
    expect(ok(CreateAccountInput, withCard({ payDay: 32 }))).toBe(false);
    expect(ok(CreateAccountInput, withCard({ payDay: 15.5 }))).toBe(false);
  });
});

describe('UpdateAccountInput', () => {
  it('RF-M4-07 acepta nombre, color, icono y tipo', () => {
    expect(ok(UpdateAccountInput, { name: 'Nuevo', color: 'blue', type: 'cash' })).toBe(true);
    expect(ok(UpdateAccountInput, {})).toBe(true);
  });

  it('RF-M4-07 rechaza initialBalance e initialBalanceDate', () => {
    expect(ok(UpdateAccountInput, { initialBalance: '10.00' })).toBe(false);
    expect(ok(UpdateAccountInput, { initialBalanceDate: '2026-01-01' })).toBe(false);
  });

  it('RF-M4-01 el nombre editado tambien tiene maximo 40 caracteres', () => {
    expect(ok(UpdateAccountInput, { name: 'a'.repeat(41) })).toBe(false);
  });

  it('RF-M4-08 el dia de corte editado fuera de 1-31 es invalido', () => {
    const card = { cutDay: 40, payDay: null, limit: null };
    expect(ok(UpdateAccountInput, { card })).toBe(false);
    expect(ok(UpdateAccountInput, { card: { ...card, cutDay: 10 } })).toBe(true);
  });
});

describe('AdjustInput, ArchiveInput, RestoreInput, ReorderInput', () => {
  it('RF-M4-02 AdjustInput acepta saldo real texto o forma tarjeta', () => {
    expect(ok(AdjustInput, { transactionId: id, realBalance: '10.00' })).toBe(true);
    expect(
      ok(AdjustInput, { transactionId: id, realBalance: { kind: 'debt', amount: '10.00' } }),
    ).toBe(true);
    expect(ok(AdjustInput, { transactionId: 'x', realBalance: '10.00' })).toBe(false);
    expect(
      ok(AdjustInput, {
        transactionId: id,
        realBalance: { kind: 'debt', amount: '1000000000.00' },
      }),
    ).toBe(false);
  });

  it('TASK-096 ArchiveInput usa confirmNonZero false por defecto', () => {
    expect(ArchiveInput.parse({})).toEqual({ confirmNonZero: false });
    expect(ok(ArchiveInput, { confirmNonZero: 'si' })).toBe(false);
  });

  it('RF-M4-01 RestoreInput valida el nuevo nombre opcional', () => {
    expect(ok(RestoreInput, {})).toBe(true);
    expect(ok(RestoreInput, { newName: 'Otra' })).toBe(true);
    expect(ok(RestoreInput, { newName: 'a'.repeat(41) })).toBe(false);
  });

  it('TASK-096 ReorderInput exige al menos un uuid', () => {
    expect(ok(ReorderInput, { ids: [id] })).toBe(true);
    expect(ok(ReorderInput, { ids: [] })).toBe(false);
    expect(ok(ReorderInput, { ids: ['x'] })).toBe(false);
  });
});
