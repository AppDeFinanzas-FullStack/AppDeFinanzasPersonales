import { ICON_KEYS, PALETTE } from '@finanzas/contracts';
import { describe, expect, it } from 'vitest';
import { PRESET_CATEGORIES } from '../seed/preset-categories.js';

type Node = (typeof PRESET_CATEGORIES)[number];

const EXPENSES: [string, string[]][] = [
  ['Comida', ['Supermercado', 'Restaurantes']],
  ['Transporte', ['Micro/Trufi', 'Taxi/Apps', 'Combustible']],
  ['Vivienda', ['Alquiler', 'Anticrético']],
  ['Servicios', ['Luz', 'Agua', 'Gas', 'Internet', 'Celular', 'Comisiones bancarias']],
  ['Salud', []],
  ['Educación', []],
  ['Ocio', []],
  ['Ropa', []],
  ['Cuidado personal', []],
  ['Regalos', []],
  ['Mascotas', []],
  ['Otros gastos', []],
];
const INCOMES = [
  'Sueldo',
  'Negocio/Ventas',
  'Mesada',
  'Trabajos independientes',
  'Regalos recibidos',
  'Otros ingresos',
];

function roots(kind: 'expense' | 'income'): Node[] {
  return PRESET_CATEGORIES.filter((c) => c.kind === kind);
}

function shape(nodes: Node[]): [string, string[]][] {
  return nodes.map((n) => [n.name, (n.children ?? []).map((c) => c.name)]);
}

describe('preset categories', () => {
  it('TASK-025 la lista de gastos coincide exactamente con spec 2.5.1, en orden', () => {
    const list = roots('expense').filter((c) => c.systemKey === undefined);
    expect(shape(list)).toEqual(EXPENSES);
  });

  it('TASK-025 la lista de ingresos coincide exactamente con spec 2.5.1, en orden', () => {
    const list = roots('income').filter((c) => c.systemKey === undefined);
    expect(list.map((c) => c.name)).toEqual(INCOMES);
    for (const c of list) {
      expect(c.children ?? []).toEqual([]);
    }
  });

  it('TASK-025 no hay otras categorias raiz ademas de las precargadas y las del sistema', () => {
    expect(PRESET_CATEGORIES).toHaveLength(EXPENSES.length + INCOMES.length + 2);
  });

  it('RF-M5-05 Deudas y préstamos existe en gasto y en ingreso con Intereses, del sistema', () => {
    for (const kind of ['expense', 'income'] as const) {
      const debts = roots(kind).find((c) => c.name === 'Deudas y préstamos');
      expect(debts).toBeDefined();
      expect(debts?.systemKey).toBe('debts');
      expect(debts?.children).toHaveLength(1);
      const interest = debts?.children?.[0];
      expect(interest?.name).toBe('Intereses');
      expect(interest?.systemKey).toBe('debts_interest');
      expect(interest?.kind).toBe(kind);
    }
  });

  it('RF-M5-05 solo las categorias del sistema llevan systemKey', () => {
    const withKey: string[] = [];
    const walk = (nodes: readonly Node[]): void => {
      for (const n of nodes) {
        if (n.systemKey !== undefined) withKey.push(n.name);
        walk(n.children ?? []);
      }
    };
    walk(PRESET_CATEGORIES);
    expect(withKey.sort()).toEqual(
      ['Deudas y préstamos', 'Deudas y préstamos', 'Intereses', 'Intereses'].sort(),
    );
  });

  it('RF-M6-05 existe Servicios > Comisiones bancarias en gastos', () => {
    const services = roots('expense').find((c) => c.name === 'Servicios');
    expect(services?.children?.map((c) => c.name)).toContain('Comisiones bancarias');
  });

  it('TASK-025 seedOrder empieza en 0 y cuenta por tipo entre raices y por padre entre hijas', () => {
    for (const kind of ['expense', 'income'] as const) {
      const rs = roots(kind);
      expect(rs.map((c) => c.seedOrder)).toEqual(rs.map((_, i) => i));
      for (const r of rs) {
        const cs = r.children ?? [];
        expect(cs.map((c) => c.seedOrder)).toEqual(cs.map((_, i) => i));
      }
    }
  });

  it('RF-M5-04 iconos del catalogo y colores de la paleta, hijas con el color del padre', () => {
    const icons: readonly string[] = ICON_KEYS;
    const colors = Object.keys(PALETTE);
    for (const r of PRESET_CATEGORIES) {
      expect(icons).toContain(r.icon);
      expect(colors).toContain(r.color);
      for (const c of r.children ?? []) {
        expect(icons).toContain(c.icon);
        expect(c.color).toBe(r.color);
        expect(c.kind).toBe(r.kind);
      }
    }
  });
});
