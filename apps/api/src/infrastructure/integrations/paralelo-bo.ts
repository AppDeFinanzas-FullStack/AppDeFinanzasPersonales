import { Decimal } from 'decimal.js';

import type { LocalDate } from '../../application/ports/clock.js';
import type {
  OfficialQuote,
  ParallelQuote,
  RateResult,
  RatesGateway,
} from '../../application/ports/rates-gateway.js';
import { classifyBidAsk } from '../../domain/index.js';

export interface ParaleloBoOptions {
  url: string;
  timeoutMs: number;
  fetch?: typeof fetch;
  now?: () => Date;
}

const MIN_RATE = new Decimal('0.01');
const EFFECTIVE_DATE = /vigencia (\d{4}-\d{2}-\d{2})/;

class TimeoutError extends Error {}
class SourceError extends Error {}

interface ToolResult {
  structured: Record<string, unknown>;
  text: string;
}

/** A valid rate is a finite number, at least 0.01 and with at most 2 decimals (EC-M3-04). */
function toValidRate(raw: unknown): Decimal | null {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null;
  const value = new Decimal(raw);
  if (value.lt(MIN_RATE) || value.decimalPlaces() > 2) return null;
  return value;
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

export function createParaleloBoGateway(opts: ParaleloBoOptions): RatesGateway {
  const doFetch = opts.fetch ?? fetch;
  const now = opts.now ?? (() => new Date());

  async function callTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new TimeoutError('timeout'));
      }, opts.timeoutMs);
    });
    const work = (async (): Promise<ToolResult> => {
      let res: Response;
      try {
        res = await doFetch(opts.url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: { name, arguments: args },
          }),
          signal: controller.signal,
        });
      } catch {
        throw new SourceError('network');
      }
      if (res.status !== 200) throw new SourceError('http');
      let json: unknown;
      try {
        json = await res.json();
      } catch {
        throw new SourceError('json');
      }
      if (!isRecord(json) || json['error'] !== undefined || !isRecord(json['result'])) {
        throw new SourceError('rpc');
      }
      const result = json['result'];
      if (result['isError'] === true) throw new SourceError('tool');
      const structured = isRecord(result['structuredContent']) ? result['structuredContent'] : {};
      const content = result['content'];
      const first: unknown = Array.isArray(content) ? content[0] : undefined;
      const text = isRecord(first) && typeof first['text'] === 'string' ? first['text'] : '';
      return { structured, text };
    })();
    try {
      return await Promise.race([work, timeout]);
    } finally {
      clearTimeout(timer);
      work.catch(() => undefined);
    }
  }

  async function run<T>(
    name: string,
    args: Record<string, unknown>,
    parse: (r: ToolResult) => T | null,
  ): Promise<RateResult<T>> {
    try {
      const value = parse(await callTool(name, args));
      return value === null ? { ok: false, reason: 'INVALID_VALUE' } : { ok: true, value };
    } catch (error) {
      return { ok: false, reason: error instanceof TimeoutError ? 'TIMEOUT' : 'SOURCE_ERROR' };
    }
  }

  return {
    fetchParallel() {
      return run<ParallelQuote>('get_current_rate', {}, ({ structured }) => {
        const median = toValidRate(structured['median']);
        if (!median) return null;
        const buy = toValidRate(structured['buy']);
        const sell = toValidRate(structured['sell']);
        const sides = buy && sell ? classifyBidAsk(buy, sell) : null;
        const ts = typeof structured['timestamp'] === 'string' ? new Date(structured['timestamp']) : null;
        const observedAt = ts && !Number.isNaN(ts.getTime()) ? ts : now();
        return { median, bid: sides?.bid ?? null, ask: sides?.ask ?? null, observedAt };
      });
    },
    fetchOfficial() {
      return run<OfficialQuote>(
        'convert_currency',
        { amount: 1, from: 'USD', to: 'BOB', direction: 'official' },
        ({ structured, text }) => {
          const value = toValidRate(structured['rate']);
          if (!value) return null;
          const effectiveDate = EFFECTIVE_DATE.exec(text)?.[1] ?? null;
          return { value, effectiveDate, observedAt: now() };
        },
      );
    },
    fetchParallelOn(date: LocalDate) {
      return run<{ median: Decimal; date: LocalDate }>(
        'get_historical_rate',
        { date },
        ({ structured }) => {
          if (structured['illustrative'] === true) return null;
          const median = toValidRate(structured['median']);
          if (!median) return null;
          const day = typeof structured['date'] === 'string' ? structured['date'] : date;
          return { median, date: day };
        },
      );
    },
  };
}
