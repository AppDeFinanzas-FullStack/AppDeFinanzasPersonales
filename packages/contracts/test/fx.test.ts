import { describe, expect, it } from 'vitest';

import {
  CreateCurrencyInput,
  FxSettingsInput,
  ManualUsdInput,
  RateHistoryQuery,
  RatesCurrentDto,
  UpdateCurrencyInput,
  UsdReference,
} from '../src/index.js';

const ref = (value: string, source: string = 'paralelo_bo') => ({
  value,
  observedAt: '2026-10-19T12:00:00.000Z',
  source,
});

const validRates = () => ({
  references: {
    parallel_bid: ref('9.50'),
    parallel_ask: ref('9.80'),
    parallel_median: ref('9.65'),
    official: ref('6.96', 'bcb'),
  },
  inUse: { kind: 'parallel_median', value: '9.65', since: '2026-10-19T12:00:00.000Z' },
  gap: { pct: '38.65', bs: '2.69', comparedKind: 'parallel_median' },
  base: 'BOB',
  other: 'USD',
});

describe('fx: CreateCurrencyInput (RF-M3-02)', () => {
  it('RF-M3-02 acepta código de 3 mayúsculas, símbolo y tasa válidos', () => {
    expect(CreateCurrencyInput.safeParse({ code: 'EUR', symbol: '€', rate: '7.50' }).success).toBe(
      true,
    );
  });

  it('RF-M3-02 rechaza códigos que no son 3 letras mayúsculas', () => {
    for (const code of ['eur', 'EU', 'EURO', 'E1R', 'EU ', '']) {
      expect(CreateCurrencyInput.safeParse({ code, symbol: '€', rate: '7.5' }).success).toBe(false);
    }
  });

  it('RF-M3-02 la tasa mínima es 0,01', () => {
    expect(CreateCurrencyInput.safeParse({ code: 'EUR', symbol: '€', rate: '0.01' }).success).toBe(
      true,
    );
    for (const rate of ['0.009', '0', '0.00', '-1', '']) {
      expect(CreateCurrencyInput.safeParse({ code: 'EUR', symbol: '€', rate }).success).toBe(false);
    }
  });

  it('RF-M3-02 la tasa viaja como texto decimal, no como número', () => {
    expect(CreateCurrencyInput.safeParse({ code: 'EUR', symbol: '€', rate: 7.5 }).success).toBe(
      false,
    );
    expect(CreateCurrencyInput.safeParse({ code: 'EUR', symbol: '€', rate: '7.555' }).success).toBe(
      false,
    );
  });

  it('RF-M3-02 el símbolo tiene entre 1 y 5 caracteres tras recortar', () => {
    expect(CreateCurrencyInput.safeParse({ code: 'EUR', symbol: '   ', rate: '7' }).success).toBe(
      false,
    );
    expect(CreateCurrencyInput.safeParse({ code: 'EUR', symbol: 'ABCDEF', rate: '7' }).success).toBe(
      false,
    );
    expect(CreateCurrencyInput.safeParse({ code: 'EUR', symbol: 'ABCDE', rate: '7' }).success).toBe(
      true,
    );
  });
});

describe('fx: UpdateCurrencyInput y ManualUsdInput (RF-M3-02)', () => {
  it('RF-M3-02 UpdateCurrencyInput admite campos opcionales', () => {
    expect(UpdateCurrencyInput.safeParse({}).success).toBe(true);
    expect(UpdateCurrencyInput.safeParse({ symbol: '$' }).success).toBe(true);
    expect(UpdateCurrencyInput.safeParse({ rate: '0.01' }).success).toBe(true);
  });

  it('RF-M3-02 UpdateCurrencyInput rechaza tasa menor a 0,01', () => {
    expect(UpdateCurrencyInput.safeParse({ rate: '0.00' }).success).toBe(false);
    expect(UpdateCurrencyInput.safeParse({ rate: '0.005' }).success).toBe(false);
  });

  it('RF-M3-02 ManualUsdInput exige un valor ≥ 0,01', () => {
    expect(ManualUsdInput.safeParse({ value: '9.80' }).success).toBe(true);
    expect(ManualUsdInput.safeParse({ value: '0.01' }).success).toBe(true);
    expect(ManualUsdInput.safeParse({ value: '0' }).success).toBe(false);
    expect(ManualUsdInput.safeParse({}).success).toBe(false);
  });
});

