import { Decimal } from 'decimal.js';
import { describe, expect, it } from 'vitest';

import type { OfficialQuote } from '../../src/application/ports/rates-gateway.js';
import { createBcbGateway } from '../../src/infrastructure/integrations/bcb.js';
import { createFakeBcbGateway } from '../../src/infrastructure/integrations/bcb.fake.js';

const URL = 'https://www.bcb.gob.bo/bcb_tco_publico_ultima_cotizacion.php';
const NOW = new Date('2026-10-19T12:00:00.000Z');

interface Call {
  url: string;
  method: string | undefined;
}

type FetchImpl = typeof fetch;

function html(value: string | null = 'Bs 11,69/$us', vigencia: string | null = null): string {
  const v = vigencia ?? 'VIGENCIA: DEL SÁBADO 17 DE OCTUBRE DE 2026 AL LUNES 19 DE OCTUBRE DE 2026';
  return (
    '<div class="tco-public">' +
    (value === null ? '' : `<div class="tco-public-value">${value}</div>`) +
    `<span class="tco-public-vigencia">${v}</span></div>`
  );
}

function gatewayWith(respond: (call: Call) => Response | Promise<Response>, timeoutMs = 1000) {
  const calls: Call[] = [];
  const impl = async (input: Parameters<FetchImpl>[0], init?: RequestInit): Promise<Response> => {
    const call: Call = {
      url: typeof input === 'string' ? input : input instanceof globalThis.URL ? input.href : input.url,
      method: init?.method,
    };
    calls.push(call);
    return respond(call);
  };
  const gateway = createBcbGateway({ url: URL, timeoutMs, fetch: impl, now: () => NOW });
  return { gateway, calls };
}

const ok = (body: string) => new Response(body, { status: 200 });

describe('BCB fetchOfficial', () => {
  it('TASK-082 hace un GET a la URL del widget', async () => {
    const { gateway, calls } = gatewayWith(() => ok(html()));
    await gateway.fetchOfficial();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(URL);
    expect(calls[0]?.method ?? 'GET').toBe('GET');
  });

  it('TASK-082 con una respuesta de ejemplo devuelve el valor, su vigencia y observedAt = ahora', async () => {
    const { gateway } = gatewayWith(() => ok(html()));
    const res = await gateway.fetchOfficial();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.value.toString()).toBe('11.69');
    expect(res.value.effectiveDate).toBe('2026-10-17');
    expect(res.value.observedAt.toISOString()).toBe(NOW.toISOString());
  });

  it('TASK-082 la vigencia es la primera fecha, con meses en mayúsculas, minúsculas o acentuados', async () => {
    const cases: [string, string][] = [
      ['VIGENCIA: DEL LUNES 5 DE ENERO DE 2027 AL MARTES 6 DE ENERO DE 2027', '2027-01-05'],
      ['Vigencia: del sábado 27 de junio de 2026 al domingo 28 de junio de 2026', '2026-06-27'],
      ['VIGENCIA: DEL MIÉRCOLES 30 DE SEPTIEMBRE DE 2026 AL JUEVES 1 DE OCTUBRE DE 2026', '2026-09-30'],
    ];
    for (const [text, expected] of cases) {
      const { gateway } = gatewayWith(() => ok(html('Bs 11,69/$us', text)));
      const res = await gateway.fetchOfficial();
      expect(res.ok && res.value.effectiveDate).toBe(expected);
    }
  });

  it('TASK-082 si la vigencia no se puede leer, effectiveDate es null y el valor se conserva', async () => {
    const { gateway } = gatewayWith(() => ok(html('Bs 11,69/$us', 'VIGENCIA: SIN DATOS')));
    const res = await gateway.fetchOfficial();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.effectiveDate).toBeNull();
    expect(res.value.value.toString()).toBe('11.69');
  });

  it('TASK-082 sin el elemento de vigencia, effectiveDate es null', async () => {
    const { gateway } = gatewayWith(() => ok('<div class="tco-public-value">Bs 6,96/$us</div>'));
    const res = await gateway.fetchOfficial();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.effectiveDate).toBeNull();
    expect(res.value.value.toString()).toBe('6.96');
  });
});

