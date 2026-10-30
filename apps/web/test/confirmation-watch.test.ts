import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createConfirmationWatch,
  useConfirmationWatch,
} from '../src/features/auth/hooks/use-confirmation-watch';

/**
 * TASK-266 (RF-M1-18, plan §4.1.4): the tab waiting on "Revisa tu correo" asks
 * `POST /api/auth/confirmation/status` every 3 s while it is visible (every 10 s after 5 minutes),
 * right away when it gets the focus back or becomes visible, and stops on `confirmed`, on dispose
 * and after 24 h. Network errors are ignored.
 *
 * The web has no jsdom: the hook is built on `createConfirmationWatch`, which takes the `fetch`,
 * the `window` that fires `focus` and the `document` that fires `visibilitychange` (with its
 * `visibilityState`). The clock is Vitest's fake one (timers and `Date`).
 */

const STATUS_PATH = /\/api\/auth\/confirmation\/status(\?|$)/;

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

type Status = { status: 'pending' } | { status: 'confirmed'; next: 'onboarding' };

const PENDING: Status = { status: 'pending' };
const CONFIRMED: Status = { status: 'confirmed', next: 'onboarding' };

class FakeDocument extends EventTarget {
  visibilityState: DocumentVisibilityState;

  constructor(visibilityState: DocumentVisibilityState) {
    super();
    this.visibilityState = visibilityState;
  }

  /** Changes the visibility and fires `visibilitychange`, as the browser does. */
  set(visibilityState: DocumentVisibilityState): void {
    this.visibilityState = visibilityState;
    this.dispatchEvent(new Event('visibilitychange'));
  }
}

function jsonResponse(body: Status): Promise<Response> {
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  );
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

let disposers: (() => void)[] = [];

function setup(options: { visibility?: DocumentVisibilityState } = {}) {
  const { visibility = 'visible' } = options;
  let answer: () => Promise<Response> = () => jsonResponse(PENDING);
  const fetchMock = vi.fn<typeof fetch>(() => answer());
  const win = new EventTarget();
  const doc = new FakeDocument(visibility);
  const onConfirmed = vi.fn<() => void>();
  const watch = createConfirmationWatch({ onConfirmed, fetch: fetchMock, window: win, document: doc });
  disposers.push(() => {
    watch.dispose();
  });
  const respond = (next: () => Promise<Response>) => {
    answer = next;
  };
  const calls = () => fetchMock.mock.calls.filter(([input]) => STATUS_PATH.test(urlOf(input))).length;
  return { fetchMock, win, doc, onConfirmed, watch, respond, calls };
}

beforeEach(() => {
  vi.useFakeTimers();
  disposers = [];
});

