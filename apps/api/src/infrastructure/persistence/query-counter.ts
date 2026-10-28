import { AsyncLocalStorage } from 'node:async_hooks';

import type { QueryCount, QueryCounter } from '../../application/ports/query-counter.js';

/**
 * `QueryCounter` over `AsyncLocalStorage` (plan §4.0): each request gets its own store when it
 * begins, so concurrent requests keep separate counts. Outside a request there is no store and
 * `record` is ignored.
 */
export function createQueryCounter(): QueryCounter {
  const storage = new AsyncLocalStorage<QueryCount>();
  return {
    begin(): void {
      storage.enterWith({ queries: 0, dbMs: 0 });
    },
    record(ms: number): void {
      const count = storage.getStore();
      if (count === undefined) return;
      count.queries += 1;
      count.dbMs += ms;
    },
    read(): QueryCount {
      const count = storage.getStore();
      return count === undefined ? { queries: 0, dbMs: 0 } : { ...count };
    },
  };
}
