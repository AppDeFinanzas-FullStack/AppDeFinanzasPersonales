import { describe, expect, it } from 'vitest';

interface Schema {
  safeParse: (v: unknown) => {
    success: boolean;
    error?: { issues: { message: string }[] };
  };
}

const { ConfirmOccurrenceInput, CreateRuleInput, ResumeInput, UpdateRuleInput } =
  (await import('../src/index.js')) as unknown as Record<
    'ConfirmOccurrenceInput' | 'CreateRuleInput' | 'ResumeInput' | 'UpdateRuleInput',
    Schema
  >;

const ok = (schema: Schema, v: unknown) => schema.safeParse(v).success;

const id = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
const accountId = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c';
const categoryId = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5d';

const validRule = {
  id,
  name: 'Alquiler',
  kind: 'expense',
  amount: '1500.00',
  accountId,
  categoryId,
  frequency: { type: 'monthly', day: 5 },
  startDate: '2030-01-05',
  end: { type: 'none' },
  mode: 'auto',
};

const without = (key: keyof typeof validRule): Partial<typeof validRule> => {
  const copy: Partial<typeof validRule> = { ...validRule };
  delete copy[key];
  return copy;
};

describe('CreateRuleInput', () => {
  it('TASK-223 acepta una regla valida', () => {
    expect(ok(CreateRuleInput, validRule)).toBe(true);
  });

  it('RF-M14-14 una regla automatica sin monto da AMOUNT_REQUIRED_FOR_AUTO', () => {
    const withoutAmount = without('amount');
    const result = CreateRuleInput.safeParse({ ...withoutAmount, mode: 'auto' });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.message)).toContain(
      'AMOUNT_REQUIRED_FOR_AUTO',
    );
  });

  it('RF-M14-14 una regla con confirmacion sin monto es valida', () => {
    const withoutAmount = without('amount');
    expect(ok(CreateRuleInput, { ...withoutAmount, mode: 'confirm' })).toBe(true);
  });

  it('RF-M14-14 una regla con confirmacion con monto tambien es valida', () => {
    expect(ok(CreateRuleInput, { ...validRule, mode: 'confirm' })).toBe(true);
  });

  it('RF-M14-01 acepta las frecuencias diaria, semanal, mensual y anual', () => {
    for (const frequency of [
      { type: 'daily' },
      { type: 'weekly', weekday: 1 },
      { type: 'monthly', day: 31 },
      { type: 'yearly', month: 2, day: 29 },
    ]) {
      expect(ok(CreateRuleInput, { ...validRule, frequency })).toBe(true);
    }
    expect(ok(CreateRuleInput, { ...validRule, frequency: { type: 'hourly' } })).toBe(false);
  });

  it('RF-M14-01 una regla semanal exige un unico weekday', () => {
    expect(ok(CreateRuleInput, { ...validRule, frequency: { type: 'weekly' } })).toBe(false);
    expect(
      ok(CreateRuleInput, { ...validRule, frequency: { type: 'weekly', weekday: [1, 3] } }),
    ).toBe(false);
    expect(ok(CreateRuleInput, { ...validRule, frequency: { type: 'weekly', weekday: 0 } })).toBe(
      true,
    );
    expect(ok(CreateRuleInput, { ...validRule, frequency: { type: 'weekly', weekday: 6 } })).toBe(
      true,
    );
    expect(ok(CreateRuleInput, { ...validRule, frequency: { type: 'weekly', weekday: 7 } })).toBe(
      false,
    );
    expect(ok(CreateRuleInput, { ...validRule, frequency: { type: 'weekly', weekday: -1 } })).toBe(
      false,
    );
    expect(ok(CreateRuleInput, { ...validRule, frequency: { type: 'weekly', weekday: 1.5 } })).toBe(
      false,
    );
  });

  it('RF-M14-01 la mensual exige un dia de 1 a 31 y la anual un mes de 1 a 12', () => {
    expect(ok(CreateRuleInput, { ...validRule, frequency: { type: 'monthly', day: 0 } })).toBe(
      false,
    );
    expect(ok(CreateRuleInput, { ...validRule, frequency: { type: 'monthly', day: 32 } })).toBe(
      false,
    );
    expect(ok(CreateRuleInput, { ...validRule, frequency: { type: 'monthly' } })).toBe(false);
    expect(
      ok(CreateRuleInput, { ...validRule, frequency: { type: 'yearly', month: 13, day: 1 } }),
    ).toBe(false);
    expect(
      ok(CreateRuleInput, { ...validRule, frequency: { type: 'yearly', month: 0, day: 1 } }),
    ).toBe(false);
    expect(ok(CreateRuleInput, { ...validRule, frequency: { type: 'yearly', month: 12 } })).toBe(
      false,
    );
  });

  it('RF-M14-15 el nombre va de 1 a 40 caracteres', () => {
    expect(ok(CreateRuleInput, { ...validRule, name: '' })).toBe(false);
    expect(ok(CreateRuleInput, { ...validRule, name: '   ' })).toBe(false);
    expect(ok(CreateRuleInput, { ...validRule, name: 'a' })).toBe(true);
    expect(ok(CreateRuleInput, { ...validRule, name: 'a'.repeat(40) })).toBe(true);
    expect(ok(CreateRuleInput, { ...validRule, name: 'a'.repeat(41) })).toBe(false);
  });

  it('RF-M14-03 la fecha de inicio es obligatoria y es una fecha local', () => {
    const withoutStart = without('startDate');
    expect(ok(CreateRuleInput, withoutStart)).toBe(false);
    expect(ok(CreateRuleInput, { ...validRule, startDate: '05/01/2030' })).toBe(false);
    expect(ok(CreateRuleInput, { ...validRule, startDate: '2030-01-05' })).toBe(true);
  });

  it('TASK-223 el fin por cantidad va de 1 a 999', () => {
    expect(ok(CreateRuleInput, { ...validRule, end: { type: 'count', count: 0 } })).toBe(false);
    expect(ok(CreateRuleInput, { ...validRule, end: { type: 'count', count: 1 } })).toBe(true);
    expect(ok(CreateRuleInput, { ...validRule, end: { type: 'count', count: 999 } })).toBe(true);
    expect(ok(CreateRuleInput, { ...validRule, end: { type: 'count', count: 1000 } })).toBe(false);
    expect(ok(CreateRuleInput, { ...validRule, end: { type: 'count', count: 2.5 } })).toBe(false);
  });

  it('TASK-223 el fin es ninguno, hasta una fecha o por cantidad', () => {
    expect(ok(CreateRuleInput, { ...validRule, end: { type: 'until', date: '2031-01-01' } })).toBe(
      true,
    );
    expect(ok(CreateRuleInput, { ...validRule, end: { type: 'until' } })).toBe(false);
    expect(ok(CreateRuleInput, { ...validRule, end: { type: 'forever' } })).toBe(false);
  });

  it('TASK-223 el id es un UUID y el tipo y el modo son de los permitidos', () => {
    expect(ok(CreateRuleInput, { ...validRule, id: 'not-a-uuid' })).toBe(false);
    expect(ok(CreateRuleInput, { ...validRule, kind: 'income' })).toBe(true);
    expect(ok(CreateRuleInput, { ...validRule, kind: 'loan' })).toBe(false);
    expect(ok(CreateRuleInput, { ...validRule, mode: 'manual' })).toBe(false);
  });

  it('TASK-223 el monto viaja como texto decimal', () => {
    expect(ok(CreateRuleInput, { ...validRule, amount: 1500 })).toBe(false);
    expect(ok(CreateRuleInput, { ...validRule, amount: '0' })).toBe(false);
    expect(ok(CreateRuleInput, { ...validRule, amount: '1.234' })).toBe(false);
  });
});

