import { describe, expect, it } from 'vitest';

import { parentOf } from '../src/app/layout/route-parents';

const MOBILE = { desktop: false };
const DESKTOP = { desktop: true };

const MORE_ROOTS = [
  '/categorias',
  '/tipo-de-cambio',
  '/presupuestos',
  '/metas',
  '/deudas',
  '/recurrentes',
  '/perfil',
  '/ajustes',
];

describe('parentOf: pantallas que cuelgan de otra', () => {
  it.each([
    ['/movimientos/abc', '/movimientos'],
    ['/cuentas/nueva', '/cuentas'],
    ['/cuentas/abc', '/cuentas'],
    ['/cuentas/abc/editar', '/cuentas/abc'],
    ['/categorias/nueva', '/categorias'],
    ['/categorias/archivadas', '/categorias'],
    ['/categorias/abc/editar', '/categorias'],
    ['/presupuestos/abc', '/presupuestos'],
    ['/metas/abc', '/metas'],
    ['/deudas/abc', '/deudas'],
    ['/perfil/eliminar', '/perfil'],
    ['/ajustes/general', '/ajustes'],
    ['/ajustes/monedas', '/ajustes'],
    ['/ajustes/registrar', '/ajustes'],
    ['/ajustes/inicio', '/ajustes'],
    ['/ajustes/recordatorios', '/ajustes'],
  ])('RF-M2-13 %s cuelga de %s en celular y en escritorio', (path, parent) => {
    expect(parentOf(path, MOBILE)).toBe(parent);
    expect(parentOf(path, DESKTOP)).toBe(parent);
  });
});

describe('parentOf: raíces de pestaña', () => {
  it.each(['/', '/movimientos', '/registrar', '/cuentas', '/mas'])(
    'RF-M2-13 %s no tiene Volver',
    (path) => {
      expect(parentOf(path, MOBILE)).toBeNull();
      expect(parentOf(path, DESKTOP)).toBeNull();
    },
  );
});

describe('parentOf: raíces de Más', () => {
  it.each(MORE_ROOTS)('RF-M2-13 %s cuelga de /mas por debajo de 1024 px', (path) => {
    expect(parentOf(path, MOBILE)).toBe('/mas');
  });

  it.each(MORE_ROOTS)('RF-M2-13 %s es raíz en la barra lateral (1024 px o más)', (path) => {
    expect(parentOf(path, DESKTOP)).toBeNull();
  });
});
