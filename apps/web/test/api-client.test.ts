import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z, type ZodType } from 'zod';

import { ApiError, call } from '../src/lib/api-client';
import { online } from '../src/lib/online';
import { uiStore } from '../src/lib/ui-store';

// The test environment is node: it has no sessionStorage (used by `uiStore`)
// and no window (used by the `online` instance). Both are installed before the
// modules under test are evaluated. The global fetch is replaced by a delegate
// so every test controls the network, whether the client reads `fetch` lazily
// or keeps the reference it saw when the module was loaded.
const { fetchState, navigation } = vi.hoisted(() => {
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

  const calls: string[] = [];
  const navigation = {
    calls,
    location: {
      href: 'http://localhost/registrar',
      pathname: '/registrar',
      assign(url: string) {
        navigation.calls.push(`assign:${url}`);
      },
      replace(url: string) {
        navigation.calls.push(`replace:${url}`);
      },
      reload() {
        navigation.calls.push('reload');
      },
    },
    history: {
      pushState(_state: unknown, _title: string, url?: string) {
        navigation.calls.push(`pushState:${url ?? ''}`);
      },
      replaceState(_state: unknown, _title: string, url?: string) {
        navigation.calls.push(`replaceState:${url ?? ''}`);
      },
    },
  };
  const targets: object[] = [globalThis, globalThis.window];
  for (const target of targets) {
    if (!('location' in target)) {
      Object.defineProperty(target, 'location', {
        value: navigation.location,
        configurable: true,
        writable: true,
      });
    }
    if (!('history' in target)) {
      Object.defineProperty(target, 'history', {
        value: navigation.history,
        configurable: true,
        writable: true,
      });
    }
  }

  const fetchState: { impl: typeof fetch } = {
    impl: () => Promise.reject(new Error('fetch not configured for this test')),
  };
  Object.defineProperty(globalThis, 'fetch', {
    value: (input: Parameters<typeof fetch>[0], init?: RequestInit) => fetchState.impl(input, init),
    configurable: true,
    writable: true,
  });
  return { fetchState, navigation };
});

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

function endpoint<I, O>(e: {
  method: Method;
  path: string;
  input: ZodType<I>;
  output: ZodType<O>;
}): { method: Method; path: string; input: ZodType<I>; output: ZodType<O> } {
  return e;
}

const AccountSchema = z.object({ id: z.string(), name: z.string(), balance: z.string() });

const createAccount = endpoint({
  method: 'POST',
  path: '/api/accounts',
  input: z.object({ id: z.string(), name: z.string() }),
  output: AccountSchema,
});

const listAccounts = endpoint({
  method: 'GET',
  path: '/api/accounts',
  input: z.object({}),
  output: z.object({ items: z.array(AccountSchema) }),
});

const ACCOUNT_ID = '0192f1a4-7b3c-7d2e-9f10-123456789abc';
const NEW_ACCOUNT = { id: ACCOUNT_ID, name: 'Efectivo' };
const ACCOUNT = { id: ACCOUNT_ID, name: 'Efectivo', balance: '0.00' };

type Outcome = { ok: true; value: unknown } | { ok: false; error: unknown };

function settle(promise: Promise<unknown>): Promise<Outcome> {
  return promise.then(
    (value): Outcome => ({ ok: true, value }),
    (error: unknown): Outcome => ({ ok: false, error }),
  );
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function problemResponse(
  code: string,
  status: number,
  data?: Record<string, unknown>,
  traceId = 'trace-0001',
): Response {
  const body: Record<string, unknown> = {
    type: `https://errors.app/${code}`,
    title: code,
    status,
    code,
    traceId,
  };
  if (data !== undefined) body.data = data;
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/problem+json' },
  });
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

function headersOf(input: Parameters<typeof fetch>[0], init?: RequestInit): Headers {
  const headers = new Headers(input instanceof Request ? input.headers : undefined);
  new Headers(init?.headers).forEach((value, key) => {
    headers.set(key, value);
  });
  return headers;
}

