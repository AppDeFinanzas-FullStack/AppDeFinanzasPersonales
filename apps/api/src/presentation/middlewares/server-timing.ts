import type { RequestHandler, Response } from 'express';

import type { QueryCounter } from '../../application/ports/query-counter.js';

/** Milliseconds with one decimal; the header carries numbers only (RNF-17). */
const ms = (value: number): string => value.toFixed(1);

/**
 * Opens the request's query count and adds `Server-Timing: total, db, queries` to the response
 * right before its headers go out, so every answer carries it, errors included (plan §4.0,
 * RNF-29). The numbers also go to `res.locals.queries` for the request log.
 */
export const serverTiming =
  (counter: QueryCounter): RequestHandler =>
  (_req, res, next) => {
    const start = process.hrtime.bigint();
    counter.begin();

    const writeHead = res.writeHead.bind(res) as (...args: unknown[]) => Response;
    res.writeHead = function (this: Response, ...args: unknown[]): Response {
      if (!this.headersSent) {
        const { queries, dbMs } = counter.read();
        const total = Number(process.hrtime.bigint() - start) / 1e6;
        this.locals['queries'] = queries;
        this.setHeader(
          'Server-Timing',
          `total;dur=${ms(total)}, db;dur=${ms(dbMs)}, queries;desc="${String(queries)}"`,
        );
      }
      return writeHead(...args);
    } as typeof res.writeHead;
    next();
  };
