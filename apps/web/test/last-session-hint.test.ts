import { QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { warmUpSession } from '../src/app/guards';
import { DASHBOARD_KEY } from '../src/features/dashboard/hooks/use-dashboard';
import {
  clearLastSessionHint,
  readLastSessionHint,
  saveLastSessionHint,
} from '../src/lib/last-session-hint';

// The test environment is node: it has no sessionStorage (used by `uiStore`), no window (used by
// the `online` instance) and no localStorage (used by the hint). They are installed before the
// modules under test are evaluated. The global fetch is replaced by a delegate so every test
// controls the network and can see, in order, what the app asks for.
const { fetchState, installStorage } = vi.hoisted(() => {
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
  // `window.localStorage` and the bare `localStorage` must be the same object, as in a browser.
  Object.defineProperty(globalThis.window, 'localStorage', {
    get: () => (globalThis as { localStorage?: Storage }).localStorage,
    configurable: true,
  });

  function installStorage(storage: Storage | (() => never)): void {
    Object.defineProperty(globalThis, 'localStorage', {
      ...(typeof storage === 'function'
        ? {
            get: storage,
          }
        : { value: storage, writable: true }),
      configurable: true,
    });
  }

  const fetchState: { impl: typeof fetch } = {
    impl: () => Promise.reject(new Error('fetch not configured for this test')),
  };
  Object.defineProperty(globalThis, 'fetch', {
    value: (input: Parameters<typeof fetch>[0], init?: RequestInit) => fetchState.impl(input, init),
    configurable: true,
    writable: true,
  });
  return { fetchState, installStorage };
});

function memoryStorage(): Storage & { entries: () => [string, string][] } {
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
    entries: () => [...items.entries()],
  };
}

const LA_PAZ = 'America/La_Paz';
const AUCKLAND = 'Pacific/Auckland';

// 2026-03-01 02:00 UTC is still February 28 in La Paz (UTC-4) and already March 1 in Auckland.
const BOUNDARY = new Date('2026-03-01T02:00:00.000Z');
const MONTH_LA_PAZ = '2026-02';
const MONTH_AUCKLAND = '2026-03';

const ME = {
  id: '0192f1a4-7b3c-7d2e-9f10-123456789abc',
  name: 'Ana Quispe Mamani',
  email: 'ana.quispe@ejemplo.com',
  timezone: LA_PAZ,
  locale: 'es-BO',
  release: '1.2',
  onboarding: { step: 4, completed: true },
} as const;

const ZERO = '0.00';