function signalOf(input: Parameters<typeof fetch>[0], init?: RequestInit): AbortSignal | null {
  if (init?.signal !== undefined && init.signal !== null) return init.signal;
  if (input instanceof Request) return input.signal;
  return null;
}

function mockFetch(respond: () => Promise<Response>) {
  const fetchMock = vi.fn<typeof fetch>(() => respond());
  fetchState.impl = fetchMock;
  return fetchMock;
}

function firstCall(fetchMock: ReturnType<typeof mockFetch>): {
  input: Parameters<typeof fetch>[0];
  init: RequestInit | undefined;
} {
  const first = fetchMock.mock.calls[0];
  if (first === undefined) throw new Error('fetch was not called');
  return { input: first[0], init: first[1] };
}

beforeEach(() => {
  navigation.calls.length = 0;
  navigation.location.href = 'http://localhost/registrar';
  uiStore.closeSessionExpired();
});

afterEach(() => {
  // Releases the online singleton if a test marked the app offline.
  window.dispatchEvent(new Event('online'));
  uiStore.closeSessionExpired();
  vi.restoreAllMocks();
});

describe('call: request', () => {
  it('TASK-042 sends the method of the endpoint to its path', async () => {
    const fetchMock = mockFetch(() => Promise.resolve(jsonResponse(ACCOUNT, 201)));

    await call(createAccount, NEW_ACCOUNT);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const { input, init } = firstCall(fetchMock);
    expect(methodOf(input, init)).toBe('POST');
    expect(urlOf(input)).toMatch(/\/api\/accounts(\?|$)/);
  });

  it('RF-M1-07 with background: true sends the X-Background: 1 header', async () => {
    const fetchMock = mockFetch(() => Promise.resolve(jsonResponse({ items: [ACCOUNT] })));

    await call(listAccounts, {}, { background: true });

    const { input, init } = firstCall(fetchMock);
    expect(headersOf(input, init).get('X-Background')).toBe('1');
  });

  it('RF-M1-07 a request without background does not send X-Background (it renews the session)', async () => {
    const fetchMock = mockFetch(() => Promise.resolve(jsonResponse({ items: [ACCOUNT] })));

    await call(listAccounts, {});
    await call(listAccounts, {}, { background: false });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [input, init] of fetchMock.mock.calls) {
      expect(headersOf(input, init).has('X-Background')).toBe(false);
    }
  });

  it('TASK-042 forwards the abort signal to fetch', async () => {
    const fetchMock = mockFetch(() => Promise.resolve(jsonResponse({ items: [ACCOUNT] })));
    const controller = new AbortController();

    const pending = settle(call(listAccounts, {}, { signal: controller.signal }));
    controller.abort();
    await pending;

    const { input, init } = firstCall(fetchMock);
    const signal = signalOf(input, init);
    expect(signal).not.toBeNull();
    expect(signal?.aborted).toBe(true);
  });
});

describe('call: response', () => {
  it('TASK-042 resolves with the output that matches the schema of the endpoint', async () => {
    mockFetch(() => Promise.resolve(jsonResponse(ACCOUNT, 201)));

    await expect(call(createAccount, NEW_ACCOUNT)).resolves.toEqual(ACCOUNT);
  });

  it('TASK-042 a response that does not match the output schema throws an error', async () => {
    mockFetch(() => Promise.resolve(jsonResponse({ id: ACCOUNT_ID, name: 'Efectivo', balance: 5 })));

    const outcome = await settle(call(createAccount, NEW_ACCOUNT));

    expect(outcome.ok).toBe(false);
  });

  it('TASK-042 a response missing required output fields throws an error', async () => {
    mockFetch(() => Promise.resolve(jsonResponse({ items: [{ id: ACCOUNT_ID }] })));

    const outcome = await settle(call(listAccounts, {}));

    expect(outcome.ok).toBe(false);
  });
});

