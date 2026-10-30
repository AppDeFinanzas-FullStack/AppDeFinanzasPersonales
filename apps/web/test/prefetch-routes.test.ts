import type { MeDto } from '@finanzas/contracts';
import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { prefetchRoute } from '../src/app/prefetch-routes';
import { accountsQuery } from '../src/features/accounts/hooks/use-accounts';
import { budgetsQuery } from '../src/features/budgets/hooks/use-budgets';
import { categoriesQuery } from '../src/features/categories/hooks/use-categories';
import { debtsQuery } from '../src/features/debts/hooks/use-debts';
import { goalsQuery } from '../src/features/goals/hooks/use-goals';
import { recurringQuery } from '../src/features/recurring/hooks/use-recurring';
import { transactionsQuery } from '../src/features/transactions/hooks/use-transactions';
import { uiStore } from '../src/lib/ui-store';

// The test environment is node: it has no sessionStorage (used by `uiStore`) and no window (used by
// the `online` instance). They are installed before the modules under test are evaluated. The
// global fetch is replaced by a delegate so every test controls the network and sees, in order,
// what the app asks for.
const { fetchState } = vi.hoisted(() => {
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
  if (!('localStorage' in globalThis)) {
    Object.defineProperty(globalThis, 'localStorage', {
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
  const fetchState: { impl: typeof fetch } = {
    impl: () => Promise.reject(new Error('fetch not configured for this test')),
  };
  Object.defineProperty(globalThis, 'fetch', {
    value: (input: Parameters<typeof fetch>[0], init?: RequestInit) => fetchState.impl(input, init),
    configurable: true,
    writable: true,
  });
  return { fetchState };
});

const LA_PAZ = 'America/La_Paz';
const AUCKLAND = 'Pacific/Auckland';
const TEN_SECONDS = 10_000;

/** A mid-month instant: the month is the same in La Paz and in Auckland. */
const MID_MONTH = new Date('2026-03-15T12:00:00.000Z');
/** 02:00 UTC on March 1st is still February in La Paz (UTC-4) and already March in Auckland. */
const BOUNDARY = new Date('2026-03-01T02:00:00.000Z');

type Release = MeDto['release'];

function meWith(release: Release, timezone = LA_PAZ): MeDto {
  return {
    id: '0192f1a4-7b3c-7d2e-9f10-123456789abc',
    name: 'Ana Quispe Mamani',
    email: 'ana.quispe@ejemplo.com',
    timezone,
    locale: 'es-BO',
    release,
    onboarding: { step: 4, completed: true },
  };
}

const ACCOUNTS_BODY = {
  items: [],
  summary: {
    netWorth: { base: null, other: null },
    breakdown: { liquid: null, savings: null, cardDebt: null, earmarked: null },
  },
};

/** The smallest valid answer of each main query, by path. */
const BODIES: Record<string, unknown> = {
  '/api/accounts': ACCOUNTS_BODY,
  '/api/budgets': { items: [] },
  '/api/goals': { items: [] },
  '/api/debts': { debts: [], summary: { iOwe: '0.00', owedToMe: '0.00' } },
  '/api/recurring': {},
  '/api/categories': [],
  '/api/transactions': { items: [], nextCursor: null, dayNets: [] },
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function serverError(): Response {
  return new Response(
    JSON.stringify({
      type: 'https://errors.app/INTERNAL_ERROR',
      title: 'INTERNAL_ERROR',
      status: 500,
      code: 'INTERNAL_ERROR',
      traceId: 'trace-1',
    }),
    { status: 500, headers: { 'content-type': 'application/problem+json' } },
  );
}

function urlOf(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

/** The path and the query with its parameters sorted, so the order of the parameters is free. */
function normalize(url: string): string {
  const parsed = new URL(url, 'http://app.test');
  const params = [...parsed.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b));
  const query = new URLSearchParams(params).toString();
  return query === '' ? parsed.pathname : `${parsed.pathname}?${query}`;
}

const pathOf = (url: string): string => new URL(url, 'http://app.test').pathname;

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

interface Network {
  /** Every URL asked for, in order, as the app wrote it. */
  requests: string[];
  /** The requests with path and sorted query, in order. */
  requested: () => string[];
  /** How many requests went to `path`. */
  countTo: (path: string) => number;
}

/**
 * Answers every main query with its smallest valid body. `answer` can replace the response of a
 * request (a failure, or a response held until the test lets it go).
 */
function installNetwork(
  answer?: (url: string, nth: number) => Promise<Response> | Response | null,
): Network {
  const requests: string[] = [];
  fetchState.impl = async (input) => {
    const url = urlOf(input);
    requests.push(url);
    const nth = requests.filter((other) => pathOf(other) === pathOf(url)).length;
    const custom = answer?.(url, nth) ?? null;
    if (custom !== null) return custom;
    const body = BODIES[pathOf(url)];
    return body === undefined ? json({}, 404) : json(body);
  };
  return {
    requests,
    requested: () => requests.map(normalize),
    countTo: (path) => requests.filter((url) => pathOf(url) === path).length,
  };
}

/** Lets the pending promise callbacks run, so a request that is about to be sent is visible. */
async function flush(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
  await new Promise<void>((done) => {
    setTimeout(done, 0);
  });
}

let queryClient: QueryClient;

function signIn(release: Release, timezone = LA_PAZ): void {
  queryClient.setQueryData(['me'], meWith(release, timezone));
}

beforeEach(() => {
  queryClient = new QueryClient();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(MID_MONTH);
});

afterEach(() => {
  vi.useRealTimers();
  queryClient.clear();
  fetchState.impl = () => Promise.reject(new Error('fetch not configured for this test'));
});

interface RouteCase {
  path: string;
  /** The request of its main query, with the month of MID_MONTH in La Paz. */
  request: string;
  /** The cache key the screen reads the same data from. */
  key: readonly unknown[];
  /** The kind of cache entry: the list of the movements is an infinite query. */
  infinite?: boolean;
}

const ROUTES: RouteCase[] = [
  {
    path: '/movimientos',
    request: '/api/transactions?limit=50&month=2026-03',
    key: ['transactions', 'list', { month: '2026-03' }],
    infinite: true,
  },
  { path: '/cuentas', request: '/api/accounts?status=active', key: ['accounts', 'active'] },
  { path: '/presupuestos', request: '/api/budgets', key: ['budgets'] },
  { path: '/metas', request: '/api/goals', key: ['goals'] },
  { path: '/deudas', request: '/api/debts?view=debt', key: ['debts', 'debt'] },
  { path: '/recurrentes', request: '/api/recurring', key: ['recurring'] },
  {
    path: '/categorias',
    request: '/api/categories?kind=expense&status=active',
    key: ['categories', 'expense', 'active'],
  },
];

const GATED = ['/presupuestos', '/metas', '/deudas', '/recurrentes'] as const;

describe('TASK-259 las fábricas de consulta de cada lista', () => {
  it('RNF-29 cada fábrica usa la misma clave que la pantalla', () => {
    expect(accountsQuery('active').queryKey).toEqual(['accounts', 'active']);
    expect(accountsQuery('archived').queryKey).toEqual(['accounts', 'archived']);
    expect(budgetsQuery().queryKey).toEqual(['budgets']);
    expect(goalsQuery().queryKey).toEqual(['goals']);
    expect(debtsQuery('debt').queryKey).toEqual(['debts', 'debt']);
    expect(debtsQuery('person').queryKey).toEqual(['debts', 'person']);
    expect(recurringQuery().queryKey).toEqual(['recurring']);
    expect(categoriesQuery({ kind: 'expense', status: 'active' }).queryKey).toEqual([
      'categories',
      'expense',
      'active',
    ]);
    expect(categoriesQuery({ kind: 'income', status: 'archived' }).queryKey).toEqual([
      'categories',
      'income',
      'archived',
    ]);
    expect(transactionsQuery({ month: '2026-03' }).queryKey).toEqual([
      'transactions',
      'list',
      { month: '2026-03' },
    ]);
  });

  it('RNF-29 cada fábrica pide al API lo mismo que la pantalla', async () => {
    const network = installNetwork();

    await queryClient.fetchQuery(accountsQuery('archived'));
    await queryClient.fetchQuery(budgetsQuery());
    await queryClient.fetchQuery(goalsQuery());
    await queryClient.fetchQuery(debtsQuery('person'));
    await queryClient.fetchQuery(recurringQuery());
    await queryClient.fetchQuery(categoriesQuery({ kind: 'income', status: 'archived' }));
    await queryClient.fetchInfiniteQuery(transactionsQuery({ month: '2026-03', kind: 'expense' }));

    expect(network.requested()).toEqual([
      '/api/accounts?status=archived',
      '/api/budgets',
      '/api/goals',
      '/api/debts?view=person',
      '/api/recurring',
      '/api/categories?kind=income&status=archived',
      '/api/transactions?kind=expense&limit=50&month=2026-03',
    ]);
  });
});

describe('TASK-259 prefetchRoute pide la consulta principal de cada ruta', () => {
  it.each(ROUTES)(
    'RNF-29 $path pide sus datos y los deja en la clave que lee la pantalla',
    async ({ path, request, key, infinite }) => {
      signIn('1.2');
      const network = installNetwork();

      prefetchRoute(queryClient, path);

      await vi.waitFor(() => {
        expect(queryClient.getQueryState(key)?.status).toBe('success');
      });
      expect(network.requested()).toEqual([request]);
      const data = queryClient.getQueryData(key);
      if (infinite === true) expect(data).toHaveProperty('pages');
    },
  );

  it('RNF-29 Movimientos pide el mes actual en la zona horaria del usuario', async () => {
    vi.setSystemTime(BOUNDARY);
    signIn('1.2', AUCKLAND);
    const network = installNetwork();

    prefetchRoute(queryClient, '/movimientos');

    await vi.waitFor(() => {
      expect(network.requested()).toEqual(['/api/transactions?limit=50&month=2026-03']);
    });
    expect(queryClient.getQueryState(['transactions', 'list', { month: '2026-03' }])).toBeDefined();
  });

  it('RNF-29 Movimientos usa el mes de La Paz cuando allá todavía es el mes anterior', async () => {
    vi.setSystemTime(BOUNDARY);
    signIn('1.2', LA_PAZ);
    const network = installNetwork();

    prefetchRoute(queryClient, '/movimientos');

    await vi.waitFor(() => {
      expect(network.requested()).toEqual(['/api/transactions?limit=50&month=2026-02']);
    });
  });

  it('RNF-29 la petición sale de inmediato, sin esperar la respuesta ni bloquear', async () => {
    signIn('1.2');
    const held = deferred<Response>();
    const network = installNetwork(() => held.promise);

    prefetchRoute(queryClient, '/cuentas');
    prefetchRoute(queryClient, '/metas');
    await flush();

    // Both requests are out while neither answer has arrived.
    expect(network.requested()).toEqual(['/api/accounts?status=active', '/api/goals']);
    expect(queryClient.getQueryState(['accounts', 'active'])?.fetchStatus).toBe('fetching');

    held.resolve(json(ACCOUNTS_BODY));
    await vi.waitFor(() => {
      expect(queryClient.getQueryState(['accounts', 'active'])?.fetchStatus).toBe('idle');
    });
  });

  it('RNF-29 lanzar el prefetch mientras la petición sigue en curso no la duplica', async () => {
    signIn('1.2');
    const held = deferred<Response>();
    const network = installNetwork(() => held.promise);

    prefetchRoute(queryClient, '/cuentas');
    prefetchRoute(queryClient, '/cuentas');
    prefetchRoute(queryClient, '/cuentas');
    await flush();

    expect(network.countTo('/api/accounts')).toBe(1);
    held.resolve(json(ACCOUNTS_BODY));
    await vi.waitFor(() => {
      expect(queryClient.getQueryState(['accounts', 'active'])?.status).toBe('success');
    });
  });

  it('RNF-29 con datos de menos de 10 s no repite la petición y pasados 10 s sí', async () => {
    signIn('1.2');
    const network = installNetwork();
    const start = Date.now();

    prefetchRoute(queryClient, '/cuentas');
    await vi.waitFor(() => {
      expect(queryClient.getQueryState(['accounts', 'active'])?.status).toBe('success');
    });
    expect(network.countTo('/api/accounts')).toBe(1);

    vi.setSystemTime(start + TEN_SECONDS / 2);
    prefetchRoute(queryClient, '/cuentas');
    await flush();
    expect(network.countTo('/api/accounts')).toBe(1);

    vi.setSystemTime(start + TEN_SECONDS + 1_000);
    prefetchRoute(queryClient, '/cuentas');
    await vi.waitFor(() => {
      expect(network.countTo('/api/accounts')).toBe(2);
    });
  });

  it('RNF-29 la lista de Movimientos también espera 10 s antes de volver a pedirse', async () => {
    signIn('1.2');
    const network = installNetwork();
    const start = Date.now();

    prefetchRoute(queryClient, '/movimientos');
    await vi.waitFor(() => {
      expect(network.countTo('/api/transactions')).toBe(1);
    });
    await flush();

    vi.setSystemTime(start + TEN_SECONDS / 2);
    prefetchRoute(queryClient, '/movimientos');
    await flush();
    expect(network.countTo('/api/transactions')).toBe(1);

    vi.setSystemTime(start + TEN_SECONDS + 1_000);
    prefetchRoute(queryClient, '/movimientos');
    await vi.waitFor(() => {
      expect(network.countTo('/api/transactions')).toBe(2);
    });
  });

  it('RNF-29 las rutas sin consulta principal no piden nada', async () => {
    signIn('1.2');
    const network = installNetwork();

    for (const path of [
      '/',
      '/mas',
      '/registrar',
      '/perfil',
      '/ajustes',
      '/tipo-de-cambio',
      '/x',
    ]) {
      prefetchRoute(queryClient, path);
    }
    await flush();

    expect(network.requests).toEqual([]);
  });
});

describe('TASK-259 prefetchRoute solo pide lo que la entrega del usuario incluye', () => {
  it.each(GATED)('RF-M2-03 con 1.0 %s no dispara ninguna petición', async (path) => {
    signIn('1.0');
    const network = installNetwork();

    prefetchRoute(queryClient, path);
    await flush();

    expect(network.requests).toEqual([]);
  });

  it('RF-M2-03 con 1.0 Movimientos, Cuentas y Categorías sí piden sus datos', async () => {
    signIn('1.0');
    const network = installNetwork();

    for (const path of ['/movimientos', '/cuentas', '/categorias'])
      prefetchRoute(queryClient, path);

    await vi.waitFor(() => {
      expect(network.requested().sort()).toEqual([
        '/api/accounts?status=active',
        '/api/categories?kind=expense&status=active',
        '/api/transactions?limit=50&month=2026-03',
      ]);
    });
  });

  it('RF-M2-03 con 1.1 Presupuestos, Metas y Deudas piden y Recurrentes no', async () => {
    signIn('1.1');
    const network = installNetwork();

    for (const path of GATED) prefetchRoute(queryClient, path);

    await vi.waitFor(() => {
      expect(network.requested().sort()).toEqual([
        '/api/budgets',
        '/api/debts?view=debt',
        '/api/goals',
      ]);
    });
    await flush();
    expect(network.countTo('/api/recurring')).toBe(0);
  });

  it('RF-M2-03 con 1.2 las cuatro rutas de planificación piden sus datos', async () => {
    signIn('1.2');
    const network = installNetwork();

    for (const path of GATED) prefetchRoute(queryClient, path);

    await vi.waitFor(() => {
      expect(network.requested().sort()).toEqual([
        '/api/budgets',
        '/api/debts?view=debt',
        '/api/goals',
        '/api/recurring',
      ]);
    });
  });

  it.each(GATED)(
    'RF-M2-03 sin el perfil en la caché %s no pide su módulo, que el API podría responder 404',
    async (path) => {
      const network = installNetwork();

      prefetchRoute(queryClient, path);
      await flush();

      // Whatever it asks to learn the release, it never asks for the data of the module.
      const modulePaths = ['/api/budgets', '/api/goals', '/api/debts', '/api/recurring'];
      expect(network.requests.filter((url) => modulePaths.includes(pathOf(url)))).toEqual([]);
    },
  );
});

describe('TASK-259 un error del prefetch no se muestra y la pantalla lo repite', () => {
  it('TASK-259 un 500 del prefetch no lanza, no deja promesas sin capturar y no muestra nada', async () => {
    signIn('1.2');
    const network = installNetwork((url) =>
      pathOf(url) === '/api/accounts' ? serverError() : null,
    );

    expect(() => {
      prefetchRoute(queryClient, '/cuentas');
    }).not.toThrow();

    await vi.waitFor(() => {
      expect(queryClient.getQueryState(['accounts', 'active'])?.status).toBe('error');
    });
    await flush();
    expect(network.countTo('/api/accounts')).toBe(1);
    // Nothing for the person to see: no offline overlay and no session dialog.
    expect(uiStore.getState().offline).toBe(false);
    expect(uiStore.getState().sessionExpired).toBe(false);
  });

  it('TASK-259 un 500 del prefetch de Movimientos tampoco lanza ni se muestra', async () => {
    signIn('1.2');
    const network = installNetwork((url) =>
      pathOf(url) === '/api/transactions' ? serverError() : null,
    );

    expect(() => {
      prefetchRoute(queryClient, '/movimientos');
    }).not.toThrow();

    await vi.waitFor(() => {
      expect(
        queryClient.getQueryState(['transactions', 'list', { month: '2026-03' }])?.status,
      ).toBe('error');
    });
    await flush();
    expect(network.countTo('/api/transactions')).toBe(1);
    expect(uiStore.getState().offline).toBe(false);
    expect(uiStore.getState().sessionExpired).toBe(false);
  });

  it('TASK-259 al montarse, la pantalla repite la petición que el prefetch no logró', async () => {
    signIn('1.2');
    const network = installNetwork((url, nth) =>
      pathOf(url) === '/api/accounts' && nth === 1 ? serverError() : null,
    );

    prefetchRoute(queryClient, '/cuentas');
    await vi.waitFor(() => {
      expect(queryClient.getQueryState(['accounts', 'active'])?.status).toBe('error');
    });

    // The screen mounts: `useQuery` is an observer of the same factory.
    const observer = new QueryObserver(queryClient, accountsQuery('active'));
    const unsubscribe = observer.subscribe(() => undefined);
    try {
      await vi.waitFor(() => {
        expect(observer.getCurrentResult().status).toBe('success');
      });
      expect(network.countTo('/api/accounts')).toBe(2);
    } finally {
      unsubscribe();
    }
  });
});

describe('TASK-259 el prefetch no toca el estado de las pestañas', () => {
  it('RF-M2-04 precargar una ruta no cambia la memoria de pestañas', async () => {
    signIn('1.2');
    installNetwork();
    const before = JSON.stringify(uiStore.getState().tabMemory);

    for (const { path } of ROUTES) prefetchRoute(queryClient, path);
    await flush();

    expect(JSON.stringify(uiStore.getState().tabMemory)).toBe(before);
  });
});
