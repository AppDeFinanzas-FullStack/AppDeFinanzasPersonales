import { ProblemSchema } from '@finanzas/contracts';
import type { ZodType } from 'zod';

import { online as defaultOnline, type Online } from './online';
import { uiStore as defaultUiStore, type UiStore } from './ui-store';

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

export interface Endpoint<I, O> {
  method: HttpMethod;
  path: string;
  input: ZodType<I>;
  output: ZodType<O>;
}

export interface CallOptions {
  background?: boolean;
  signal?: AbortSignal;
}

export interface ApiErrorInit {
  code: string;
  status: number;
  data?: Record<string, unknown>;
  traceId?: string;
}

// ADR-09: a problem+json from the API; the web translates `code` with i18next.
export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly data: Record<string, unknown> | undefined;
  readonly traceId: string | undefined;

  constructor({ code, status, data, traceId }: ApiErrorInit) {
    super(code);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.data = data;
    this.traceId = traceId;
  }
}

export interface CreateApiClientOptions {
  fetch: typeof fetch;
  store: UiStore;
  online: Pick<Online, 'setOffline'>;
}

export type Call = <I, O>(endpoint: Endpoint<I, O>, input: I, opts?: CallOptions) => Promise<O>;

const PROBLEM_CONTENT_TYPE = 'application/problem+json';
const SESSION_EXPIRED = 'SESSION_EXPIRED';
const INTERNAL_ERROR = 'INTERNAL_ERROR';
const READY_PATH = '/api/health/ready';
const SERVER_ERROR = 500;
const SERVICE_UNAVAILABLE = 503;

function hasBody(method: HttpMethod): boolean {
  return method !== 'GET' && method !== 'DELETE';
}

function withQuery(path: string, input: unknown): string {
  if (typeof input !== 'object' || input === null) return path;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined || value === null) continue;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      params.append(key, String(value));
    }
  }
  const query = params.toString();
  if (query === '') return path;
  return `${path}${path.includes('?') ? '&' : '?'}${query}`;
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text === '') return undefined;
  return JSON.parse(text) as unknown;
}

async function toApiError(response: Response): Promise<ApiError> {
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes(PROBLEM_CONTENT_TYPE)) {
    let body: unknown;
    try {
      body = await readJson(response);
    } catch {
      body = undefined;
    }
    const problem = ProblemSchema.safeParse(body);
    if (problem.success) {
      return new ApiError({
        code: problem.data.code,
        status: problem.data.status,
        data: problem.data.data,
        traceId: problem.data.traceId,
      });
    }
  }
  return new ApiError({ code: INTERNAL_ERROR, status: response.status });
}

// Plan §4.0: typed fetch client. RF-M1-07 background header, ADR-09 problem+json,
// RF-M2-08 session expired without navigating, RF-M2-07 network failure → offline.
export function createApiClient({ fetch: send, store, online }: CreateApiClientOptions): Call {
  // A server error may be the API itself or the database behind it (for example a Neon quota that
  // is used up). `/api/health/ready` tells them apart: 503 means the database is unreachable, and
  // the app then says so instead of showing a generic error on every screen. One probe at a time.
  let probing: Promise<void> | null = null;
  function probeReadiness(): Promise<void> {
    probing ??= send(READY_PATH, { method: 'GET' })
      .then(
        (response) => {
          if (response.status === SERVICE_UNAVAILABLE) store.setServiceDown(true);
        },
        () => undefined,
      )
      .finally(() => {
        probing = null;
      });
    return probing;
  }

  return async function call<I, O>(
    endpoint: Endpoint<I, O>,
    input: I,
    opts: CallOptions = {},
  ): Promise<O> {
    const headers = new Headers({ accept: 'application/json' });
    if (opts.background === true) headers.set('X-Background', '1');
    const init: RequestInit = { method: endpoint.method, headers, credentials: 'include' };
    let url = endpoint.path;
    if (hasBody(endpoint.method)) {
      headers.set('content-type', 'application/json');
      init.body = JSON.stringify(input);
    } else {
      url = withQuery(endpoint.path, input);
    }
    if (opts.signal !== undefined) init.signal = opts.signal;

    let response: Response;
    try {
      response = await send(url, init);
    } catch (error) {
      if (error instanceof TypeError) online.setOffline();
      throw error;
    }

    if (!response.ok) {
      const apiError = await toApiError(response);
      if (apiError.code === SESSION_EXPIRED) store.openSessionExpired();
      if (response.status >= SERVER_ERROR) await probeReadiness();
      throw apiError;
    }

    store.setServiceDown(false);

    const body = response.status === 204 ? undefined : await readJson(response);
    return endpoint.output.parse(body);
  };
}

export const call: Call = createApiClient({
  fetch: (input, init) => fetch(input, init),
  store: defaultUiStore,
  online: defaultOnline,
});
