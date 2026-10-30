import { Prisma, PrismaClient } from '@prisma/client';

/**
 * Global models without `user_id` (ADR-12, plan §3.3 and §3.7). A user-scoped client passes their
 * queries through untouched.
 */
const GLOBAL_MODELS: ReadonlySet<string> = new Set<Prisma.ModelName>([
  'MarketRate',
  'JobRun',
  'EmailOutbox',
  'LoginThrottle',
  'EmailSendLog',
]);

/** Models whose rows belong to a user through their `userId` column (ADR-05). */
const OWNED_MODELS: ReadonlySet<string> = new Set(
  Prisma.dmmf.datamodel.models
    .filter((model) => model.fields.some((field) => field.name === 'userId'))
    .map((model) => model.name),
);

/** Operations whose `data` must carry the scoped user's id. */
const CREATE_OPERATIONS: ReadonlySet<string> = new Set([
  'create',
  'createMany',
  'createManyAndReturn',
]);

/** Operations whose `where` gets the scoped user's filter. */
const FILTERED_OPERATIONS: ReadonlySet<string> = new Set([
  'findUnique',
  'findUniqueOrThrow',
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'count',
  'aggregate',
  'groupBy',
  'update',
  'updateMany',
  'updateManyAndReturn',
  'upsert',
  'delete',
  'deleteMany',
]);

/** Operations whose `data` may not hand a row over to another user. */
const UPDATE_OPERATIONS: ReadonlySet<string> = new Set([
  'update',
  'updateMany',
  'updateManyAndReturn',
]);

type QueryArgs = Record<string, unknown>;

const asArgs = (value: unknown): QueryArgs =>
  typeof value === 'object' && value !== null ? (value as QueryArgs) : {};

/** Adds `userId` to the filter without dropping any condition of the caller. */
function scopeWhere(where: unknown, userId: string): QueryArgs {
  if (where === undefined) return { userId };
  const filter = asArgs(where);
  const and = filter['AND'];
  const conditions: unknown[] = and === undefined ? [] : Array.isArray(and) ? and : [and];
  return { ...filter, AND: [...conditions, { userId }] };
}

const ownershipError = (model: string, operation: string): Error =>
  new Error(`${model}.${operation}: data.userId must be the id of the scoped user`);

/** Every created row must carry the scoped user's id. */
function assertCreatesOwnRows(
  data: unknown,
  userId: string,
  model: string,
  operation: string,
): void {
  const rows: unknown[] = Array.isArray(data) ? data : [data];
  if (rows.some((row) => asArgs(row)['userId'] !== userId)) {
    throw ownershipError(model, operation);
  }
}

/** An update may repeat the scoped user's id, never set another one. */
function assertKeepsOwner(data: unknown, userId: string, model: string, operation: string): void {
  const values = asArgs(data);
  if ('userId' in values && values['userId'] !== userId) {
    throw ownershipError(model, operation);
  }
}

function scopeArgs(model: string, operation: string, args: unknown, userId: string): QueryArgs {
  const input = asArgs(args);
  if (CREATE_OPERATIONS.has(operation)) {
    assertCreatesOwnRows(input['data'], userId, model, operation);
    return input;
  }
  if (!FILTERED_OPERATIONS.has(operation)) {
    throw new Error(`${model}.${operation} is not available on a user-scoped client`);
  }
  if (UPDATE_OPERATIONS.has(operation)) {
    assertKeepsOwner(input['data'], userId, model, operation);
  }
  if (operation === 'upsert') {
    assertCreatesOwnRows(input['create'], userId, model, operation);
    assertKeepsOwner(input['update'], userId, model, operation);
  }
  return { ...input, where: scopeWhere(input['where'], userId) };
}

/** Measurement of every Prisma operation (plan §4.0, RNF-29). */
export interface OperationOptions {
  /** Milliseconds each operation waits before it runs; reproduces the distance to the database. */
  latencyMs?: number;
  /** Called after each operation, raw or of a model, with the milliseconds it took. */
  onOperation?: (ms: number) => void;
}

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Creates a Prisma client over the given database. With `latencyMs` or `onOperation`, every
 * operation (raw and of a model) is delayed and reported through a client extension, which keeps
 * the request context that the `query` event of Prisma does not.
 */
export const createPrismaClient = (
  databaseUrl: string,
  options: OperationOptions = {},
): PrismaClient => {
  const client = new PrismaClient({ datasourceUrl: databaseUrl });
  const { latencyMs = 0, onOperation } = options;
  if (latencyMs === 0 && onOperation === undefined) return client;
  // The extension adds no models or methods, so the extended client is used as a plain one.
  return client.$extends({
    name: 'measure',
    query: {
      async $allOperations({ args, query }) {
        const start = performance.now();
        try {
          if (latencyMs > 0) await wait(latencyMs);
          const result: unknown = await query(args);
          return result;
        } finally {
          onOperation?.(performance.now() - start);
        }
      },
    },
  }) as unknown as PrismaClient;
};

/**
 * Isolation extension (ADR-05, RN-09, RNF-14). Adds `userId` to the filter of every read, update,
 * delete and count, and rejects any create whose `data.userId` is not `userId`, so a foreign row
 * behaves as a missing one. Global models are exempt; any other model without `user_id` is
 * rejected.
 */
export function forUser(prisma: PrismaClient, userId: string) {
  return prisma.$extends({
    name: 'forUser',
    query: {
      $allModels: {
        $allOperations({ model, operation, args, query }) {
          if (GLOBAL_MODELS.has(model)) return query(args);
          if (!OWNED_MODELS.has(model)) {
            throw new Error(`${model} has no user_id and is not available on a user-scoped client`);
          }
          return query(scopeArgs(model, operation, args, userId));
        },
      },
    },
  });
}

/** Client returned by `forUser`: every model query is bound to one user. */
export type ScopedPrismaClient = ReturnType<typeof forUser>;
