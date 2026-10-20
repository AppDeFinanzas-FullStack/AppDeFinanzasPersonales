import { Decimal } from 'decimal.js';
import { describe, expect, it } from 'vitest';

import type { ParallelQuote } from '../../src/application/ports/rates-gateway.js';
import { createFakeRatesGateway } from '../../src/infrastructure/integrations/paralelo-bo.fake.js';
import { createParaleloBoGateway } from '../../src/infrastructure/integrations/paralelo-bo.js';

const URL = 'https://paralelo.bo/mcp';
const NOW = new Date('2026-10-19T12:00:00.000Z');

interface Call {
  url: string;
  method: string | undefined;
  headers: Record<string, string>;
  body: { method?: string; params?: { name?: string; arguments?: Record<string, unknown> } };
}

type FetchImpl = typeof fetch;

function rpcOk(structuredContent: unknown, text = ''): Response {
  return new Response(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      result: { structuredContent, content: [{ type: 'text', text }], isError: false },
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

function makeFetch(respond: (call: Call) => Response | Promise<Response>): {
  fetch: FetchImpl;
  calls: Call[];
} {
  const calls: Call[] = [];
  const impl = async (input: Parameters<FetchImpl>[0], init?: RequestInit): Promise<Response> => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => {
      headers[k.toLowerCase()] = v;
    });
    const call: Call = {
      url: typeof input === 'string' ? input : input instanceof globalThis.URL ? input.href : input.url,
      method: init?.method,
      headers,
      body: JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Call['body'],
    };
    calls.push(call);
    return respond(call);
  };
  return { fetch: impl, calls };
}

function gatewayWith(respond: (call: Call) => Response | Promise<Response>, timeoutMs = 1000) {
  const f = makeFetch(respond);
  const gateway = createParaleloBoGateway({ url: URL, timeoutMs, fetch: f.fetch, now: () => NOW });
  return { gateway, calls: f.calls };
}

const current = (over: Record<string, unknown> = {}) => ({
  median: 11.83,
  buy: 11.85,
  sell: 11.81,
  timestamp: '2026-10-19T23:04:58.836Z',
  ...over,
});

describe('paralelo.bo fetchParallel', () => {
  it('TASK-081 llama get_current_rate por POST JSON-RPC con las cabeceras de la fuente', async () => {
    const { gateway, calls } = gatewayWith(() => rpcOk(current()));
    await gateway.fetchParallel();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(URL);
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.headers['content-type']).toContain('application/json');
    expect(calls[0]?.headers['accept']).toContain('application/json');
    expect(calls[0]?.headers['accept']).toContain('text/event-stream');
    expect(calls[0]?.body.method).toBe('tools/call');
    expect(calls[0]?.body.params?.name).toBe('get_current_rate');
  });

  it('TASK-081 devuelve la mediana, observedAt = timestamp y compra/venta clasificadas con classifyBidAsk', async () => {
    // buy (11.85) > sell (11.81): la compra es el menor y la venta el mayor
    const { gateway } = gatewayWith(() => rpcOk(current()));
    const res = await gateway.fetchParallel();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.median.toString()).toBe('11.83');
    expect(res.value.bid?.toString()).toBe('11.81');
    expect(res.value.ask?.toString()).toBe('11.85');
    expect(res.value.observedAt.toISOString()).toBe('2026-10-19T23:04:58.836Z');
  });

  it('TASK-081 si buy es menor que sell mantiene compra = menor y venta = mayor', async () => {
    const { gateway } = gatewayWith(() => rpcOk(current({ buy: 11.7, sell: 11.9 })));
    const res = await gateway.fetchParallel();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.bid?.toString()).toBe('11.7');
    expect(res.value.ask?.toString()).toBe('11.9');
  });

  it.each([
    ['cero', 0],
    ['negativo', -11.83],
    ['vacío (null)', null],
    ['vacío (cadena)', ''],
    ['con más de 2 decimales', 11.835],
    ['menor que 0,01', 0.001],
  ])('EC-M3-04 una mediana %s se descarta como INVALID_VALUE', async (_name, median) => {
    const { gateway } = gatewayWith(() => rpcOk(current({ median })));
    const res = await gateway.fetchParallel();
    expect(res).toEqual({ ok: false, reason: 'INVALID_VALUE' });
  });

  it('EC-M3-04 una mediana ausente se descarta como INVALID_VALUE', async () => {
    const { gateway } = gatewayWith(() => rpcOk({ timestamp: '2026-10-19T23:04:58.836Z' }));
    expect(await gateway.fetchParallel()).toEqual({ ok: false, reason: 'INVALID_VALUE' });
  });

  it('EC-M3-04 un salto grande positivo se acepta', async () => {
    const { gateway } = gatewayWith(() => rpcOk(current({ median: 250.5, buy: 251, sell: 250 })));
    const res = await gateway.fetchParallel();
    expect(res.ok).toBe(true);
  });

  it('EC-M3-04 el valor mínimo 0.01 con 2 decimales se acepta', async () => {
    const { gateway } = gatewayWith(() => rpcOk(current({ median: 0.01 })));
    const res = await gateway.fetchParallel();
    expect(res.ok).toBe(true);
  });

  it.each([
    ['buy inválido', { buy: 0 }],
    ['sell negativo', { sell: -1 }],
    ['buy vacío', { buy: null }],
    ['sell con 3 decimales', { sell: 11.811 }],
  ])('EC-M3-04 con %s, bid y ask quedan en null y la mediana sigue válida', async (_n, over) => {
    const { gateway } = gatewayWith(() => rpcOk(current(over)));
    const res = await gateway.fetchParallel();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.median.toString()).toBe('11.83');
    expect(res.value.bid).toBeNull();
    expect(res.value.ask).toBeNull();
  });
});