function dashboardBody(month: string): unknown {
  return {
    range: { firstMonth: month, currentMonth: month },
    cards: {
      income: ZERO,
      expense: ZERO,
      balance: ZERO,
      savingsRatePct: null,
      variations: { income: null, expense: null, balance: null, savingsRatePp: null },
    },
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function sessionExpired(): Response {
  return new Response(
    JSON.stringify({
      type: 'https://errors.app/SESSION_EXPIRED',
      title: 'SESSION_EXPIRED',
      status: 401,
      code: 'SESSION_EXPIRED',
      traceId: 'trace-1',
    }),
    { status: 401, headers: { 'content-type': 'application/problem+json' } },
  );
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function urlOf(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

/** What the app asked for and answered, in order: `request:/api/me`, `answer:/api/me`... */
interface Network {
  events: string[];
  /** The paths with their query that were requested, in order. */
  requested: () => string[];
  /** Holds `/api/me` until `releaseMe` is called with its answer. */
  releaseMe: (response: Response) => void;
}

function installNetwork(): Network {
  const events: string[] = [];
  const me = deferred<Response>();
  fetchState.impl = async (input) => {
    const url = urlOf(input);
    events.push(`request:${url}`);
    if (url === '/api/me') {
      const response = await me.promise;
      events.push(`answer:${url}`);
      return response;
    }
    if (url.startsWith('/api/dashboard?month=')) {
      return json(dashboardBody(url.slice(url.indexOf('=') + 1)));
    }
    return json({}, 404);
  };
  return {
    events,
    requested: () => events.filter((e) => e.startsWith('request:')).map((e) => e.slice(8)),
    releaseMe: me.resolve,
  };
}

/** Lets the pending promise callbacks run, so a request that is about to be sent is visible. */
async function flush(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
  await new Promise<void>((done) => {
    setTimeout(done, 0);
  });
}

const indexOfEvent = (events: string[], event: string): number => events.indexOf(event);

let storage: ReturnType<typeof memoryStorage>;
let queryClient: QueryClient;

beforeEach(() => {
  storage = memoryStorage();
  installStorage(storage);
  queryClient = new QueryClient();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(BOUNDARY);
});

afterEach(() => {
  vi.useRealTimers();
  queryClient.clear();
  fetchState.impl = () => Promise.reject(new Error('fetch not configured for this test'));
});

describe('TASK-258 pista de la última sesión', () => {
  it('RNF-03 guarda y lee la zona horaria y si el Onboarding terminó', () => {
    saveLastSessionHint(ME);

    expect(readLastSessionHint()).toEqual({ timezone: LA_PAZ, onboardingCompleted: true });
  });

  it('RNF-03 la pista guarda el estado del Onboarding sin terminar', () => {
    saveLastSessionHint({ ...ME, onboarding: { step: 2, completed: false } });

    expect(readLastSessionHint()).toEqual({ timezone: LA_PAZ, onboardingCompleted: false });
  });

  it('RNF-03 sin pista guardada la lectura es nula', () => {
    expect(readLastSessionHint()).toBeNull();
  });

  it('RNF-03 una pista con otro formato o JSON roto se ignora', () => {
    for (const raw of [
      '{not json',
      'null',
      '"texto"',
      '[]',
      '{}',
      JSON.stringify({ timezone: 42, onboardingCompleted: true }),
      JSON.stringify({ timezone: LA_PAZ, onboardingCompleted: 'si' }),
      JSON.stringify({ timezone: LA_PAZ }),
    ]) {
      storage.clear();
      saveLastSessionHint(ME);
      const [first] = storage.entries();
      storage.setItem(first?.[0] ?? '', raw);

      expect(readLastSessionHint(), raw).toBeNull();
    }
  });

  it('RNF-03 borrar la pista deja la lectura en nulo', () => {
    saveLastSessionHint(ME);
    clearLastSessionHint();

    expect(readLastSessionHint()).toBeNull();
    expect(storage.length).toBe(0);
  });

  it('RF-M1-04 la pista no contiene el correo, el nombre ni el id', () => {
    saveLastSessionHint(ME);

    const stored = storage.entries();
    expect(stored).toHaveLength(1);
    const value = stored[0]?.[1] ?? '';
    expect(JSON.parse(value)).toEqual({ timezone: LA_PAZ, onboardingCompleted: true });
    for (const secret of [ME.email, ME.name, ME.id, 'Quispe', 'ejemplo.com']) {
      expect(value).not.toContain(secret);
    }
  });

  it('RF-M1-04 guardar una pista nueva reemplaza a la anterior', () => {
    saveLastSessionHint(ME);
    saveLastSessionHint({ ...ME, timezone: AUCKLAND });

    expect(storage.entries()).toHaveLength(1);
    expect(readLastSessionHint()).toEqual({ timezone: AUCKLAND, onboardingCompleted: true });
  });

  it('RF-M1-04 con localStorage bloqueado, leer, guardar y borrar no rompen la app', () => {
    const blocked: Storage = {
      length: 0,
      clear() {
        throw new DOMException('denied', 'SecurityError');
      },
      getItem() {
        throw new DOMException('denied', 'SecurityError');
      },
      key() {
        throw new DOMException('denied', 'SecurityError');
      },
      removeItem() {
        throw new DOMException('denied', 'SecurityError');
      },
      setItem() {
        throw new DOMException('quota', 'QuotaExceededError');
      },
    };
    installStorage(blocked);

    expect(() => {
      saveLastSessionHint(ME);
    }).not.toThrow();
    expect(readLastSessionHint()).toBeNull();
    expect(() => {
      clearLastSessionHint();
    }).not.toThrow();
  });

  it('RF-M1-04 si el navegador ni siquiera deja tocar localStorage, nada se rompe', () => {
    installStorage(() => {
      throw new DOMException('denied', 'SecurityError');
    });

    expect(() => {
      saveLastSessionHint(ME);
    }).not.toThrow();
    expect(readLastSessionHint()).toBeNull();
    expect(() => {
      clearLastSessionHint();
    }).not.toThrow();
  });
});

describe('TASK-258 warmUpSession pide los datos a la vez que la sesión', () => {
  it('RNF-03 con pista, el Inicio y las cuentas se piden antes de que /api/me responda', async () => {
    saveLastSessionHint({ ...ME, timezone: LA_PAZ });
    const network = installNetwork();

    warmUpSession(queryClient);
    await flush();

    // /api/me is still pending: nothing has answered it.
    expect(network.events).not.toContain('answer:/api/me');
    expect(network.requested()).toContain('/api/me');
    expect(network.requested()).toContain(`/api/dashboard?month=${MONTH_LA_PAZ}`);
    expect(network.requested()).toContain('/api/accounts?status=active');

    network.releaseMe(json(ME));
    await vi.waitFor(() => {
      expect(network.events).toContain('answer:/api/me');
    });
    const dashboardAt = indexOfEvent(
      network.events,
      `request:/api/dashboard?month=${MONTH_LA_PAZ}`,
    );
    expect(dashboardAt).toBeGreaterThanOrEqual(0);
    expect(dashboardAt).toBeLessThan(indexOfEvent(network.events, 'answer:/api/me'));
  });

  it('RNF-03 con pista de la misma zona no repite la petición del Inicio', async () => {
    saveLastSessionHint({ ...ME, timezone: LA_PAZ });
    const network = installNetwork();

    warmUpSession(queryClient);
    await flush();
    network.releaseMe(json(ME));
    await vi.waitFor(() => {
      expect(queryClient.getQueryData([...DASHBOARD_KEY, MONTH_LA_PAZ])).toBeDefined();
    });
    await flush();

    const dashboards = network.requested().filter((url) => url.startsWith('/api/dashboard'));
    expect(dashboards).toEqual([`/api/dashboard?month=${MONTH_LA_PAZ}`]);
  });

  it('RNF-03 con una pista de otra zona, repite el Inicio con el mes de la zona real', async () => {
    saveLastSessionHint({ ...ME, timezone: AUCKLAND });
    const network = installNetwork();

    warmUpSession(queryClient);
    await flush();
    // Before the session answers, the guess of the hint is used.
    expect(network.requested()).toContain(`/api/dashboard?month=${MONTH_AUCKLAND}`);
    expect(network.requested()).not.toContain(`/api/dashboard?month=${MONTH_LA_PAZ}`);

    network.releaseMe(json({ ...ME, timezone: LA_PAZ }));
    await vi.waitFor(() => {
      expect(queryClient.getQueryData([...DASHBOARD_KEY, MONTH_LA_PAZ])).toBeDefined();
    });

    expect(queryClient.getQueryData([...DASHBOARD_KEY, MONTH_LA_PAZ])).toMatchObject({
      range: { currentMonth: MONTH_LA_PAZ },
    });
    const dashboards = network.requested().filter((url) => url.startsWith('/api/dashboard'));
    expect(dashboards).toEqual([
      `/api/dashboard?month=${MONTH_AUCKLAND}`,
      `/api/dashboard?month=${MONTH_LA_PAZ}`,
    ]);
  });

  it('RNF-03 con pista de Onboarding sin terminar no adelanta ningún dato', async () => {
    saveLastSessionHint({ ...ME, onboarding: { step: 2, completed: false } });
    const network = installNetwork();

    warmUpSession(queryClient);
    await flush();

    expect(network.requested()).toEqual(['/api/me']);
  });

  it('RF-M1-04 sin pista (primer ingreso) solo se pide /api/me hasta que responde', async () => {
    const network = installNetwork();

    warmUpSession(queryClient);
    await flush();

    expect(network.requested()).toEqual(['/api/me']);

    network.releaseMe(json(ME));
    await vi.waitFor(() => {
      expect(network.requested()).toContain(`/api/dashboard?month=${MONTH_LA_PAZ}`);
    });
    expect(network.requested()).toContain('/api/accounts?status=active');
  });

  it('RNF-03 un /api/me exitoso guarda la pista, sin correo, nombre ni id', async () => {
    const network = installNetwork();

    warmUpSession(queryClient);
    network.releaseMe(json({ ...ME, timezone: AUCKLAND }));

    await vi.waitFor(() => {
      expect(readLastSessionHint()).toEqual({ timezone: AUCKLAND, onboardingCompleted: true });
    });
    const value = storage.entries()[0]?.[1] ?? '';
    for (const secret of [ME.email, ME.name, ME.id]) expect(value).not.toContain(secret);
  });

  it('RF-M1-04 un 401 de /api/me borra la pista guardada', async () => {
    saveLastSessionHint(ME);
    const network = installNetwork();

    warmUpSession(queryClient);
    await flush();
    network.releaseMe(sessionExpired());

    await vi.waitFor(() => {
      expect(readLastSessionHint()).toBeNull();
    });
    expect(storage.length).toBe(0);
  });

  it('RF-M1-04 un fallo del servidor en /api/me no borra la pista', async () => {
    saveLastSessionHint(ME);
    const network = installNetwork();

    warmUpSession(queryClient);
    await flush();
    network.releaseMe(json({}, 500));
    await vi.waitFor(() => {
      expect(network.events).toContain('answer:/api/me');
    });
    await flush();

    expect(readLastSessionHint()).toEqual({ timezone: LA_PAZ, onboardingCompleted: true });
  });

  it('RF-M1-04 con localStorage bloqueado, el arranque sigue el flujo de siempre', async () => {
    installStorage(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    const network = installNetwork();

    warmUpSession(queryClient);
    await flush();
    expect(network.requested()).toEqual(['/api/me']);

    network.releaseMe(json(ME));
    await vi.waitFor(() => {
      expect(network.requested()).toContain(`/api/dashboard?month=${MONTH_LA_PAZ}`);
    });
  });
});
