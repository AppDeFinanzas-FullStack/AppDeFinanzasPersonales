import { describe, expect, it } from 'vitest';

import {
  CreateGoalInput,
  DedicateInput,
  EarmarkInput,
  GoalDto,
  ReleaseInput,
  UpdateGoalInput,
} from '../src/index.js';

const ok = (schema: { safeParse: (v: unknown) => { success: boolean } }, v: unknown) =>
  schema.safeParse(v).success;

const id = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
const acc = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c';

const validCreate = {
  id,
  name: 'Viaje',
  target: '1000.00',
  currencyCode: 'BOB',
  icon: 'wallet',
  color: 'blue',
};

describe('CreateGoalInput', () => {
  it('RF-M12-01 acepta una meta válida, con fecha y cuenta dedicada opcionales', () => {
    expect(ok(CreateGoalInput, validCreate)).toBe(true);
    expect(
      ok(CreateGoalInput, { ...validCreate, targetDate: '2027-01-01', dedicatedAccountId: acc }),
    ).toBe(true);
  });

  it('RF-M12-01 el nombre va de 1 a 40 caracteres', () => {
    expect(ok(CreateGoalInput, { ...validCreate, name: 'a' })).toBe(true);
    expect(ok(CreateGoalInput, { ...validCreate, name: 'a'.repeat(40) })).toBe(true);
    expect(ok(CreateGoalInput, { ...validCreate, name: '' })).toBe(false);
    expect(ok(CreateGoalInput, { ...validCreate, name: '   ' })).toBe(false);
    expect(ok(CreateGoalInput, { ...validCreate, name: 'a'.repeat(41) })).toBe(false);
  });

  it('RF-M12-01 el objetivo debe ser mayor que 0', () => {
    expect(ok(CreateGoalInput, { ...validCreate, target: '0.01' })).toBe(true);
    expect(ok(CreateGoalInput, { ...validCreate, target: '0' })).toBe(false);
    expect(ok(CreateGoalInput, { ...validCreate, target: '0.00' })).toBe(false);
    expect(ok(CreateGoalInput, { ...validCreate, target: '-5' })).toBe(false);
  });

  it('RF-M12-01 exige id uuid y moneda de tres letras', () => {
    expect(ok(CreateGoalInput, { ...validCreate, id: 'x' })).toBe(false);
    expect(ok(CreateGoalInput, { ...validCreate, currencyCode: 'bo' })).toBe(false);
  });
});

describe('UpdateGoalInput', () => {
  it('RF-M12-01 la moneda es editable', () => {
    const r = UpdateGoalInput.safeParse({ currencyCode: 'USD' });
    expect(r.success).toBe(true);
  });

  it('RF-M12-01 todos los campos son opcionales y se validan si vienen', () => {
    expect(ok(UpdateGoalInput, {})).toBe(true);
    expect(ok(UpdateGoalInput, { name: 'a'.repeat(41) })).toBe(false);
    expect(ok(UpdateGoalInput, { name: '' })).toBe(false);
    expect(ok(UpdateGoalInput, { target: '0' })).toBe(false);
    expect(ok(UpdateGoalInput, { name: 'Nuevo', target: '50' })).toBe(true);
  });

  it('RF-M12-01 dedicatedAccountId no se acepta en UpdateGoalInput', () => {
    const r = UpdateGoalInput.safeParse({ name: 'Nuevo', dedicatedAccountId: acc });
    expect(r.success ? Object.keys(r.data) : []).not.toContain('dedicatedAccountId');
  });

  it('RF-M12-01 el id no se acepta en UpdateGoalInput', () => {
    const r = UpdateGoalInput.safeParse({ name: 'Nuevo', id });
    expect(r.success ? Object.keys(r.data) : []).not.toContain('id');
  });
});

describe('EarmarkInput, ReleaseInput y DedicateInput', () => {
  it('RF-M12-01 EarmarkInput exige id, cuenta y monto', () => {
    expect(ok(EarmarkInput, { id, accountId: acc, amount: '10.00' })).toBe(true);
    expect(ok(EarmarkInput, { accountId: acc, amount: '10.00' })).toBe(false);
    expect(ok(EarmarkInput, { id, accountId: acc, amount: '0' })).toBe(false);
  });

  it('RF-M12-01 ReleaseInput exige cuenta y monto', () => {
    expect(ok(ReleaseInput, { accountId: acc, amount: '5' })).toBe(true);
    expect(ok(ReleaseInput, { amount: '5' })).toBe(false);
    expect(ok(ReleaseInput, { accountId: 'x', amount: '5' })).toBe(false);
  });

  it('RF-M12-01 DedicateInput exige una cuenta uuid', () => {
    expect(ok(DedicateInput, { accountId: acc })).toBe(true);
    expect(ok(DedicateInput, { accountId: 'x' })).toBe(false);
    expect(ok(DedicateInput, {})).toBe(false);
  });
});

describe('GoalDto', () => {
  const dto = {
    id,
    name: 'Viaje',
    target: '1000.00',
    currencyCode: 'BOB',
    icon: 'wallet',
    color: 'blue',
    status: 'in_progress',
    progress: '250.00',
    pct: 25,
    byAccount: [{ accountId: acc, name: 'Caja', amount: '250.00', dedicated: true }],
    suggested: { kind: 'monthly', amount: '125.00', untilMonth: '2026-12' },
    dedicatedAccount: { id: acc, name: 'Caja' },
    firstAchievement: false,
  };

  it('RF-M12-01 acepta un GoalDto completo y uno sin opcionales', () => {
    expect(ok(GoalDto, dto)).toBe(true);
    expect(
      ok(GoalDto, {
        ...dto,
        dedicatedAccount: undefined,
        targetDate: undefined,
        suggested: { kind: 'none' },
      }),
    ).toBe(true);
  });

  it('RF-M12-01 GoalDto rechaza estados y tipos de sugerencia desconocidos', () => {
    expect(ok(GoalDto, { ...dto, status: 'done' })).toBe(false);
    expect(ok(GoalDto, { ...dto, suggested: { kind: 'other' } })).toBe(false);
    for (const status of ['in_progress', 'achieved', 'overdue', 'archived']) {
      expect(ok(GoalDto, { ...dto, status })).toBe(true);
    }
  });
});
