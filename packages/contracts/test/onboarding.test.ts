import { describe, expect, it } from 'vitest';

import { OnboardingDto, SkipInput, Step1Input, Step2Input, Step3Input } from '../src/index.js';

const ok = (schema: { safeParse: (v: unknown) => { success: boolean } }, v: unknown) =>
  schema.safeParse(v).success;

const id = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
const id2 = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c';

const uuidAt = (n: number) => `0190a1b2-c3d4-7e5f-8a9b-${n.toString(16).padStart(12, '0')}`;

const validAccount = {
  id,
  name: 'Efectivo',
  type: 'cash',
  currencyCode: 'BOB',
  balance: '0',
};

const withAccount = (account: object) => ({ accounts: [{ ...validAccount, ...account }] });

const validCategory = {
  id: id2,
  kind: 'expense',
  parentId: null,
  name: 'Mascotas',
  color: 'blue',
  icon: 'wallet',
};

const presetNode = {
  id,
  kind: 'expense',
  name: 'Comida',
  color: 'orange',
  icon: 'utensils',
  isSystem: false,
  status: 'active',
  children: [],
};

const validDto = {
  step: 1,
  completed: false,
  presets: { accounts: [], categories: [presetNode] },
  rate: null,
};

describe('Step1Input', () => {
  it('RF-M10-04 Step1Input solo acepta BOB o USD como moneda base', () => {
    expect(ok(Step1Input, { baseCurrency: 'BOB' })).toBe(true);
    expect(ok(Step1Input, { baseCurrency: 'USD' })).toBe(true);
    expect(ok(Step1Input, { baseCurrency: 'EUR' })).toBe(false);
    expect(ok(Step1Input, { baseCurrency: 'bob' })).toBe(false);
    expect(ok(Step1Input, { baseCurrency: '' })).toBe(false);
    expect(ok(Step1Input, {})).toBe(false);
  });
});

describe('Step2Input', () => {
  it('RF-M10-04 Step2Input acepta una cuenta valida con su saldo de hoy', () => {
    expect(ok(Step2Input, withAccount({}))).toBe(true);
    expect(ok(Step2Input, withAccount({ balance: '1500.50' }))).toBe(true);
  });

  it('RF-M10-04 el saldo llega en valor absoluto hasta 999999999.99', () => {
    expect(ok(Step2Input, withAccount({ type: 'bank', balance: '999999999.99' }))).toBe(true);
    expect(ok(Step2Input, withAccount({ type: 'bank', balance: '-999999999.99' }))).toBe(true);
    expect(ok(Step2Input, withAccount({ type: 'bank', balance: '1000000000.00' }))).toBe(false);
    expect(ok(Step2Input, withAccount({ type: 'bank', balance: '-1000000000.00' }))).toBe(false);
  });

  it('RF-M10-04 el saldo admite 2 decimales como maximo', () => {
    expect(ok(Step2Input, withAccount({ balance: '10.25' }))).toBe(true);
    expect(ok(Step2Input, withAccount({ balance: '10.5' }))).toBe(true);
    expect(ok(Step2Input, withAccount({ balance: '1.234' }))).toBe(false);
  });

  it('RF-M10-04 el saldo viaja como texto decimal y rechaza otros formatos', () => {
    expect(ok(Step2Input, withAccount({ balance: 100 }))).toBe(false);
    expect(ok(Step2Input, withAccount({ balance: 0.5 }))).toBe(false);
    for (const balance of ['abc', '', '1,5', '1e3']) {
      expect(ok(Step2Input, withAccount({ balance }))).toBe(false);
    }
    expect(ok(Step2Input, withAccount({ balance: undefined }))).toBe(false);
  });

  it('RF-M10-04 la fecha del saldo no la fija el cliente', () => {
    const r = Step2Input.safeParse(withAccount({ initialBalanceDate: '2020-01-01' }));
    const parsed: unknown = r.success ? r.data.accounts[0] : {};
    expect(parsed).not.toHaveProperty('initialBalanceDate');
  });

  it('RF-M4-01 el nombre de la cuenta debe tener de 1 a 40 caracteres', () => {
    expect(ok(Step2Input, withAccount({ name: '' }))).toBe(false);
    expect(ok(Step2Input, withAccount({ name: '   ' }))).toBe(false);
    expect(ok(Step2Input, withAccount({ name: 'a'.repeat(40) }))).toBe(true);
    expect(ok(Step2Input, withAccount({ name: 'a'.repeat(41) }))).toBe(false);
  });

  it('TASK-155 cada cuenta lleva un id uuid, un tipo de cuenta y un codigo de moneda', () => {
    expect(ok(Step2Input, withAccount({ id: 'no-es-uuid' }))).toBe(false);
    for (const type of ['cash', 'bank', 'ewallet', 'credit_card', 'savings', 'other']) {
      expect(ok(Step2Input, withAccount({ type }))).toBe(true);
    }
    expect(ok(Step2Input, withAccount({ type: 'crypto' }))).toBe(false);
    expect(ok(Step2Input, withAccount({ currencyCode: 'USD' }))).toBe(true);
    expect(ok(Step2Input, withAccount({ currencyCode: 'usd' }))).toBe(false);
  });

  it('TASK-155 Step2Input acepta hasta 20 cuentas', () => {
    const accounts = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ ...validAccount, id: uuidAt(i + 1), name: `C${i}` }));
    expect(ok(Step2Input, { accounts: accounts(20) })).toBe(true);
    expect(ok(Step2Input, { accounts: accounts(21) })).toBe(false);
  });
});