describe('call: problem+json', () => {
  it('TASK-042 a problem+json throws ApiError with code, status, data and traceId (ADR-09)', async () => {
    const data = { accountId: ACCOUNT_ID, resultingBalance: '-5.00' };
    mockFetch(() => Promise.resolve(problemResponse('NEGATIVE_BALANCE', 422, data, 'trace-abc')));

    const outcome = await settle(call(createAccount, NEW_ACCOUNT));

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toBeInstanceOf(ApiError);
    expect(outcome.error).toMatchObject({
      code: 'NEGATIVE_BALANCE',
      status: 422,
      data,
      traceId: 'trace-abc',
    });
  });

  it('TASK-042 an INTERNAL_ERROR problem throws ApiError with its traceId', async () => {
    mockFetch(() => Promise.resolve(problemResponse('INTERNAL_ERROR', 500, undefined, 'trace-500')));

    const outcome = await settle(call(listAccounts, {}));

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toBeInstanceOf(ApiError);
    expect(outcome.error).toMatchObject({ code: 'INTERNAL_ERROR', status: 500, traceId: 'trace-500' });
  });

  it('TASK-042 a problem+json does not mark the app offline', async () => {
    mockFetch(() => Promise.resolve(problemResponse('NOT_FOUND', 404)));
    const setOffline = vi.spyOn(online, 'setOffline');

    await settle(call(listAccounts, {}));

    expect(setOffline).not.toHaveBeenCalled();
    expect(uiStore.getState().offline).toBe(false);
  });
});

describe('call: session expired', () => {
  it('RF-M2-08 SESSION_EXPIRED opens the session-expired dialog without navigating', async () => {
    mockFetch(() => Promise.resolve(problemResponse('SESSION_EXPIRED', 401)));
    const openSessionExpired = vi.spyOn(uiStore, 'openSessionExpired');

    const outcome = await settle(call(createAccount, NEW_ACCOUNT));

    expect(outcome.ok).toBe(false);
    expect(openSessionExpired).toHaveBeenCalledTimes(1);
    expect(uiStore.getState().sessionExpired).toBe(true);
    expect(navigation.calls).toEqual([]);
    expect(navigation.location.href).toBe('http://localhost/registrar');
  });

  it('RF-M2-08 SESSION_EXPIRED rejects with ApiError SESSION_EXPIRED 401', async () => {
    mockFetch(() => Promise.resolve(problemResponse('SESSION_EXPIRED', 401, undefined, 'trace-401')));

    const outcome = await settle(call(listAccounts, {}));

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toBeInstanceOf(ApiError);
    expect(outcome.error).toMatchObject({ code: 'SESSION_EXPIRED', status: 401, traceId: 'trace-401' });
  });

  it('RF-M2-08 another error code does not open the session-expired dialog', async () => {
    mockFetch(() => Promise.resolve(problemResponse('VALIDATION_ERROR', 400, { field: 'name' })));
    const openSessionExpired = vi.spyOn(uiStore, 'openSessionExpired');

    await settle(call(createAccount, NEW_ACCOUNT));

    expect(openSessionExpired).not.toHaveBeenCalled();
    expect(uiStore.getState().sessionExpired).toBe(false);
  });
});

describe('call: network failure', () => {
  it('RF-M2-07 a network TypeError marks the app offline', async () => {
    mockFetch(() => Promise.reject(new TypeError('Failed to fetch')));
    const setOffline = vi.spyOn(online, 'setOffline');

    const outcome = await settle(call(createAccount, NEW_ACCOUNT));

    expect(outcome.ok).toBe(false);
    expect(setOffline).toHaveBeenCalledTimes(1);
    expect(uiStore.getState().offline).toBe(true);
  });

  it('RF-M2-07 a successful response does not mark the app offline', async () => {
    mockFetch(() => Promise.resolve(jsonResponse({ items: [ACCOUNT] })));
    const setOffline = vi.spyOn(online, 'setOffline');

    await call(listAccounts, {});

    expect(setOffline).not.toHaveBeenCalled();
    expect(uiStore.getState().offline).toBe(false);
  });
});