afterEach(() => {
  for (const dispose of disposers) dispose();
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('useConfirmationWatch', () => {
  it('RF-M1-18 el módulo exporta el hook useConfirmationWatch', () => {
    expect(typeof useConfirmationWatch).toBe('function');
  });
});

describe('createConfirmationWatch: sondeo con la pestaña visible', () => {
  it('RF-M1-18 llama a POST /api/auth/confirmation/status', async () => {
    const { fetchMock, calls } = setup();

    await vi.advanceTimersByTimeAsync(3 * SECOND);

    expect(calls()).toBeGreaterThanOrEqual(1);
    for (const [input, init] of fetchMock.mock.calls) {
      expect(urlOf(input)).toMatch(STATUS_PATH);
      expect(methodOf(input, init)).toBe('POST');
    }
  });

  it('RF-M1-18 con un reloj simulado pregunta cada 3 s mientras la pestaña está visible', async () => {
    const { calls } = setup();

    await vi.advanceTimersByTimeAsync(MINUTE);
    const before = calls();
    await vi.advanceTimersByTimeAsync(9 * SECOND);
    const afterNine = calls();
    await vi.advanceTimersByTimeAsync(30 * SECOND);

    expect(before).toBeGreaterThanOrEqual(20);
    expect(afterNine - before).toBe(3);
    expect(calls() - afterNine).toBe(10);
  });

  it('RF-M1-18 una respuesta pending no continúa y sigue preguntando', async () => {
    const { onConfirmed, calls } = setup();

    await vi.advanceTimersByTimeAsync(30 * SECOND);

    expect(onConfirmed).not.toHaveBeenCalled();
    expect(calls()).toBeGreaterThanOrEqual(10);
  });

  it('RF-M1-18 pasados 5 minutos pregunta cada 10 s', async () => {
    const { calls } = setup();

    await vi.advanceTimersByTimeAsync(6 * MINUTE);
    const before = calls();
    await vi.advanceTimersByTimeAsync(30 * SECOND);
    const afterThirty = calls();
    await vi.advanceTimersByTimeAsync(MINUTE);

    expect(afterThirty - before).toBe(3);
    expect(calls() - afterThirty).toBe(6);
  });
});

describe('createConfirmationWatch: visibilidad y foco', () => {
  it('RF-M1-18 con la pestaña oculta no pregunta', async () => {
    const { calls } = setup({ visibility: 'hidden' });

    await vi.advanceTimersByTimeAsync(2 * MINUTE);

    expect(calls()).toBe(0);
  });

  it('RF-M1-18 al ocultarse la pestaña deja de preguntar', async () => {
    const { doc, calls } = setup();

    await vi.advanceTimersByTimeAsync(10 * SECOND);
    expect(calls()).toBeGreaterThanOrEqual(3);
    doc.set('hidden');
    await vi.advanceTimersByTimeAsync(0);
    const hiddenAt = calls();
    await vi.advanceTimersByTimeAsync(2 * MINUTE);

    expect(calls()).toBe(hiddenAt);
  });

  it('RF-M1-18 pregunta de inmediato al volverse visible y retoma el sondeo de 3 s', async () => {
    const { doc, calls } = setup({ visibility: 'hidden' });

    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(calls()).toBe(0);
    doc.set('visible');
    await vi.advanceTimersByTimeAsync(0);
    expect(calls()).toBe(1);
    await vi.advanceTimersByTimeAsync(9 * SECOND);

    expect(calls()).toBe(4);
  });

  it('RF-M1-18 pregunta de inmediato al recuperar el foco', async () => {
    const { win, calls } = setup();

    await vi.advanceTimersByTimeAsync(SECOND);
    const before = calls();
    win.dispatchEvent(new Event('focus'));
    await vi.advanceTimersByTimeAsync(0);

    expect(calls()).toBe(before + 1);
  });

  it('RF-M1-18 al recuperar el foco con la confirmación hecha continúa al momento', async () => {
    const { win, doc, onConfirmed, respond } = setup({ visibility: 'hidden' });

    await vi.advanceTimersByTimeAsync(MINUTE);
    respond(() => jsonResponse(CONFIRMED));
    doc.visibilityState = 'visible';
    win.dispatchEvent(new Event('focus'));
    await vi.advanceTimersByTimeAsync(0);

    expect(onConfirmed).toHaveBeenCalledTimes(1);
  });
});

describe('createConfirmationWatch: fin del sondeo', () => {
  it('RF-M1-18 con confirmed llama a onConfirmed una vez y se detiene', async () => {
    const { onConfirmed, respond, win, doc, calls } = setup();

    await vi.advanceTimersByTimeAsync(6 * SECOND);
    expect(onConfirmed).not.toHaveBeenCalled();
    respond(() => jsonResponse(CONFIRMED));
    await vi.advanceTimersByTimeAsync(3 * SECOND);
    expect(onConfirmed).toHaveBeenCalledTimes(1);
    const confirmedAt = calls();

    await vi.advanceTimersByTimeAsync(2 * MINUTE);
    win.dispatchEvent(new Event('focus'));
    doc.set('hidden');
    doc.set('visible');
    await vi.advanceTimersByTimeAsync(MINUTE);

    expect(calls()).toBe(confirmedAt);
    expect(onConfirmed).toHaveBeenCalledTimes(1);
  });

  it('RF-M1-18 dispose (al desmontarse) detiene el sondeo y deja de escuchar el foco', async () => {
    const { watch, win, doc, calls } = setup();

    await vi.advanceTimersByTimeAsync(6 * SECOND);
    watch.dispose();
    const disposedAt = calls();
    await vi.advanceTimersByTimeAsync(2 * MINUTE);
    win.dispatchEvent(new Event('focus'));
    doc.set('hidden');
    doc.set('visible');
    await vi.advanceTimersByTimeAsync(MINUTE);

    expect(calls()).toBe(disposedAt);
  });

  it('RF-M1-18 a las 24 h deja de preguntar', async () => {
    const { win, doc, calls } = setup();

    await vi.advanceTimersByTimeAsync(24 * HOUR);
    const dayAt = calls();
    expect(dayAt).toBeGreaterThan(0);
    await vi.advanceTimersByTimeAsync(HOUR);
    win.dispatchEvent(new Event('focus'));
    doc.set('hidden');
    doc.set('visible');
    await vi.advanceTimersByTimeAsync(MINUTE);

    expect(calls()).toBe(dayAt);
  });
});

describe('createConfirmationWatch: errores de red', () => {
  it('RF-M1-18 ignora los errores de red y sigue preguntando hasta confirmar', async () => {
    const { onConfirmed, respond, calls } = setup();
    respond(() => Promise.reject(new TypeError('Failed to fetch')));

    await vi.advanceTimersByTimeAsync(9 * SECOND);
    expect(calls()).toBeGreaterThanOrEqual(3);
    expect(onConfirmed).not.toHaveBeenCalled();

    respond(() => Promise.resolve(new Response('', { status: 503 })));
    await vi.advanceTimersByTimeAsync(6 * SECOND);
    expect(onConfirmed).not.toHaveBeenCalled();

    respond(() => jsonResponse(CONFIRMED));
    await vi.advanceTimersByTimeAsync(3 * SECOND);

    expect(onConfirmed).toHaveBeenCalledTimes(1);
  });
});
