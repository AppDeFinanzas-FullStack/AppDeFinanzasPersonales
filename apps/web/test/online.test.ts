import { QueryClient, onlineManager } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createOnline, online } from '../src/lib/online';
import { createUiStore } from '../src/lib/ui-store';

// The test environment is node: it has no sessionStorage (used by `uiStore`)
// and no window (used by the `online` instance). Both are installed before the
// modules under test are evaluated.
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
  if (!('window' in globalThis)) {
    Object.defineProperty(globalThis, 'window', {
      value: new EventTarget(),
      configurable: true,
      writable: true,
    });
  }
  return { memoryStorage };
});

interface SaveResult {
  id: string;
  saved: boolean;
}

type Outcome = { ok: true; value: unknown } | { ok: false; error: unknown };

const MOVEMENT_ID = '0192f1a4-7b3c-7d2e-9f10-123456789abc';
const HEALTH_PATH = /\/api\/health(\?|$)/;

function healthResponse(status: number): Promise<Response> {
  return Promise.resolve(new Response(null, { status }));
}

function urlOf(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function methodOf(input: Parameters<typeof fetch>[0], init?: RequestInit): string {
  if (init?.method !== undefined) return init.method.toUpperCase();
  if (typeof input !== 'string' && !(input instanceof URL)) return input.method.toUpperCase();
  return 'GET';
}

function settle(promise: Promise<unknown>): Promise<Outcome> {
  return promise.then(
    (value): Outcome => ({ ok: true, value }),
    (error: unknown): Outcome => ({ ok: false, error }),
  );
}

function setup(options: { healthStatus?: number; withQueryClient?: boolean } = {}) {
  const { healthStatus = 503, withQueryClient = true } = options;
  const store = createUiStore({ storage: memoryStorage() });
  const events = new EventTarget();
  const fetchMock = vi.fn<typeof fetch>(() => healthResponse(healthStatus));
  const queryClient = new QueryClient();
  const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
  const controller = withQueryClient
    ? createOnline({ queryClient, store, fetch: fetchMock, events })
    : createOnline({ store, fetch: fetchMock, events });
  return { store, events, fetchMock, queryClient, invalidate, controller };
}

function healthCalls(fetchMock: ReturnType<typeof vi.fn<typeof fetch>>): number {
  return fetchMock.mock.calls.filter(([input]) => HEALTH_PATH.test(urlOf(input))).length;
}

let disposers: (() => void)[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  onlineManager.setOnline(true);
  disposers = [];
});

afterEach(() => {
  for (const dispose of disposers) dispose();
  vi.clearAllTimers();
  vi.useRealTimers();
  onlineManager.setOnline(true);
});

function track<T extends { controller: { dispose: () => void } }>(ctx: T): T {
  disposers.push(() => ctx.controller.dispose());
  return ctx;
}

