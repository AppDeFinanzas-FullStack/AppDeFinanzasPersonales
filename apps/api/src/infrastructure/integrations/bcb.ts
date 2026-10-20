import { Decimal } from 'decimal.js';

import type { LocalDate } from '../../application/ports/clock.js';
import type { OfficialQuote, RateResult, RatesGateway } from '../../application/ports/rates-gateway.js';

export interface BcbOptions {
  url: string;
  timeoutMs: number;
  fetch?: typeof fetch;
  now?: () => Date;
}

const MIN_RATE = new Decimal('0.01');
const VALUE_ELEMENT = /<div[^>]*class="tco-public-value"[^>]*>([\s\S]*?)<\/div>/i;
const VALUE_NUMBER = /(\d+(?:,\d+)?)/;
const VIGENCIA_ELEMENT = /<span[^>]*class="tco-public-vigencia"[^>]*>([\s\S]*?)<\/span>/i;
const FIRST_DATE = /(\d{1,2})\s+de\s+([a-z]+)\s+de\s+(\d{4})/;

const MONTHS: Record<string, string> = {
  enero: '01',
  febrero: '02',
  marzo: '03',
  abril: '04',
  mayo: '05',
  junio: '06',
  julio: '07',
  agosto: '08',
  septiembre: '09',
  setiembre: '09',
  octubre: '10',
  noviembre: '11',
  diciembre: '12',
};

class TimeoutError extends Error {}
class SourceError extends Error {}

/** A valid rate is at least 0.01 with at most 2 decimals (EC-M3-04). */
function toValidRate(raw: string): Decimal | null {
  const match = VALUE_NUMBER.exec(raw);
  if (!match?.[1]) return null;
  const value = new Decimal(match[1].replace(',', '.'));
  if (value.lt(MIN_RATE) || value.decimalPlaces() > 2) return null;
  return value;
}

function parseEffectiveDate(html: string): LocalDate | null {
  const element = VIGENCIA_ELEMENT.exec(html)?.[1];
  if (!element) return null;
  const text = element
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
  const match = FIRST_DATE.exec(text);
  if (!match?.[1] || !match[2] || !match[3]) return null;
  const month = MONTHS[match[2]];
  if (!month) return null;
  return `${match[3]}-${month}-${match[1].padStart(2, '0')}`;
}

export function createBcbGateway(opts: BcbOptions): Pick<RatesGateway, 'fetchOfficial'> {
  const doFetch = opts.fetch ?? fetch;
  const now = opts.now ?? (() => new Date());

  async function getHtml(): Promise<string> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new TimeoutError('timeout'));
      }, opts.timeoutMs);
    });
    const work = (async (): Promise<string> => {
      let res: Response;
      try {
        res = await doFetch(opts.url, { method: 'GET', signal: controller.signal });
      } catch {
        throw new SourceError('network');
      }
      if (res.status !== 200) throw new SourceError('http');
      try {
        return await res.text();
      } catch {
        throw new SourceError('body');
      }
    })();
    try {
      return await Promise.race([work, timeout]);
    } finally {
      clearTimeout(timer);
      work.catch(() => undefined);
    }
  }

  return {
    async fetchOfficial(): Promise<RateResult<OfficialQuote>> {
      try {
        const html = await getHtml();
        const raw = VALUE_ELEMENT.exec(html)?.[1];
        if (raw === undefined) return { ok: false, reason: 'SOURCE_ERROR' };
        const value = toValidRate(raw);
        if (!value) return { ok: false, reason: 'INVALID_VALUE' };
        return {
          ok: true,
          value: { value, effectiveDate: parseEffectiveDate(html), observedAt: now() },
        };
      } catch (error) {
        return { ok: false, reason: error instanceof TimeoutError ? 'TIMEOUT' : 'SOURCE_ERROR' };
      }
    },
  };
}
