import { describe, expect, it } from 'vitest';

import { CreateDebtInput, DeleteDebtInput, PaymentInput, UpdateDebtInput } from '../src/index.js';

const ok = (schema: { safeParse: (v: unknown) => { success: boolean } }, v: unknown) =>
  schema.safeParse(v).success;

const id = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
const id2 = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c';
const id3 = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5d';
const id4 = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5e';

const debt = {
  id,
  direction: 'i_owe',
  person: 'Juan',
  principal: '1000.00',
  currencyCode: 'BOB',
  startDate: '2026-10-01',
};

const withRate = (rate: string) => ({ ...debt, interest: { rate, period: 'monthly' } });

describe('CreateDebtInput', () => {
  it('RF-M13-01 acepta una deuda minima en ambas direcciones', () => {
    expect(ok(CreateDebtInput, debt)).toBe(true);
    expect(ok(CreateDebtInput, { ...debt, direction: 'owed_to_me' })).toBe(true);
    expect(ok(CreateDebtInput, { ...debt, direction: 'other' })).toBe(false);
  });

  it('RF-M13-01 acepta los campos opcionales completos', () => {
    expect(
      ok(CreateDebtInput, {
        ...debt,
        dueDate: '2026-12-01',
        note: 'Prestamo',
        interest: { rate: '5', period: 'yearly' },
        initialMovement: { transactionId: id2, accountId: id3, declaredRate: '6.96' },
      }),
    ).toBe(true);
  });

  it('RF-M13-01 la persona va de 1 a 40 caracteres', () => {
    expect(ok(CreateDebtInput, { ...debt, person: 'A' })).toBe(true);
    expect(ok(CreateDebtInput, { ...debt, person: 'a'.repeat(40) })).toBe(true);
    expect(ok(CreateDebtInput, { ...debt, person: 'a'.repeat(41) })).toBe(false);
    expect(ok(CreateDebtInput, { ...debt, person: '' })).toBe(false);
  });

  it('RF-M13-01 una persona solo con espacios se rechaza', () => {
    expect(ok(CreateDebtInput, { ...debt, person: '   ' })).toBe(false);
  });

  it('RF-M13-01 el monto es mayor que 0', () => {
    expect(ok(CreateDebtInput, { ...debt, principal: '0.01' })).toBe(true);
    expect(ok(CreateDebtInput, { ...debt, principal: '0' })).toBe(false);
    expect(ok(CreateDebtInput, { ...debt, principal: '-5.00' })).toBe(false);
  });

  it('RF-M13-01 el interes va de 0,01 a 100', () => {
    expect(ok(CreateDebtInput, withRate('0.01'))).toBe(true);
    expect(ok(CreateDebtInput, withRate('100'))).toBe(true);
    expect(ok(CreateDebtInput, withRate('0'))).toBe(false);
    expect(ok(CreateDebtInput, withRate('0.0099'))).toBe(false);
    expect(ok(CreateDebtInput, withRate('100.0001'))).toBe(false);
    expect(ok(CreateDebtInput, withRate('101'))).toBe(false);
  });

  it('RF-M13-01 el interes admite hasta 4 decimales', () => {
    expect(ok(CreateDebtInput, withRate('12.3456'))).toBe(true);
    expect(ok(CreateDebtInput, withRate('12.34567'))).toBe(false);
    expect(ok(CreateDebtInput, withRate('-1'))).toBe(false);
    expect(ok(CreateDebtInput, withRate('abc'))).toBe(false);
  });

  it('RF-M13-03 la tasa se fija al crear con un periodo mensual o anual', () => {
    expect(ok(CreateDebtInput, { ...debt, interest: { rate: '2', period: 'monthly' } })).toBe(true);
    expect(ok(CreateDebtInput, { ...debt, interest: { rate: '2', period: 'yearly' } })).toBe(true);
    expect(ok(CreateDebtInput, { ...debt, interest: { rate: '2', period: 'daily' } })).toBe(false);
    expect(ok(CreateDebtInput, { ...debt, interest: { rate: '2' } })).toBe(false);
  });

  it('TASK-208 rechaza un id que no es UUID', () => {
    expect(ok(CreateDebtInput, { ...debt, id: 'abc' })).toBe(false);
  });
});

describe('UpdateDebtInput', () => {
  it('RF-M13-10 acepta persona, nota, fecha limite y monto original', () => {
    expect(ok(UpdateDebtInput, {})).toBe(true);
    expect(
      ok(UpdateDebtInput, {
        person: 'Ana',
        note: 'nota',
        dueDate: '2026-12-31',
        principal: '500.00',
      }),
    ).toBe(true);
  });

  it('RF-M13-10 la fecha limite se puede quitar con null', () => {
    expect(ok(UpdateDebtInput, { dueDate: null })).toBe(true);
  });

  it('RF-M13-01 la persona editada va de 1 a 40 caracteres', () => {
    expect(ok(UpdateDebtInput, { person: 'a'.repeat(40) })).toBe(true);
    expect(ok(UpdateDebtInput, { person: 'a'.repeat(41) })).toBe(false);
    expect(ok(UpdateDebtInput, { person: '  ' })).toBe(false);
  });

  it('RF-M13-03 rechaza la tasa y el periodo', () => {
    expect(ok(UpdateDebtInput, { interest: { rate: '2', period: 'monthly' } })).toBe(false);
    expect(ok(UpdateDebtInput, { rate: '2' })).toBe(false);
    expect(ok(UpdateDebtInput, { period: 'yearly' })).toBe(false);
  });

  it('RF-M13-10 no acepta la direccion ni la moneda', () => {
    expect(ok(UpdateDebtInput, { direction: 'owed_to_me' })).toBe(false);
    expect(ok(UpdateDebtInput, { currencyCode: 'USD' })).toBe(false);
    expect(ok(UpdateDebtInput, { person: 'Ana', currencyCode: 'USD' })).toBe(false);
  });
});

describe('PaymentInput', () => {
  const payment = {
    id,
    amount: '100.00',
    interestPart: '10.00',
    capitalPart: '90.00',
    date: '2026-10-10',
  };

  it('TASK-208 acepta un pago sin cuenta y con cuenta', () => {
    expect(ok(PaymentInput, payment)).toBe(true);
    expect(
      ok(PaymentInput, {
        ...payment,
        note: 'cuota',
        account: {
          accountId: id2,
          capitalTransactionId: id3,
          interestTransactionId: id4,
        },
      }),
    ).toBe(true);
  });

  it('TASK-208 rechaza un pago con monto 0 o un id invalido', () => {
    expect(ok(PaymentInput, { ...payment, amount: '0' })).toBe(false);
    expect(ok(PaymentInput, { ...payment, id: 'abc' })).toBe(false);
  });
});

describe('DeleteDebtInput', () => {
  it('TASK-208 acepta delete, keep o nada y rechaza otro valor', () => {
    expect(ok(DeleteDebtInput, {})).toBe(true);
    expect(ok(DeleteDebtInput, { movements: 'delete' })).toBe(true);
    expect(ok(DeleteDebtInput, { movements: 'keep' })).toBe(true);
    expect(ok(DeleteDebtInput, { movements: 'archive' })).toBe(false);
  });
});
