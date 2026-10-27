import { describe, expect, it } from 'vitest';

import { BudgetDto, CreateBudgetInput, DecisionInput, UpdateBudgetInput } from '../src/index.js';

const ok = (schema: { safeParse: (v: unknown) => { success: boolean } }, v: unknown) =>
  schema.safeParse(v).success;

const id = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
const cat = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c';

const validCreate = {
  id,
  scope: 'category',
  categoryId: cat,
  amount: '500.00',
  currencyCode: 'BOB',
};

describe('CreateBudgetInput', () => {
  it('TASK-193 acepta un presupuesto válido y aplica los valores por defecto', () => {
    const r = CreateBudgetInput.safeParse(validCreate);
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.startDay).toBe(1);
    expect(r.data.defaultAction).toBe('discard');
    expect(r.data.thresholds).toEqual([80, 100]);
  });

  it('TASK-193 acepta un presupuesto general sin categoría', () => {
    expect(ok(CreateBudgetInput, { id, scope: 'general', amount: '1000', currencyCode: 'USD' })).toBe(
      true,
    );
  });

  it('TASK-193 rechaza id no uuid, alcance desconocido y moneda inválida', () => {
    expect(ok(CreateBudgetInput, { ...validCreate, id: 'x' })).toBe(false);
    expect(ok(CreateBudgetInput, { ...validCreate, scope: 'otro' })).toBe(false);
    expect(ok(CreateBudgetInput, { ...validCreate, currencyCode: 'bo' })).toBe(false);
    expect(ok(CreateBudgetInput, { ...validCreate, defaultAction: 'absorb' })).toBe(false);
  });

  it('RF-M11-13 los umbrales [100, 80] se ordenan a [80, 100]', () => {
    const r = CreateBudgetInput.safeParse({ ...validCreate, thresholds: [100, 80] });
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.thresholds).toEqual([80, 100]);
  });

  it('RF-M11-13 umbrales repetidos son inválidos', () => {
    expect(ok(CreateBudgetInput, { ...validCreate, thresholds: [80, 80] })).toBe(false);
  });

  it('RF-M11-13 más de 3 umbrales son inválidos; de 0 a 3 son válidos', () => {
    expect(ok(CreateBudgetInput, { ...validCreate, thresholds: [50, 80, 100, 120] })).toBe(false);
    expect(ok(CreateBudgetInput, { ...validCreate, thresholds: [50, 80, 100] })).toBe(true);
    expect(ok(CreateBudgetInput, { ...validCreate, thresholds: [] })).toBe(true);
  });

  it('RF-M11-13 cada umbral va de 1 % a 150 % y es entero', () => {
    expect(ok(CreateBudgetInput, { ...validCreate, thresholds: [1, 150] })).toBe(true);
    expect(ok(CreateBudgetInput, { ...validCreate, thresholds: [0] })).toBe(false);
    expect(ok(CreateBudgetInput, { ...validCreate, thresholds: [151] })).toBe(false);
    expect(ok(CreateBudgetInput, { ...validCreate, thresholds: [80.5] })).toBe(false);
  });

  it('RF-M11-04 startDay va de 1 a 28', () => {
    expect(ok(CreateBudgetInput, { ...validCreate, startDay: 1 })).toBe(true);
    expect(ok(CreateBudgetInput, { ...validCreate, startDay: 28 })).toBe(true);
    expect(ok(CreateBudgetInput, { ...validCreate, startDay: 0 })).toBe(false);
    expect(ok(CreateBudgetInput, { ...validCreate, startDay: 29 })).toBe(false);
    expect(ok(CreateBudgetInput, { ...validCreate, startDay: 15.5 })).toBe(false);
  });
});

describe('UpdateBudgetInput', () => {
  it('RF-M11-07 UpdateBudgetInput rechaza currencyCode', () => {
    expect(ok(UpdateBudgetInput, { currencyCode: 'USD' })).toBe(false);
    expect(ok(UpdateBudgetInput, { amount: '100', currencyCode: 'USD' })).toBe(false);
  });

  it('RF-M11-07 acepta cambios parciales de monto, acción, umbrales y día de inicio', () => {
    expect(ok(UpdateBudgetInput, {})).toBe(true);
    expect(ok(UpdateBudgetInput, { amount: '250.50' })).toBe(true);
    expect(ok(UpdateBudgetInput, { defaultAction: 'carry' })).toBe(true);
    expect(ok(UpdateBudgetInput, { startDay: 10 })).toBe(true);
    expect(ok(UpdateBudgetInput, { thresholds: [100, 50] })).toBe(true);
  });

  it('RF-M11-07 rechaza campos desconocidos (estricto)', () => {
    expect(ok(UpdateBudgetInput, { foo: 1 })).toBe(false);
  });

  it('RF-M11-04 en la edición startDay también va de 1 a 28', () => {
    expect(ok(UpdateBudgetInput, { startDay: 0 })).toBe(false);
    expect(ok(UpdateBudgetInput, { startDay: 29 })).toBe(false);
  });

  it('RF-M11-13 en la edición los umbrales se ordenan y no admiten repetidos ni más de 3', () => {
    const r = UpdateBudgetInput.safeParse({ thresholds: [100, 80] });
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.thresholds).toEqual([80, 100]);
    expect(ok(UpdateBudgetInput, { thresholds: [80, 80] })).toBe(false);
    expect(ok(UpdateBudgetInput, { thresholds: [10, 20, 30, 40] })).toBe(false);
  });
});

describe('DecisionInput', () => {
  it('RF-M11-08 un sobrante exige carry y discard', () => {
    expect(ok(DecisionInput, { result: 'surplus', carry: '10.00', discard: '5.00' })).toBe(true);
    expect(ok(DecisionInput, { result: 'surplus', discard: '5.00' })).toBe(false);
    expect(ok(DecisionInput, { result: 'surplus', carry: '10.00' })).toBe(false);
  });

  it('RF-M11-08 un sobrante puede enviar parte a una meta', () => {
    expect(
      ok(DecisionInput, {
        result: 'surplus',
        carry: '0',
        discard: '0',
        toGoal: { goalId: id, accountId: cat, amount: '15.00', mode: 'earmark' },
      }),
    ).toBe(true);
    expect(
      ok(DecisionInput, {
        result: 'surplus',
        carry: '0',
        discard: '0',
        toGoal: { goalId: id, accountId: cat, amount: '15.00', mode: 'otro' },
      }),
    ).toBe(false);
  });

  it('RF-M11-08 un exceso exige mode carry o absorb', () => {
    expect(ok(DecisionInput, { result: 'deficit', mode: 'carry' })).toBe(true);
    expect(ok(DecisionInput, { result: 'deficit', mode: 'absorb' })).toBe(true);
    expect(ok(DecisionInput, { result: 'deficit' })).toBe(false);
    expect(ok(DecisionInput, { result: 'deficit', mode: 'discard' })).toBe(false);
  });

  it('RF-M11-08 rechaza un resultado desconocido', () => {
    expect(ok(DecisionInput, { result: 'otro', mode: 'carry' })).toBe(false);
  });
});

describe('BudgetDto', () => {
  it('TASK-193 BudgetDto se exporta', () => {
    expect(BudgetDto).toBeDefined();
  });
});
