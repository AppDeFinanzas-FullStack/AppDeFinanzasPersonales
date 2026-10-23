import { describe, expect, it } from 'vitest';
import { Decimal } from 'decimal.js';
import { earmarkProposal, progress, status, suggestedMonthly } from '../src/index.js';

// Conventions (plan §4.12.1, money as decimal text, ADR-03):
// - progress(dedicated, earmarks, rates) returns decimal text in the goal currency.
//   dedicated is { amount, currencyCode } | null; rates is { goalCurrency, bobPerUnit } (Bs per unit, BOB = 1).
// - status(goal, progress, today) returns 'in_progress' | 'achieved' | 'overdue'.
// - suggestedMonthly(target, progress, targetDate | undefined, today) returns { kind, amount?, untilMonth? }.
// - earmarkProposal(shortfall, earmarksByGoal) returns [{ goalId, amount }] in take order.

const bobRates = { goalCurrency: 'BOB', bobPerUnit: { BOB: new Decimal(1), USD: new Decimal('6.96') } };

describe('progress (RF-M12-02, EC-M12-04)', () => {
  it('RF-M12-02 Progreso combinado: dedicada 850 y apartados 200 y 150 dan 1200', () => {
    const result = progress(
      { amount: '850.00', currencyCode: 'BOB' },
      [
        { amount: '200.00', currencyCode: 'BOB' },
        { amount: '150.00', currencyCode: 'BOB' },
      ],
      bobRates,
    );
    expect(Number(result)).toBe(1200);
  });

  it('EC-M12-04 una dedicada en -100 aporta 0', () => {
    const result = progress({ amount: '-100.00', currencyCode: 'BOB' }, [{ amount: '50.00', currencyCode: 'BOB' }], bobRates);
    expect(Number(result)).toBe(50);
    expect(Number(progress({ amount: '-100.00', currencyCode: 'BOB' }, [], bobRates))).toBe(0);
  });

  it('RF-M12-02 sin dedicada solo suman los apartados', () => {
    expect(Number(progress(null, [{ amount: '70.00', currencyCode: 'BOB' }], bobRates))).toBe(70);
  });

  it('RF-M12-02 convierte a la moneda de la meta con la tasa vigente', () => {
    const usdRates = { goalCurrency: 'USD', bobPerUnit: { BOB: new Decimal(1), USD: new Decimal('6.96') } };
    expect(Number(progress(null, [{ amount: '696.00', currencyCode: 'BOB' }], usdRates))).toBe(100);
  });
});

describe('status (ADR-13)', () => {
  const today = '2026-10-15';

  it('EC-M12-03 una meta en USD cumplida pasa a en curso si el dólar sube', () => {
    const goal = { target: '100.00', currencyCode: 'USD', targetDate: '2026-12-31' };
    const at = (usd: string) => ({ goalCurrency: 'USD', bobPerUnit: { BOB: new Decimal(1), USD: new Decimal(usd) } });
    const apartado = [{ amount: '696.00', currencyCode: 'BOB' }];
    expect(status(goal, progress(null, apartado, at('6.96')), today)).toBe('achieved');
    expect(status(goal, progress(null, apartado, at('9.00')), today)).toBe('in_progress');
  });

  it('RF-M12-06 progreso igual al objetivo es cumplida', () => {
    expect(status({ target: '100.00', currencyCode: 'BOB' }, '100.00', today)).toBe('achieved');
  });

  it('RF-M12-06 con fecha pasada y sin alcanzar el objetivo está vencida', () => {
    expect(status({ target: '100.00', currencyCode: 'BOB', targetDate: '2026-09-30' }, '40.00', today)).toBe('overdue');
  });

  it('RF-M12-06 con fecha futura y sin alcanzar está en curso', () => {
    expect(status({ target: '100.00', currencyCode: 'BOB', targetDate: '2026-11-30' }, '40.00', today)).toBe('in_progress');
  });
});

describe('suggestedMonthly (RF-M12-06)', () => {
  const today = '2026-10-15';

  it('RF-M12-06 mensual: (objetivo - progreso) / meses restantes incluido el actual', () => {
    const result = suggestedMonthly('1000.00', '400.00', '2026-12-20', today);
    expect(result.kind).toBe('monthly');
    expect(Number(result.amount)).toBe(200);
  });

  it('RF-M12-06 con la fecha en este mes muestra "Faltan X este mes"', () => {
    const result = suggestedMonthly('1000.00', '400.00', '2026-10-31', today);
    expect(result.kind).toBe('this_month');
    expect(Number(result.amount)).toBe(600);
  });

  it('RF-M12-06 sin fecha muestra la calculadora', () => {
    expect(suggestedMonthly('1000.00', '400.00', undefined, today).kind).toBe('calculator');
  });

  it('RF-M12-06 vencida pide elegir una nueva fecha', () => {
    expect(suggestedMonthly('1000.00', '400.00', '2026-09-01', today).kind).toBe('pick_new_date');
  });

  it('RF-M12-06 si el progreso alcanzó el objetivo no se muestra', () => {
    expect(suggestedMonthly('1000.00', '1000.00', '2026-12-20', today).kind).toBe('none');
    expect(suggestedMonthly('1000.00', '1200.00', undefined, today).kind).toBe('none');
  });
});

describe('earmarkProposal (RF-M12-05)', () => {
  it('RF-M12-05 la propuesta toma primero de la meta sin fecha', () => {
    const result = earmarkProposal('250.00', [
      { goalId: 'dated', targetDate: '2026-12-31', amount: '200.00' },
      { goalId: 'open', amount: '100.00' },
    ]);
    expect(result.map((r) => r.goalId)).toEqual(['open', 'dated']);
    expect(result.map((r) => Number(r.amount))).toEqual([100, 150]);
  });

  it('RF-M12-05 entre metas con fecha toma primero la más lejana', () => {
    const result = earmarkProposal('50.00', [
      { goalId: 'near', targetDate: '2026-11-30', amount: '100.00' },
      { goalId: 'far', targetDate: '2027-06-30', amount: '100.00' },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]?.goalId).toBe('far');
    expect(Number(result[0]?.amount)).toBe(50);
  });
});