describe('BCB fallos de la fuente', () => {
  it('TASK-082 con HTML inesperado (sin el elemento del valor) informa SOURCE_ERROR sin lanzar', async () => {
    const { gateway } = gatewayWith(() => ok('<html><body><p>Mantenimiento</p></body></html>'));
    await expect(gateway.fetchOfficial()).resolves.toEqual({ ok: false, reason: 'SOURCE_ERROR' });
  });

  it('TASK-082 una respuesta vacía informa SOURCE_ERROR', async () => {
    const { gateway } = gatewayWith(() => ok(''));
    await expect(gateway.fetchOfficial()).resolves.toEqual({ ok: false, reason: 'SOURCE_ERROR' });
  });

  it('TASK-082 el elemento sin el valor numérico es INVALID_VALUE', async () => {
    const { gateway } = gatewayWith(() => ok(html('Bs --/$us')));
    await expect(gateway.fetchOfficial()).resolves.toEqual({ ok: false, reason: 'INVALID_VALUE' });
  });

  it.each(['Bs 0,00/$us', 'Bs 0,005/$us', 'Bs 11,695/$us'])(
    'EC-M3-04 el valor %s se rechaza como INVALID_VALUE',
    async (value) => {
      const { gateway } = gatewayWith(() => ok(html(value)));
      await expect(gateway.fetchOfficial()).resolves.toEqual({ ok: false, reason: 'INVALID_VALUE' });
    },
  );

  it('EC-M3-04 el mínimo 0,01 y el valor entero son válidos', async () => {
    const min = await gatewayWith(() => ok(html('Bs 0,01/$us'))).gateway.fetchOfficial();
    expect(min.ok && min.value.value.toString()).toBe('0.01');
    const whole = await gatewayWith(() => ok(html('Bs 7/$us'))).gateway.fetchOfficial();
    expect(whole.ok && whole.value.value.toString()).toBe('7');
  });

  it('TASK-082 un HTTP distinto de 200 es SOURCE_ERROR', async () => {
    const { gateway } = gatewayWith(() => new Response(html(), { status: 503 }));
    await expect(gateway.fetchOfficial()).resolves.toEqual({ ok: false, reason: 'SOURCE_ERROR' });
  });

  it('TASK-082 un error de red es SOURCE_ERROR sin lanzar', async () => {
    const { gateway } = gatewayWith(() => Promise.reject(new TypeError('fetch failed')));
    await expect(gateway.fetchOfficial()).resolves.toEqual({ ok: false, reason: 'SOURCE_ERROR' });
  });

  it('TASK-082 un timeout se informa como TIMEOUT sin lanzar', async () => {
    const abortable = ((_input: Parameters<FetchImpl>[0], init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'));
        });
      })) as FetchImpl;
    const gateway = createBcbGateway({ url: URL, timeoutMs: 20, fetch: abortable, now: () => NOW });
    await expect(gateway.fetchOfficial()).resolves.toEqual({ ok: false, reason: 'TIMEOUT' });
  });
});

describe('BCB fake', () => {
  const official: OfficialQuote = {
    value: new Decimal('11.69'),
    effectiveDate: '2026-10-17',
    observedAt: NOW,
  };

  it('TASK-082 el fake devuelve el valor configurado y cuenta las llamadas', async () => {
    const fake = createFakeBcbGateway({ official });
    const res = await fake.fetchOfficial();
    expect(res).toEqual({ ok: true, value: official });
    expect(fake.calls.official).toBe(1);
  });

  it('TASK-082 configure cambia lo que devuelve el fake', async () => {
    const fake = createFakeBcbGateway({ official });
    fake.configure({ official: { ...official, value: new Decimal('12.5') } });
    const res = await fake.fetchOfficial();
    expect(res.ok && res.value.value.toString()).toBe('12.5');
  });

  it.each(['TIMEOUT', 'INVALID_VALUE', 'SOURCE_ERROR'] as const)(
    'TASK-082 el fake simula el fallo %s sin lanzar',
    async (failure) => {
      const fake = createFakeBcbGateway({ official, failure });
      await expect(fake.fetchOfficial()).resolves.toEqual({ ok: false, reason: failure });
    },
  );

  it('TASK-082 configure({ failure: null }) quita el fallo simulado', async () => {
    const fake = createFakeBcbGateway({ official, failure: 'SOURCE_ERROR' });
    fake.configure({ failure: null });
    expect((await fake.fetchOfficial()).ok).toBe(true);
  });

  it('TASK-082 delayMs simula lentitud', async () => {
    const fake = createFakeBcbGateway({ official, delayMs: 60 });
    const start = Date.now();
    await fake.fetchOfficial();
    expect(Date.now() - start).toBeGreaterThanOrEqual(50);
  });
});