describe('Step3Input', () => {
  it('TASK-155 Step3Input recibe las categorias a quitar y las nuevas', () => {
    expect(ok(Step3Input, { removeCategoryIds: [], newCategories: [] })).toBe(true);
    expect(ok(Step3Input, { removeCategoryIds: [id], newCategories: [validCategory] })).toBe(true);
  });

  it('TASK-155 Step3Input exige uuid en las categorias a quitar', () => {
    expect(ok(Step3Input, { removeCategoryIds: ['x'], newCategories: [] })).toBe(false);
  });

  it('TASK-155 Step3Input valida las nuevas categorias como CreateCategoryInput', () => {
    const bad = (category: object) => ({
      removeCategoryIds: [],
      newCategories: [{ ...validCategory, ...category }],
    });
    expect(ok(Step3Input, bad({ name: 'a'.repeat(31) }))).toBe(false);
    expect(ok(Step3Input, bad({ kind: 'transfer' }))).toBe(false);
    expect(ok(Step3Input, bad({ id: 'no-es-uuid' }))).toBe(false);
  });
});

describe('SkipInput', () => {
  it('TASK-155 SkipInput solo acepta los pasos 1, 2 o 3', () => {
    expect(ok(SkipInput, { step: 1 })).toBe(true);
    expect(ok(SkipInput, { step: 2 })).toBe(true);
    expect(ok(SkipInput, { step: 3 })).toBe(true);
    expect(ok(SkipInput, { step: 0 })).toBe(false);
    expect(ok(SkipInput, { step: 4 })).toBe(false);
    expect(ok(SkipInput, { step: 1.5 })).toBe(false);
    expect(ok(SkipInput, { step: '1' })).toBe(false);
    expect(ok(SkipInput, {})).toBe(false);
  });
});

describe('OnboardingDto', () => {
  it('TASK-155 OnboardingDto lleva paso, estado, precargas y tasa nula', () => {
    expect(ok(OnboardingDto, validDto)).toBe(true);
    expect(ok(OnboardingDto, { ...validDto, step: 3, completed: true })).toBe(true);
  });

  it('TASK-155 OnboardingDto acepta la tasa en uso', () => {
    const rate = { kind: 'parallel_median', value: '10.25' };
    expect(ok(OnboardingDto, { ...validDto, rate })).toBe(true);
  });

  it('TASK-155 OnboardingDto solo admite los pasos 1, 2 o 3', () => {
    expect(ok(OnboardingDto, { ...validDto, step: 0 })).toBe(false);
    expect(ok(OnboardingDto, { ...validDto, step: 4 })).toBe(false);
  });

  it('TASK-155 OnboardingDto exige las categorias precargadas como arbol', () => {
    const presets = { accounts: [], categories: [{ ...presetNode, children: undefined }] };
    expect(ok(OnboardingDto, { ...validDto, presets })).toBe(false);
    expect(ok(OnboardingDto, { ...validDto, presets: undefined })).toBe(false);
  });
});