describe('paralelo.bo fallos de la fuente', () => {
  it('TASK-081 un timeout se informa como TIMEOUT sin lanzar', async () => {
    const f = makeFetch(() => new Promise<Response>(() => undefined));
    // un fetch que respeta la señal de aborto, como el real
    const abortable = ((input: Parameters<FetchImpl>[0], init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        void f.fetch(input, init);
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'));
        });
      })) as FetchImpl;
    const gateway = createParaleloBoGateway({ url: URL, timeoutMs: 20, fetch: abortable, now: () => NOW });
    await expect(gateway.fetchParallel()).resolves.toEqual({ ok: false, reason: 'TIMEOUT' });
    await expect(gateway.fetchOfficial()).resolves.toEqual({ ok: false, reason: 'TIMEOUT' });
    await expect(gateway.fetchParallelOn('2026-10-01')).resolves.toEqual({
      ok: false,
      reason: 'TIMEOUT',
    });
  });

  it('TASK-081 un error de red es SOURCE_ERROR sin lanzar', async () => {
    const { gateway } = gatewayWith(() => Promise.reject(new TypeError('fetch failed')));
    await expect(gateway.fetchParallel()).resolves.toEqual({ ok: false, reason: 'SOURCE_ERROR' });
    await expect(gateway.fetchOfficial()).resolves.toEqual({ ok: false, reason: 'SOURCE_ERROR' });
  });

  it('TASK-081 un HTTP distinto de 200 es SOURCE_ERROR', async () => {
    const { gateway } = gatewayWith(() => new Response('boom', { status: 503 }));
    await expect(gateway.fetchParallel()).resolves.toEqual({ ok: false, reason: 'SOURCE_ERROR' });
  });

  it('TASK-081 un error JSON-RPC es SOURCE_ERROR', async () => {
    const { gateway } = gatewayWith(
      () =>
        new Response(
          JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'nope' } }),
          { status: 200 },
        ),
    );
    await expect(gateway.fetchParallel()).resolves.toEqual({ ok: false, reason: 'SOURCE_ERROR' });
  });

  it('TASK-081 result.isError es SOURCE_ERROR', async () => {
    const { gateway } = gatewayWith(
      () =>
        new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            result: { isError: true, content: [{ type: 'text', text: 'bad param' }] },
          }),
          { status: 200 },
        ),
    );
    await expect(gateway.fetchParallelOn('2026-10-01')).resolves.toEqual({
      ok: false,
      reason: 'SOURCE_ERROR',
    });
  });
});

describe('paralelo.bo fetchOfficial', () => {
  const official = (text: string, over: Record<string, unknown> = {}) =>
    rpcOk({ result: 11.69, rate: 11.69, ...over }, text);

  it('RF-M3-04 llama convert_currency con direction official USD a BOB', async () => {
    const { gateway, calls } = gatewayWith(() => official('1 USD = 11.69 BOB (vigencia 2026-10-17)'));
    await gateway.fetchOfficial();
    expect(calls[0]?.body.params?.name).toBe('convert_currency');
    expect(calls[0]?.body.params?.arguments).toMatchObject({
      amount: 1,
      from: 'USD',
      to: 'BOB',
      direction: 'official',
    });
  });

  it('RF-M3-04 el valor es rate, effectiveDate sale de «vigencia» y observedAt es ahora', async () => {
    const { gateway } = gatewayWith(() => official('1 USD = 11.69 BOB (vigencia 2026-10-17)'));
    const res = await gateway.fetchOfficial();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.value.toString()).toBe('11.69');
    expect(res.value.effectiveDate).toBe('2026-10-17');
    expect(res.value.observedAt.toISOString()).toBe(NOW.toISOString());
  });

  it('RF-M3-04 sin «vigencia» en el texto, effectiveDate es null', async () => {
    const { gateway } = gatewayWith(() => official('1 USD = 11.69 BOB'));
    const res = await gateway.fetchOfficial();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.effectiveDate).toBeNull();
  });

  it.each([
    ['cero', 0],
    ['negativo', -6.96],
    ['vacío', null],
    ['con 3 decimales', 11.691],
  ])('EC-M3-04 un oficial %s se descarta como INVALID_VALUE', async (_n, rate) => {
    const { gateway } = gatewayWith(() => official('(vigencia 2026-10-17)', { rate }));
    expect(await gateway.fetchOfficial()).toEqual({ ok: false, reason: 'INVALID_VALUE' });
  });
});