describe('fx: FxSettingsInput y UsdReference', () => {
  it('TASK-077 UsdReference admite solo las cuatro referencias', () => {
    expect([...UsdReference.options].sort()).toEqual(
      ['official', 'parallel_ask', 'parallel_bid', 'parallel_median'].sort(),
    );
  });

  it('TASK-077 FxSettingsInput tiene campos opcionales y los valida', () => {
    expect(FxSettingsInput.safeParse({}).success).toBe(true);
    expect(FxSettingsInput.safeParse({ usdReference: 'official', baseCurrency: 'USD' }).success).toBe(
      true,
    );
    expect(FxSettingsInput.safeParse({ usdReference: 'manual' }).success).toBe(false);
    expect(FxSettingsInput.safeParse({ baseCurrency: 'usd' }).success).toBe(false);
  });
});

describe('fx: RateHistoryQuery', () => {
  it('TASK-077 solo admite los rangos 7d, 30d, 90d y 1y', () => {
    for (const range of ['7d', '30d', '90d', '1y']) {
      expect(RateHistoryQuery.safeParse({ kind: 'official', range }).success).toBe(true);
    }
    for (const range of ['1d', '14d', '2y', '7D', '']) {
      expect(RateHistoryQuery.safeParse({ kind: 'official', range }).success).toBe(false);
    }
  });

  it('TASK-077 exige una referencia válida', () => {
    expect(RateHistoryQuery.safeParse({ kind: 'nope', range: '7d' }).success).toBe(false);
    expect(RateHistoryQuery.safeParse({ range: '7d' }).success).toBe(false);
  });
});

describe('fx: RatesCurrentDto (RF-M3-05, RF-M3-12)', () => {
  it('RF-M3-05 acepta referencias con observedAt y source', () => {
    expect(RatesCurrentDto.safeParse(validRates()).success).toBe(true);
  });

  it('RF-M3-05 acepta referencias nulas', () => {
    const d = validRates();
    expect(
      RatesCurrentDto.safeParse({
        ...d,
        references: { ...d.references, parallel_bid: null },
      }).success,
    ).toBe(true);
  });

  it('RF-M3-05 rechaza una referencia sin observedAt o sin source', () => {
    const d = validRates();
    const noObserved = { value: '9.50', source: 'seed' };
    const noSource = { value: '9.50', observedAt: '2026-10-19T12:00:00.000Z' };
    for (const bad of [noObserved, noSource]) {
      expect(
        RatesCurrentDto.safeParse({ ...d, references: { ...d.references, official: bad } }).success,
      ).toBe(false);
    }
  });

  it('RF-M3-05 la fuente es paralelo_bo, bcb o seed', () => {
    const d = validRates();
    for (const source of ['paralelo_bo', 'bcb', 'seed']) {
      expect(
        RatesCurrentDto.safeParse({
          ...d,
          references: { ...d.references, official: ref('6.96', source) },
        }).success,
      ).toBe(true);
    }
    expect(
      RatesCurrentDto.safeParse({
        ...d,
        references: { ...d.references, official: ref('6.96', 'otra') },
      }).success,
    ).toBe(false);
  });

  it('RF-M3-02 el valor de una referencia es una tasa ≥ 0,01', () => {
    const d = validRates();
    expect(
      RatesCurrentDto.safeParse({
        ...d,
        references: { ...d.references, official: ref('0.00') },
      }).success,
    ).toBe(false);
  });

  it('RF-M3-12 la brecha lleva pct, bs y el tipo comparado, o es null', () => {
    const d = validRates();
    expect(RatesCurrentDto.safeParse({ ...d, gap: null }).success).toBe(true);
    expect(
      RatesCurrentDto.safeParse({ ...d, gap: { pct: '38.65', bs: '2.69', comparedKind: 'manual' } })
        .success,
    ).toBe(true);
    expect(RatesCurrentDto.safeParse({ ...d, gap: { pct: '38.65', bs: '2.69' } }).success).toBe(
      false,
    );
    expect(
      RatesCurrentDto.safeParse({ ...d, gap: { pct: '1', bs: '2', comparedKind: 'otra' } }).success,
    ).toBe(false);
  });

  it('RF-M3-12 inUse admite manual, valor nulo y since opcional', () => {
    const d = validRates();
    expect(
      RatesCurrentDto.safeParse({ ...d, inUse: { kind: 'manual', value: '9.90' } }).success,
    ).toBe(true);
    expect(
      RatesCurrentDto.safeParse({ ...d, inUse: { kind: 'official', value: null } }).success,
    ).toBe(true);
    expect(RatesCurrentDto.safeParse({ ...d, inUse: { kind: 'otra', value: null } }).success).toBe(
      false,
    );
  });

  it('RF-M3-12 exige base y other como códigos de moneda', () => {
    const d = validRates();
    expect(RatesCurrentDto.safeParse({ ...d, base: 'bob' }).success).toBe(false);
    expect(RatesCurrentDto.safeParse({ ...d, other: 'US' }).success).toBe(false);
  });
});
