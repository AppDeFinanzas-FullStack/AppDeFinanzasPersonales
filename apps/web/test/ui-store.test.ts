import type { ModuleKey } from '@finanzas/contracts';
import { describe, expect, it, vi } from 'vitest';

import { createUiStore, rootFor, uiStore, useUiStore } from '../src/lib/ui-store';

// The test environment is node, which has no sessionStorage. `uiStore` is the
// instance over sessionStorage, so an in-memory one is installed before the
// module under test is evaluated.
const { memoryStorage } = vi.hoisted(() => {
  function memoryStorage(): Storage {
    const items = new Map<string, string>();
    return {
      get length() {
        return items.size;
      },
      clear() {
        items.clear();
      },
      getItem(key: string) {
        return items.get(key) ?? null;
      },
      key(index: number) {
        return [...items.keys()][index] ?? null;
      },
      removeItem(key: string) {
        items.delete(key);
      },
      setItem(key: string, value: string) {
        items.set(key, value);
      },
    };
  }
  if (!('sessionStorage' in globalThis)) {
    Object.defineProperty(globalThis, 'sessionStorage', {
      value: memoryStorage(),
      configurable: true,
      writable: true,
    });
  }
  return { memoryStorage };
});

describe('ui-store tabMemory', () => {
  it('RF-M2-04 tabMemory sobrevive a recrear el store sobre el mismo storage', () => {
    const storage = memoryStorage();
    const first = createUiStore({ storage });
    first.setTabMemory('M6', { url: '/movimientos?mes=2026-10', scrollY: 420 });
    first.setTabMemory('M4', { url: '/cuentas/abc', scrollY: 0 });

    const second = createUiStore({ storage });

    expect(second.getState().tabMemory.M6).toEqual({ url: '/movimientos?mes=2026-10', scrollY: 420 });
    expect(second.getState().tabMemory.M4).toEqual({ url: '/cuentas/abc', scrollY: 0 });
  });

  it('RF-M2-04 setTabMemory guarda el estado del módulo y reemplaza el anterior', () => {
    const store = createUiStore({ storage: memoryStorage() });
    store.setTabMemory('M6', { url: '/movimientos', scrollY: 10 });
    store.setTabMemory('M6', { url: '/movimientos/123', scrollY: 250 });

    expect(store.getState().tabMemory.M6).toEqual({ url: '/movimientos/123', scrollY: 250 });
    expect(store.getState().tabMemory.M4).toBeUndefined();
  });

  it('RF-M2-04 el estado vive en el storage del dispositivo: otro storage no lo ve', () => {
    const storage = memoryStorage();
    createUiStore({ storage }).setTabMemory('M5', { url: '/categorias', scrollY: 80 });

    const elsewhere = createUiStore({ storage: memoryStorage() });

    expect(elsewhere.getState().tabMemory.M5).toBeUndefined();
  });

  it('RF-M2-04 la memoria persistida se recupera aunque cambie el último módulo guardado', () => {
    const storage = memoryStorage();
    const first = createUiStore({ storage });
    first.setTabMemory('M7', { url: '/registrar', scrollY: 0 });
    const second = createUiStore({ storage });
    second.setTabMemory('M12', { url: '/metas/9', scrollY: 33 });

    const third = createUiStore({ storage });

    expect(third.getState().tabMemory.M7).toEqual({ url: '/registrar', scrollY: 0 });
    expect(third.getState().tabMemory.M12).toEqual({ url: '/metas/9', scrollY: 33 });
  });
});

describe('rootFor', () => {
  const roots: [ModuleKey, string][] = [
    ['M8', '/'],
    ['M6', '/movimientos'],
    ['M7', '/registrar'],
    ['M4', '/cuentas'],
    ['M5', '/categorias'],
    ['M3', '/tipo-de-cambio'],
    ['M11', '/presupuestos'],
    ['M12', '/metas'],
    ['M13', '/deudas'],
    ['M14', '/recurrentes'],
    ['M1', '/'],
    ['M2', '/'],
    ['M9', '/'],
    ['M10', '/'],
    ['M15', '/'],
  ];

  it.each(roots)('RF-M2-05 rootFor(%s) devuelve la raíz del módulo %s', (moduleKey, root) => {
    expect(rootFor(moduleKey)).toBe(root);
  });

  it('RF-M2-05 rootFor devuelve la raíz aunque tabMemory guarde una ruta de detalle', () => {
    const store = createUiStore({ storage: memoryStorage() });
    store.setTabMemory('M6', { url: '/movimientos/123', scrollY: 300 });

    expect(rootFor('M6')).toBe('/movimientos');
    expect(store.getState().tabMemory.M6).toEqual({ url: '/movimientos/123', scrollY: 300 });
  });
});

describe('ui-store estados de la interfaz', () => {
  it('TASK-040 setOffline cambia offline', () => {
    const store = createUiStore({ storage: memoryStorage() });
    store.setOffline(true);
    expect(store.getState().offline).toBe(true);
    store.setOffline(false);
    expect(store.getState().offline).toBe(false);
  });

  it('TASK-040 openSessionExpired y closeSessionExpired cambian sessionExpired', () => {
    const store = createUiStore({ storage: memoryStorage() });
    store.openSessionExpired();
    expect(store.getState().sessionExpired).toBe(true);
    store.closeSessionExpired();
    expect(store.getState().sessionExpired).toBe(false);
  });

  it('TASK-040 showUndo guarda { token, label, expiresAt } y clearUndo lo quita', () => {
    const store = createUiStore({ storage: memoryStorage() });
    const undo = { token: 'tok-1', label: 'Movimiento eliminado', expiresAt: 1_800_000_000_000 };
    store.showUndo(undo);
    expect(store.getState().undo).toEqual(undo);
    store.clearUndo();
    expect(store.getState().undo ?? null).toBeNull();
  });

  it('TASK-040 subscribe avisa de cada cambio y deja de avisar tras desuscribirse', () => {
    const store = createUiStore({ storage: memoryStorage() });
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);

    store.setOffline(true);
    expect(listener).toHaveBeenCalledTimes(1);
    store.setTabMemory('M8', { url: '/', scrollY: 5 });
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    store.openSessionExpired();
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('TASK-040 getState devuelve la misma instantánea sin cambios y una nueva tras un cambio', () => {
    const store = createUiStore({ storage: memoryStorage() });
    const before = store.getState();
    expect(store.getState()).toBe(before);

    store.setOffline(true);
    const after = store.getState();
    expect(after).not.toBe(before);
    expect(before.offline).not.toBe(true);
    expect(store.getState()).toBe(after);
  });

  it('TASK-040 uiStore es una instancia sobre sessionStorage y useUiStore es un hook', () => {
    sessionStorage.clear();
    uiStore.setTabMemory('M13', { url: '/deudas/7', scrollY: 12 });

    const recreated = createUiStore({ storage: sessionStorage });

    expect(recreated.getState().tabMemory.M13).toEqual({ url: '/deudas/7', scrollY: 12 });
    expect(typeof useUiStore).toBe('function');
  });
});