describe('UpdateRuleInput', () => {
  it('TASK-223 todos los campos son opcionales', () => {
    expect(ok(UpdateRuleInput, {})).toBe(true);
    expect(ok(UpdateRuleInput, { name: 'Luz' })).toBe(true);
  });

  it('RF-M14-15 al editar, el nombre sigue yendo de 1 a 40 caracteres', () => {
    expect(ok(UpdateRuleInput, { name: '' })).toBe(false);
    expect(ok(UpdateRuleInput, { name: 'a'.repeat(41) })).toBe(false);
  });

  it('TASK-223 al editar, el fin por cantidad sigue yendo de 1 a 999', () => {
    expect(ok(UpdateRuleInput, { end: { type: 'count', count: 0 } })).toBe(false);
    expect(ok(UpdateRuleInput, { end: { type: 'count', count: 999 } })).toBe(true);
  });
});

describe('ConfirmOccurrenceInput', () => {
  it('TASK-223 exige un transactionId UUID y el resto es opcional', () => {
    expect(ok(ConfirmOccurrenceInput, { transactionId: id })).toBe(true);
    expect(ok(ConfirmOccurrenceInput, {})).toBe(false);
    expect(ok(ConfirmOccurrenceInput, { transactionId: 'x' })).toBe(false);
    expect(
      ok(ConfirmOccurrenceInput, {
        transactionId: id,
        amount: '250.00',
        date: '2030-02-05',
        rateUsdBob: '6.96',
        accountId,
        categoryId,
      }),
    ).toBe(true);
    expect(ok(ConfirmOccurrenceInput, { transactionId: id, amount: '0' })).toBe(false);
  });
});

describe('ResumeInput', () => {
  it('TASK-223 recibe una lista de fechas a registrar', () => {
    expect(ok(ResumeInput, { registerDates: [] })).toBe(true);
    expect(ok(ResumeInput, { registerDates: ['2030-01-01', '2030-01-02'] })).toBe(true);
    expect(ok(ResumeInput, { registerDates: ['ayer'] })).toBe(false);
    expect(ok(ResumeInput, {})).toBe(false);
  });
});