describe('paralelo.bo fetchParallelOn', () => {
  const hist = (over: Record<string, unknown> = {}) =>
    rpcOk({ date: '2026-10-01', median: 10.5, requestedDate: '2026-10-01', illustrative: false, ...over });

  it('RF-M3-04 llama get_historical_rate con la fecha y devuelve mediana y fecha', async () => {
    const { gateway, calls } = gatewayWith(() => hist());
    const res = await gateway.fetchParallelOn('2026-10-01');
    expect(calls[0]?.body.params?.name).toBe('get_historical_rate');
    expect(calls[0]?.body.params?.arguments).toMatchObject({ date: '2026-10-01' });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.median.toString()).toBe('10.5');
    expect(res.value.date).toBe('2026-10-01');
  });

  it('RF-M3-04 un dato illustrative: true es INVALID_VALUE', async () => {
    const { gateway } = gatewayWith(() => hist({ illustrative: true }));
    expect(await gateway.fetchParallelOn('2026-10-01')).toEqual({
      ok: false,
      reason: 'INVALID_VALUE',
    });
  });

  it.each([
    ['cero', 0],
    ['negativo', -1],
    ['vacío', null],
    ['con 3 decimales', 10.123],
  ])('EC-M3-04 una mediana histórica %s se descarta como INVALID_VALUE', async (_n, median) => {
    const { gateway } = gatewayWith(() => hist({ median }));
    expect(await gateway.fetchParallelOn('2026-10-01')).toEqual({
      ok: false,
      reason: 'INVALID_VALUE',
    });
  });
});

describe('fake de RatesGateway', () => {
  const quote: ParallelQuote = {
    median: new Decimal('11.83'),
    bid: new Decimal('11.81'),
    ask: new Decimal('11.85'),
    observedAt: NOW,
  };

  it('TASK-081 el fake devuelve los valores configurables y cuenta las llamadas', async () => {
    const fake = createFakeRatesGateway({
      parallel: quote,
      official: { value: new Decimal('6.96'), effectiveDate: '2026-10-17', observedAt: NOW },
    });
    const p = await fake.fetchParallel();
    const o = await fake.fetchOfficial();
    await fake.fetchParallelOn('2026-10-01');
    expect(p).toEqual({ ok: true, value: quote });
    expect(o.ok && o.value.value.toString()).toBe('6.96');
    expect(fake.calls).toEqual({ parallel: 1, official: 1, parallelOn: 1 });
  });

  it('TASK-081 configure cambia lo que devuelve el fake', async () => {
    const fake = createFakeRatesGateway({ parallel: quote });
    fake.configure({ parallel: { ...quote, median: new Decimal('12.5') } });
    const p = await fake.fetchParallel();
    expect(p.ok && p.value.median.toString()).toBe('12.5');
  });

  it.each(['TIMEOUT', 'INVALID_VALUE', 'SOURCE_ERROR'] as const)(
    'EC-M3-04 el fake simula el fallo %s sin lanzar',
    async (failure) => {
      const fake = createFakeRatesGateway({ parallel: quote, failure });
      await expect(fake.fetchParallel()).resolves.toEqual({ ok: false, reason: failure });
      await expect(fake.fetchOfficial()).resolves.toEqual({ ok: false, reason: failure });
      await expect(fake.fetchParallelOn('2026-10-01')).resolves.toEqual({
        ok: false,
        reason: failure,
      });
    },
  );

  it('TASK-081 configure({ failure: null }) quita el fallo simulado', async () => {
    const fake = createFakeRatesGateway({ parallel: quote, failure: 'SOURCE_ERROR' });
    fake.configure({ failure: null });
    expect((await fake.fetchParallel()).ok).toBe(true);
  });

  it('TASK-081 delayMs simula lentitud', async () => {
    const fake = createFakeRatesGateway({ parallel: quote, delayMs: 60 });
    const start = Date.now();
    await fake.fetchParallel();
    expect(Date.now() - start).toBeGreaterThanOrEqual(50);
  });
});
