import { Decimal } from 'decimal.js';
import { describe, expect, it } from 'vitest';
import { parseMoney, round2, sumRounded, toMoneyString } from '../src/index.js';

// Deterministic PRNG (mulberry32) so the property test is reproducible.
function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomInt(rng: () => number, maxExclusive: number): number {
  return Math.floor(rng() * maxExclusive);
}

// Builds a decimal string with `scale` fractional digits from integer parts (no floats involved).
function randomDecimalString(rng: () => number, scale: number): string {
  const negative = rng() < 0.5;
  const intPart = randomInt(rng, 1_000_000);
  let frac = '';
  for (let i = 0; i < scale; i++) frac += String(randomInt(rng, 10));
  return `${negative ? '-' : ''}${intPart}.${frac}`;
}

// Reference rounding to cents with half away from zero, using BigInt only.
function referenceCents(value: string): bigint {
  const negative = value.startsWith('-');
  const abs = negative ? value.slice(1) : value;
  const [intPart = '0', fracPart = ''] = abs.split('.');
  const padded = fracPart.padEnd(3, '0');
  let cents = BigInt(intPart) * 100n + BigInt(padded.slice(0, 2));
  const rest = padded.slice(2);
  // Round half away from zero: any remainder >= .005 (in absolute value) goes up.
  if (rest.length > 0 && BigInt(rest) * 2n >= 10n ** BigInt(rest.length)) cents += 1n;
  return negative ? -cents : cents;
}

function centsToString(cents: bigint): string {
  const negative = cents < 0n;
  const abs = negative ? -cents : cents;
  const intPart = abs / 100n;
  const frac = (abs % 100n).toString().padStart(2, '0');
  return `${negative && abs !== 0n ? '-' : ''}${intPart}.${frac}`;
}

describe('money: round2', () => {
  it('RN-06 0,005 se redondea a 0,01', () => {
    expect(toMoneyString(round2(new Decimal('0.005')))).toBe('0.01');
  });

  it('RN-06 -0,005 se redondea a -0,01 (la mitad se aleja del cero)', () => {
    expect(toMoneyString(round2(new Decimal('-0.005')))).toBe('-0.01');
  });

  it('RN-06 2,345 se redondea a 2,35', () => {
    expect(toMoneyString(round2(new Decimal('2.345')))).toBe('2.35');
  });

  it('RN-06 por debajo de la mitad se redondea hacia abajo (2,344 -> 2,34; -2,344 -> -2,34)', () => {
    expect(toMoneyString(round2(new Decimal('2.344')))).toBe('2.34');
    expect(toMoneyString(round2(new Decimal('-2.344')))).toBe('-2.34');
  });

  it('RN-06 round2 devuelve un Decimal, no un number', () => {
    const result = round2(new Decimal('1.005'));
    expect(typeof result).not.toBe('number');
    expect(Decimal.isDecimal(result)).toBe(true);
    expect(result.toFixed(2)).toBe('1.01');
  });

  it('RN-06 round2 es exacto al centavo para valores de gran magnitud (sin punto flotante)', () => {
    expect(toMoneyString(round2(new Decimal('999999999999.995')))).toBe('1000000000000.00');
    expect(toMoneyString(round2(new Decimal('0.1').plus('0.2')))).toBe('0.30');
  });
});

describe('money: parseMoney y toMoneyString', () => {
  it('RN-06 parseMoney lee texto decimal y toMoneyString lo devuelve con 2 decimales ("1234.56")', () => {
    const parsed = parseMoney('1234.56');
    expect(typeof parsed).not.toBe('number');
    expect(Decimal.isDecimal(parsed)).toBe(true);
    expect(toMoneyString(parsed)).toBe('1234.56');
  });

  it('RN-06 toMoneyString siempre muestra 2 decimales', () => {
    expect(toMoneyString(parseMoney('1234'))).toBe('1234.00');
    expect(toMoneyString(parseMoney('1234.5'))).toBe('1234.50');
    expect(toMoneyString(parseMoney('-0.5'))).toBe('-0.50');
    expect(toMoneyString(parseMoney('0'))).toBe('0.00');
  });

  it('RN-06 toMoneyString devuelve texto sin separadores de miles ni notación exponencial', () => {
    expect(toMoneyString(parseMoney('999999999.99'))).toBe('999999999.99');
    expect(toMoneyString(parseMoney('0.01'))).toBe('0.01');
  });

  it('RN-06 toMoneyString devuelve un string', () => {
    expect(typeof toMoneyString(parseMoney('1.00'))).toBe('string');
  });
});

describe('money: sumRounded', () => {
  it('RN-06 el total es la suma de las conversiones ya redondeadas', () => {
    const conversions = ['0.005', '0.005', '0.005'].map((v) => round2(new Decimal(v)));
    // Each rounds to 0.01, so the total is 0.03 (not round2(0.015) = 0.02).
    expect(toMoneyString(sumRounded(conversions))).toBe('0.03');
  });

  it('RN-06 sumRounded de una lista vacía es 0.00', () => {
    expect(toMoneyString(sumRounded([]))).toBe('0.00');
  });

  it('RN-06 sumRounded devuelve un Decimal, no un number', () => {
    const total = sumRounded([parseMoney('1.10'), parseMoney('2.20')]);
    expect(typeof total).not.toBe('number');
    expect(Decimal.isDecimal(total)).toBe(true);
    expect(toMoneyString(total)).toBe('3.30');
  });

  it('RNF-18 propiedad: 1.000 casos aleatorios, sumRounded no acumula diferencias', () => {
    const rng = makeRng(20261019);
    for (let caseIndex = 0; caseIndex < 1000; caseIndex++) {
      const count = 1 + randomInt(rng, 50);
      const raw: string[] = [];
      for (let i = 0; i < count; i++) raw.push(randomDecimalString(rng, 1 + randomInt(rng, 8)));

      let expectedCents = 0n;
      for (const value of raw) expectedCents += referenceCents(value);

      const rounded = raw.map((value) => round2(new Decimal(value)));
      rounded.forEach((value, i) => {
        expect(value.eq(centsToString(referenceCents(raw[i] ?? '0'))), `valor ${raw[i]}`).toBe(true);
      });

      const total = sumRounded(rounded);
      expect(total.eq(centsToString(expectedCents)), `caso ${caseIndex}: ${raw.join(', ')}`).toBe(
        true,
      );
    }
  });
});
