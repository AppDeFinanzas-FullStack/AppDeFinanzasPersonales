import { Decimal } from 'decimal.js';
import { describe, expect, it } from 'vitest';
import { formatMoney, parseAmountInput } from '../src/index.js';

// Conventions used by these tests (plan §4.9.1, plan §4.7.1):
// - formatMoney(amount: Decimal, symbol: string, numberFormat: 'dot_comma' | 'comma_dot').
//   'dot_comma' = "Bs 1.234,56" (default), 'comma_dot' = "Bs 1,234.56".
// - parseAmountInput(raw: string): Decimal | null.
// - Negative amounts use the typographic minus sign U+2212 (spec: "Bs −50,00").

const MINUS = '−';
const d = (value: string): Decimal => new Decimal(value);

function expectAmount(result: Decimal | null, expected: string): void {
  expect(result).not.toBeNull();
  expect((result as Decimal).equals(d(expected))).toBe(true);
}

describe('format: formatMoney (RF-M9-02)', () => {
  it('RF-M9-02 con el formato dot_comma muestra "Bs 1.234,56"', () => {
    expect(formatMoney(d('1234.56'), 'Bs', 'dot_comma')).toBe('Bs 1.234,56');
  });

  it('RF-M9-02 con el formato comma_dot muestra "Bs 1,234.56"', () => {
    expect(formatMoney(d('1234.56'), 'Bs', 'comma_dot')).toBe('Bs 1,234.56');
  });

  it('RF-M9-02 el símbolo va antes del monto, separado por un espacio, con dos decimales', () => {
    expect(formatMoney(d('35'), 'Bs', 'dot_comma')).toBe('Bs 35,00');
    expect(formatMoney(d('97.09'), '$', 'dot_comma')).toBe('$ 97,09');
    expect(formatMoney(d('35'), 'Bs', 'comma_dot')).toBe('Bs 35.00');
    expect(formatMoney(d('97.09'), '$', 'comma_dot')).toBe('$ 97.09');
  });

  it('RF-M9-02 agrupa los miles en montos grandes según el formato', () => {
    expect(formatMoney(d('1234567.89'), 'Bs', 'dot_comma')).toBe('Bs 1.234.567,89');
    expect(formatMoney(d('1234567.89'), 'Bs', 'comma_dot')).toBe('Bs 1,234,567.89');
  });

  it('RF-M9-02 sin separador de miles en montos menores a mil', () => {
    expect(formatMoney(d('0.5'), 'Bs', 'dot_comma')).toBe('Bs 0,50');
    expect(formatMoney(d('999.99'), 'Bs', 'comma_dot')).toBe('Bs 999.99');
  });

  it('RF-M9-02 los negativos llevan el signo menos tipográfico después del símbolo', () => {
    expect(formatMoney(d('-50'), 'Bs', 'dot_comma')).toBe(`Bs ${MINUS}50,00`);
    expect(formatMoney(d('-5'), 'Bs', 'dot_comma')).toBe(`Bs ${MINUS}5,00`);
    expect(formatMoney(d('-1234.56'), 'Bs', 'comma_dot')).toBe(`Bs ${MINUS}1,234.56`);
    expect(formatMoney(d('-50'), 'Bs', 'dot_comma')).not.toContain('-');
  });
});

describe('format: parseAmountInput (RF-M7-02)', () => {
  it('RF-M7-02 Formato de números: "35.50" da 35,50 con el formato "Bs 1,234.56"', () => {
    expectAmount(parseAmountInput('35.50'), '35.50');
  });

  it('RF-M7-02 Punto decimal con el formato por defecto: "35.50" da 35,50 con el formato "Bs 1.234,56"', () => {
    expectAmount(parseAmountInput('35.50'), '35.50');
  });

  it('RF-M7-02 "35,50" da 35,50 sea cual sea el formato', () => {
    expectAmount(parseAmountInput('35,50'), '35.50');
  });

  it('RF-M7-02 "35,5" y "35.5" dan 35,50 (un solo dígito decimal)', () => {
    expectAmount(parseAmountInput('35,5'), '35.50');
    expectAmount(parseAmountInput('35.5'), '35.50');
  });

  it('RF-M7-02 solo dígitos se toma como monto entero', () => {
    expectAmount(parseAmountInput('35'), '35');
    expectAmount(parseAmountInput('1234'), '1234');
  });

  it('RF-M7-02 "1.234" da null (no acepta separador de miles)', () => {
    expect(parseAmountInput('1.234')).toBeNull();
    expect(parseAmountInput('1,234')).toBeNull();
  });

  it('RF-M7-02 "1,234.56" da null (no acepta separador de miles)', () => {
    expect(parseAmountInput('1,234.56')).toBeNull();
    expect(parseAmountInput('1.234,56')).toBeNull();
  });

  it('RF-M7-02 "3+4" da null (no acepta operaciones)', () => {
    expect(parseAmountInput('3+4')).toBeNull();
    expect(parseAmountInput('10-2')).toBeNull();
    expect(parseAmountInput('2*3')).toBeNull();
  });

  it('RF-M7-02 texto que no es un número da null', () => {
    expect(parseAmountInput('abc')).toBeNull();
    expect(parseAmountInput('35a')).toBeNull();
  });
});
