import { describe, expect, it } from 'vitest';

import { ICON_KEYS, IconKey, PALETTE, PaletteKey, THEME_BACKGROUND } from '../src/index.js';

const HEX = /^#[0-9a-f]{6}$/;

function channel(v: number): number {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function luminance(hex: string): number {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

describe('catalogs: PaletteKey (RF-M5-04, RNF-06)', () => {
  const keys = Object.keys(PALETTE);

  it('RF-M5-04 hay exactamente 12 colores', () => {
    expect(keys).toHaveLength(12);
    expect(PaletteKey.options).toHaveLength(12);
    expect([...PaletteKey.options].sort()).toEqual([...keys].sort());
  });

  it('RF-M5-04 THEME_BACKGROUND fija los fondos claro y oscuro', () => {
    expect(THEME_BACKGROUND).toEqual({ light: '#ffffff', dark: '#020817' });
  });

  it('RF-M5-04 cada color tiene valor claro y oscuro en hex de 6 dígitos', () => {
    for (const k of keys) {
      const entry = PALETTE[k as keyof typeof PALETTE];
      expect(entry.light).toMatch(HEX);
      expect(entry.dark).toMatch(HEX);
    }
  });

  it('RF-M5-04 cada color tiene contraste >= 4,5:1 contra el fondo del tema claro', () => {
    for (const k of keys) {
      const entry = PALETTE[k as keyof typeof PALETTE];
      expect(contrast(entry.light, THEME_BACKGROUND.light), k).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('RF-M5-04 cada color tiene contraste >= 4,5:1 contra el fondo del tema oscuro', () => {
    for (const k of keys) {
      const entry = PALETTE[k as keyof typeof PALETTE];
      expect(contrast(entry.dark, THEME_BACKGROUND.dark), k).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('RF-M5-04 PaletteKey acepta una clave válida y rechaza otras', () => {
    expect(PaletteKey.safeParse(PaletteKey.options[0]).success).toBe(true);
    expect(PaletteKey.safeParse('no-existe').success).toBe(false);
    expect(PaletteKey.safeParse('#ffffff').success).toBe(false);
  });
});

describe('catalogs: IconKey (RF-M5-04)', () => {
  it('RF-M5-04 hay entre 55 y 65 íconos', () => {
    expect(ICON_KEYS.length).toBeGreaterThanOrEqual(55);
    expect(ICON_KEYS.length).toBeLessThanOrEqual(65);
  });

  it('RF-M5-04 los nombres de íconos son únicos', () => {
    expect(new Set(ICON_KEYS).size).toBe(ICON_KEYS.length);
  });

  it('RF-M5-04 los nombres están en kebab-case', () => {
    for (const k of ICON_KEYS) expect(k).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });

  it('RF-M5-04 IconKey coincide con ICON_KEYS y rechaza nombres ajenos', () => {
    expect([...IconKey.options].sort()).toEqual([...ICON_KEYS].sort());
    expect(IconKey.safeParse(ICON_KEYS[0]).success).toBe(true);
    expect(IconKey.safeParse('no-such-icon').success).toBe(false);
  });
});