describe('online: normal → sin conexión', () => {
  it('RF-M2-07 setOffline pausa TanStack Query y marca offline en el store', () => {
    const { store, controller } = track(setup());

    controller.setOffline();

    expect(onlineManager.isOnline()).toBe(false);
    expect(store.getState().offline).toBe(true);
  });

  it('RNF-23 sin conexión la app queda bloqueada mientras health no responde 204', async () => {
    const { store, controller, invalidate } = track(setup({ healthStatus: 503 }));

    controller.setOffline();
    await vi.advanceTimersByTimeAsync(30_000);

    expect(store.getState().offline).toBe(true);
    expect(onlineManager.isOnline()).toBe(false);
    expect(invalidate).not.toHaveBeenCalled();
  });

  it('RF-M2-07 mientras dura sin conexión consulta GET /api/health cada 5 s', async () => {
    const { controller, fetchMock } = track(setup({ healthStatus: 503 }));

    controller.setOffline();
    await vi.advanceTimersByTimeAsync(5_000);
    const afterFirstInterval = healthCalls(fetchMock);
    await vi.advanceTimersByTimeAsync(10_000);
    const afterThreeIntervals = healthCalls(fetchMock);

    expect(afterFirstInterval).toBeGreaterThanOrEqual(1);
    expect(afterFirstInterval).toBeLessThanOrEqual(2);
    expect(afterThreeIntervals).toBeGreaterThanOrEqual(3);
    expect(afterThreeIntervals).toBeLessThanOrEqual(4);
    for (const [input, init] of fetchMock.mock.calls) {
      expect(urlOf(input)).toMatch(HEALTH_PATH);
      expect(methodOf(input, init)).toBe('GET');
    }
  });

  it('RF-M2-07 sin llamar a setOffline no se consulta health', async () => {
    const { fetchMock } = track(setup());

    await vi.advanceTimersByTimeAsync(30_000);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('RF-M2-07 un error de red en health mantiene el bloqueo y sigue consultando', async () => {
    const ctx = track(setup());
    ctx.fetchMock.mockImplementation(() => Promise.reject(new TypeError('Failed to fetch')));

    ctx.controller.setOffline();
    await vi.advanceTimersByTimeAsync(15_000);

    expect(ctx.store.getState().offline).toBe(true);
    expect(healthCalls(ctx.fetchMock)).toBeGreaterThanOrEqual(3);
  });
});

describe('online: sin conexión → normal', () => {
  it('RF-M2-07 con temporizadores falsos, un 204 de health vuelve a online e invalida las consultas', async () => {
    const { store, controller, invalidate } = track(setup({ healthStatus: 204 }));

    controller.setOffline();
    expect(store.getState().offline).toBe(true);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(onlineManager.isOnline()).toBe(true);
    expect(store.getState().offline).toBe(false);
    expect(invalidate).toHaveBeenCalled();
  });

  it('RF-M2-07 health falla y luego responde 204: se libera solo al reconectar', async () => {
    const ctx = track(setup({ healthStatus: 503 }));

    ctx.controller.setOffline();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(ctx.store.getState().offline).toBe(true);
    expect(ctx.invalidate).not.toHaveBeenCalled();

    ctx.fetchMock.mockImplementation(() => healthResponse(204));
    await vi.advanceTimersByTimeAsync(5_000);

    expect(ctx.store.getState().offline).toBe(false);
    expect(onlineManager.isOnline()).toBe(true);
    expect(ctx.invalidate).toHaveBeenCalled();
  });

  it('RF-M2-07 el evento online reactiva todo e invalida las consultas', async () => {
    const { store, events, controller, invalidate } = track(setup({ healthStatus: 503 }));

    controller.setOffline();
    events.dispatchEvent(new Event('online'));
    await vi.advanceTimersByTimeAsync(0);

    expect(onlineManager.isOnline()).toBe(true);
    expect(store.getState().offline).toBe(false);
    expect(invalidate).toHaveBeenCalled();
  });

  it('RF-M2-07 al reconectar deja de consultar health', async () => {
    const { controller, fetchMock } = track(setup({ healthStatus: 204 }));

    controller.setOffline();
    await vi.advanceTimersByTimeAsync(5_000);
    const callsAtReconnect = healthCalls(fetchMock);
    await vi.advanceTimersByTimeAsync(30_000);

    expect(healthCalls(fetchMock)).toBe(callsAtReconnect);
  });

  it('RF-M2-07 sin QueryClient reconecta sin invalidar y attach(queryClient) habilita la invalidación', async () => {
    const ctx = track(setup({ healthStatus: 204, withQueryClient: false }));

    ctx.controller.setOffline();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(ctx.store.getState().offline).toBe(false);
    expect(onlineManager.isOnline()).toBe(true);
    expect(ctx.invalidate).not.toHaveBeenCalled();

    ctx.controller.attach(ctx.queryClient);
    ctx.controller.setOffline();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(ctx.store.getState().offline).toBe(false);
    expect(ctx.invalidate).toHaveBeenCalled();
  });

  it('RF-M2-07 healthIntervalMs cambia el intervalo de consulta', async () => {
    const store = createUiStore({ storage: memoryStorage() });
    const fetchMock = vi.fn<typeof fetch>(() => healthResponse(503));
    const controller = createOnline({
      store,
      fetch: fetchMock,
      events: new EventTarget(),
      healthIntervalMs: 1_000,
    });
    disposers.push(() => controller.dispose());

    controller.setOffline();
    await vi.advanceTimersByTimeAsync(3_000);

    expect(healthCalls(fetchMock)).toBeGreaterThanOrEqual(3);
  });

  it('TASK-041 dispose deja de consultar health y de escuchar el evento online', async () => {
    const { store, events, controller, fetchMock } = setup({ healthStatus: 503 });

    controller.setOffline();
    controller.dispose();
    const callsAtDispose = healthCalls(fetchMock);
    await vi.advanceTimersByTimeAsync(30_000);
    events.dispatchEvent(new Event('online'));
    await vi.advanceTimersByTimeAsync(0);

    expect(healthCalls(fetchMock)).toBe(callsAtDispose);
    expect(store.getState().offline).toBe(true);
  });
});

describe('online: mutación en vuelo', () => {
  it('EC-M2-02 la mutación en vuelo se reenvía una sola vez y con el mismo id', async () => {
    const ctx = track(setup({ healthStatus: 503 }));
    const sentIds: string[] = [];
    const send = vi.fn((): Promise<SaveResult> => {
      sentIds.push(MOVEMENT_ID);
      if (sentIds.length === 1) return new Promise<SaveResult>(() => undefined);
      return Promise.resolve({ id: MOVEMENT_ID, saved: true });
    });

    const result = settle(ctx.controller.trackInFlight(MOVEMENT_ID, send));
    await vi.advanceTimersByTimeAsync(0);
    ctx.controller.setOffline();
    await vi.advanceTimersByTimeAsync(10_000);
    const callsBeforeReconnect = send.mock.calls.length;

    ctx.fetchMock.mockImplementation(() => healthResponse(204));
    await vi.advanceTimersByTimeAsync(5_000);
    ctx.events.dispatchEvent(new Event('online'));
    await vi.advanceTimersByTimeAsync(30_000);

    expect(send.mock.calls.length - callsBeforeReconnect).toBe(1);
    expect(new Set(sentIds)).toEqual(new Set([MOVEMENT_ID]));
    await expect(result).resolves.toEqual({ ok: true, value: { id: MOVEMENT_ID, saved: true } });
  });

  it('EC-M2-02 un error de red a mitad del guardado bloquea y el reenvío resuelve la promesa', async () => {
    const ctx = track(setup({ healthStatus: 503 }));
    let attempts = 0;
    const send = vi.fn((): Promise<SaveResult> => {
      attempts += 1;
      if (attempts === 1) {
        return Promise.resolve().then((): SaveResult => {
          ctx.controller.setOffline();
          throw new TypeError('Failed to fetch');
        });
      }
      return Promise.resolve({ id: MOVEMENT_ID, saved: true });
    });

    const result = settle(ctx.controller.trackInFlight(MOVEMENT_ID, send));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(ctx.store.getState().offline).toBe(true);
    const callsBeforeReconnect = send.mock.calls.length;

    ctx.events.dispatchEvent(new Event('online'));
    await vi.advanceTimersByTimeAsync(30_000);

    expect(send.mock.calls.length - callsBeforeReconnect).toBe(1);
    await expect(result).resolves.toEqual({ ok: true, value: { id: MOVEMENT_ID, saved: true } });
  });

  it('EC-M2-02 si el reenvío falla, la promesa se rechaza con el error real', async () => {
    const ctx = track(setup({ healthStatus: 503 }));
    const realError = new Error('DUPLICATE_OR_VALIDATION');
    let attempts = 0;
    const send = vi.fn((): Promise<SaveResult> => {
      attempts += 1;
      if (attempts === 1) return new Promise<SaveResult>(() => undefined);
      return Promise.reject(realError);
    });

    const result = settle(ctx.controller.trackInFlight(MOVEMENT_ID, send));
    await vi.advanceTimersByTimeAsync(0);
    ctx.controller.setOffline();
    const callsBeforeReconnect = send.mock.calls.length;
    ctx.events.dispatchEvent(new Event('online'));
    await vi.advanceTimersByTimeAsync(30_000);

    expect(send.mock.calls.length - callsBeforeReconnect).toBe(1);
    await expect(result).resolves.toEqual({ ok: false, error: realError });
  });

  it('EC-M2-02 varias pérdidas de conexión seguidas no reenvían la mutación más de una vez', async () => {
    const ctx = track(setup({ healthStatus: 503 }));
    let attempts = 0;
    const send = vi.fn((): Promise<SaveResult> => {
      attempts += 1;
      if (attempts === 1) return new Promise<SaveResult>(() => undefined);
      return Promise.resolve({ id: MOVEMENT_ID, saved: true });
    });

    const result = settle(ctx.controller.trackInFlight(MOVEMENT_ID, send));
    await vi.advanceTimersByTimeAsync(0);
    ctx.controller.setOffline();
    ctx.controller.setOffline();
    const callsBeforeReconnect = send.mock.calls.length;
    ctx.events.dispatchEvent(new Event('online'));
    await vi.advanceTimersByTimeAsync(1_000);
    ctx.controller.setOffline();
    ctx.events.dispatchEvent(new Event('online'));
    await vi.advanceTimersByTimeAsync(30_000);

    expect(send.mock.calls.length - callsBeforeReconnect).toBe(1);
    await expect(result).resolves.toEqual({ ok: true, value: { id: MOVEMENT_ID, saved: true } });
  });

  it('EC-M2-02 una mutación que terminó antes de perder la conexión no se reenvía', async () => {
    const ctx = track(setup({ healthStatus: 204 }));
    const send = vi.fn(() => Promise.resolve({ id: MOVEMENT_ID, saved: true }));

    const result = await settle(ctx.controller.trackInFlight(MOVEMENT_ID, send));
    const callsAfterSave = send.mock.calls.length;
    ctx.controller.setOffline();
    await vi.advanceTimersByTimeAsync(5_000);
    ctx.events.dispatchEvent(new Event('online'));
    await vi.advanceTimersByTimeAsync(30_000);

    expect(result).toEqual({ ok: true, value: { id: MOVEMENT_ID, saved: true } });
    expect(send.mock.calls.length).toBe(callsAfterSave);
    expect(ctx.store.getState().offline).toBe(false);
  });

  it('EC-M2-02 sin pérdida de conexión, trackInFlight resuelve con el resultado del envío', async () => {
    const ctx = track(setup());
    const send = vi.fn(() => Promise.resolve({ id: MOVEMENT_ID, saved: true }));

    const result = await settle(ctx.controller.trackInFlight(MOVEMENT_ID, send));

    expect(result).toEqual({ ok: true, value: { id: MOVEMENT_ID, saved: true } });
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe('online (instancia)', () => {
  it('TASK-041 online expone setOffline, trackInFlight, dispose y attach', () => {
    expect(typeof online.setOffline).toBe('function');
    expect(typeof online.trackInFlight).toBe('function');
    expect(typeof online.dispose).toBe('function');
    expect(typeof online.attach).toBe('function');
  });
});
