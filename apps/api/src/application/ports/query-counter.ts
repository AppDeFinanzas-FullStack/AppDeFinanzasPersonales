/** What one request spent on the database: operations and milliseconds waiting for them. */
export interface QueryCount {
  queries: number;
  dbMs: number;
}

/**
 * Cost of a request in database trips (plan §4.0, RNF-29). `begin` opens the count of the request
 * that is starting, `record` adds one operation that took `ms`, and `read` returns what the current
 * request has spent so far. Counts of requests in flight never mix.
 */
export interface QueryCounter {
  begin(): void;
  record(ms: number): void;
  read(): QueryCount;
}
