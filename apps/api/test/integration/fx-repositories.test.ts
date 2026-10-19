import { Decimal } from 'decimal.js';
import { uuidv7 } from 'uuidv7';
import { afterAll, describe, expect, it } from 'vitest';

import type { Repositories } from '../../src/application/ports/repositories.js';
import type { UnitOfWork } from '../../src/application/ports/unit-of-work.js';
import { createCurrencyRepository } from '../../src/infrastructure/persistence/repositories/currency.repository.js';
import { createMarketRateRepository } from '../../src/infrastructure/persistence/repositories/market-rate.repository.js';
import { createUserFxEventRepository } from '../../src/infrastructure/persistence/repositories/user-fx-event.repository.js';
import { createUnitOfWork } from '../../src/infrastructure/persistence/unit-of-work.js';
import { createUser, deleteCreatedUsers } from '../factories/user.factory.js';
import { disconnectTestPrisma, testPrisma } from './setup/db.js';

/**
 * The plan fixes the operations of each repository (tasks.md, TASK-083) but not the names of their
 * factories nor their row shapes. These tests assume:
 * - `createMarketRateRepository(tx)`, `createCurrencyRepository(tx, userId)` and
 *   `createUserFxEventRepository(tx, userId)` build a repository over the client of a transaction;
 *   `Repositories` exposes them as `marketRates`, `currencies` and `userFxEvents`.
 * - Rates and values are `Decimal`, instants are `Date` and days are `YYYY-MM-DD` strings, like the
 *   `FxEvent` and `MarketSeries` types of the domain.
 * - `latest`, `get`, `lockForUpdate` and `lockForShare` return `null` when there is no row.
 * - The user comes from the `UnitOfWork` (`userLock`), never from an argument (constitution §4).
 */
const NIL_USER = '00000000-0000-0000-0000-000000000000';

const uow: UnitOfWork = createUnitOfWork(
  testPrisma(),
  (tx, userId): Repositories => ({
    marketRates: createMarketRateRepository(tx),
    currencies: createCurrencyRepository(tx, userId ?? NIL_USER),
    userFxEvents: createUserFxEventRepository(tx, userId ?? NIL_USER),
  }),
);

/** `market_rate` is global (ADR-12): every test writes days of year 2090 and the file removes them. */
const TEST_ERA = '2090-01-01';

afterAll(async () => {
  await testPrisma().$executeRaw`DELETE FROM market_rate WHERE rate_date >= ${TEST_ERA}::date`;
  await deleteCreatedUsers();
  await disconnectTestPrisma();
});

// ---------- Helpers ----------

const at = (iso: string) => new Date(iso);

const fixed = (value: Decimal | string | number): string => new Decimal(value).toFixed(2);

function rate(
  kind: 'parallel_bid' | 'parallel_ask' | 'parallel_median' | 'official',
  rateDate: string,
  value: string,
  observedAt: string,
  source: 'paralelo_bo' | 'bcb' | 'seed' = 'paralelo_bo',
) {
  return { kind, rateDate, value: new Decimal(value), observedAt: at(observedAt), source };
}

const withMarket = <T>(fn: (repos: Repositories) => Promise<T>) => uow.run(fn);

const withUser = <T>(userId: string, fn: (repos: Repositories) => Promise<T>) =>
  uow.run(fn, { userLock: userId });

/** Value, observation instant and source of a market day, read outside of any UnitOfWork. */
async function storedRate(kind: string, rateDate: string) {
  const rows = await testPrisma().$queryRaw<
    { value: string; observedAt: Date; source: string }[]
  >`
    SELECT value::text AS value, observed_at AS "observedAt", source::text AS source
      FROM market_rate WHERE kind = ${kind}::market_rate_kind AND rate_date = ${rateDate}::date`;
  return rows;
}

async function rowCount(kind: string, rateDate: string): Promise<number> {
  return (await storedRate(kind, rateDate)).length;
}

// ---------- market_rate ----------

describe('marketRates.upsertIfNewer', () => {
  it('RF-M3-13 un día sin dato se guarda con su valor, instante de observación y fuente', async () => {
    await withMarket((repos) =>
      repos.marketRates.upsertIfNewer(
        rate('official', '2090-01-05', '6.96', '2090-01-05T12:00:00Z', 'bcb'),
      ),
    );

    const rows = await storedRate('official', '2090-01-05');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.value).toBe('6.96');
    expect(rows[0]?.observedAt.toISOString()).toBe('2090-01-05T12:00:00.000Z');
    expect(rows[0]?.source).toBe('bcb');
  });

  it('RF-M3-13 una observación más reciente reemplaza el valor del día', async () => {
    await withMarket((repos) =>
      repos.marketRates.upsertIfNewer(
        rate('parallel_median', '2090-01-06', '9.50', '2090-01-06T10:00:00Z'),
      ),
    );

    await withMarket((repos) =>
      repos.marketRates.upsertIfNewer(
        rate('parallel_median', '2090-01-06', '9.80', '2090-01-06T15:00:00Z', 'seed'),
      ),
    );

    const rows = await storedRate('parallel_median', '2090-01-06');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.value).toBe('9.80');
    expect(rows[0]?.observedAt.toISOString()).toBe('2090-01-06T15:00:00.000Z');
    expect(rows[0]?.source).toBe('seed');
  });

  it('RF-M3-13 una observación más antigua no reemplaza el valor del día', async () => {
    await withMarket((repos) =>
      repos.marketRates.upsertIfNewer(
        rate('parallel_median', '2090-01-07', '9.80', '2090-01-07T15:00:00Z'),
      ),
    );

    await withMarket((repos) =>
      repos.marketRates.upsertIfNewer(
        rate('parallel_median', '2090-01-07', '9.50', '2090-01-07T10:00:00Z', 'seed'),
      ),
    );

    const rows = await storedRate('parallel_median', '2090-01-07');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.value).toBe('9.80');
    expect(rows[0]?.observedAt.toISOString()).toBe('2090-01-07T15:00:00.000Z');
    expect(rows[0]?.source).toBe('paralelo_bo');
  });

  it('RF-M3-13 una observación del mismo instante no reemplaza el valor del día', async () => {
    await withMarket((repos) =>
      repos.marketRates.upsertIfNewer(
        rate('parallel_ask', '2090-01-08', '9.90', '2090-01-08T12:00:00Z'),
      ),
    );

    await withMarket((repos) =>
      repos.marketRates.upsertIfNewer(
        rate('parallel_ask', '2090-01-08', '9.99', '2090-01-08T12:00:00Z'),
      ),
    );

    const rows = await storedRate('parallel_ask', '2090-01-08');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.value).toBe('9.90');
  });

  it('RF-M3-13 repetir la misma observación deja una sola fila (idempotente)', async () => {
    const observation = rate('parallel_bid', '2090-01-09', '9.40', '2090-01-09T12:00:00Z');

    await withMarket((repos) => repos.marketRates.upsertIfNewer(observation));
    await withMarket((repos) => repos.marketRates.upsertIfNewer(observation));

    expect(await rowCount('parallel_bid', '2090-01-09')).toBe(1);
  });

  it('RF-M3-13 la tasa de un día no afecta a otro día ni a otro tipo de tasa', async () => {
    await withMarket(async (repos) => {
      await repos.marketRates.upsertIfNewer(
        rate('parallel_median', '2090-01-10', '9.50', '2090-01-10T12:00:00Z'),
      );
      await repos.marketRates.upsertIfNewer(
        rate('parallel_median', '2090-01-11', '9.60', '2090-01-11T12:00:00Z'),
      );
      await repos.marketRates.upsertIfNewer(
        rate('official', '2090-01-10', '6.96', '2090-01-10T08:00:00Z', 'bcb'),
      );
    });

    expect((await storedRate('parallel_median', '2090-01-10'))[0]?.value).toBe('9.50');
    expect((await storedRate('parallel_median', '2090-01-11'))[0]?.value).toBe('9.60');
    expect((await storedRate('official', '2090-01-10'))[0]?.value).toBe('6.96');
  });
});

describe('marketRates.latest', () => {
  it('RF-M3-13 latest(kind) devuelve la fila del día más reciente de ese tipo', async () => {
    await withMarket(async (repos) => {
      await repos.marketRates.upsertIfNewer(
        rate('official', '2099-06-01', '7.00', '2099-06-01T12:00:00Z', 'bcb'),
      );
      await repos.marketRates.upsertIfNewer(
        rate('official', '2099-06-03', '7.20', '2099-06-03T12:00:00Z', 'bcb'),
      );
      await repos.marketRates.upsertIfNewer(
        rate('official', '2099-06-02', '7.10', '2099-06-04T12:00:00Z', 'bcb'),
      );
      await repos.marketRates.upsertIfNewer(
        rate('parallel_median', '2099-06-09', '10.00', '2099-06-09T12:00:00Z'),
      );
    });

    const latest = await withMarket((repos) => repos.marketRates.latest('official'));

    expect(latest).not.toBeNull();
    expect(latest?.rateDate).toBe('2099-06-03');
    expect(fixed(latest?.value ?? 0)).toBe('7.20');
    expect(latest?.observedAt.toISOString()).toBe('2099-06-03T12:00:00.000Z');
  });
});

describe('marketRates.series', () => {
  it('RF-M3-13 series(kind, from, to) devuelve los días del rango, ambos extremos incluidos, en orden', async () => {
    await withMarket(async (repos) => {
      for (const [day, value] of [
        ['2090-03-01', '8.00'],
        ['2090-03-02', '8.10'],
        ['2090-03-03', '8.20'],
        ['2090-03-04', '8.30'],
        ['2090-03-05', '8.40'],
      ] as const) {
        await repos.marketRates.upsertIfNewer(
          rate('parallel_median', day, value, `${day}T12:00:00Z`),
        );
      }
    });

    const series = await withMarket((repos) =>
      repos.marketRates.series('parallel_median', '2090-03-02', '2090-03-04'),
    );

    expect(series.map((row) => row.rateDate)).toEqual(['2090-03-02', '2090-03-03', '2090-03-04']);
    expect(series.map((row) => fixed(row.value))).toEqual(['8.10', '8.20', '8.30']);
  });

  it('RF-M3-13 series solo trae el tipo de tasa pedido', async () => {
    await withMarket(async (repos) => {
      await repos.marketRates.upsertIfNewer(
        rate('parallel_median', '2090-04-01', '9.00', '2090-04-01T12:00:00Z'),
      );
      await repos.marketRates.upsertIfNewer(
        rate('official', '2090-04-01', '6.96', '2090-04-01T12:00:00Z', 'bcb'),
      );
    });

    const series = await withMarket((repos) =>
      repos.marketRates.series('official', '2090-04-01', '2090-04-30'),
    );

    expect(series.map((row) => fixed(row.value))).toEqual(['6.96']);
  });

  it('RF-M3-13 series devuelve una lista vacía si el rango no tiene días', async () => {
    const series = await withMarket((repos) =>
      repos.marketRates.series('official', '2090-12-01', '2090-12-31'),
    );

    expect(series).toEqual([]);
  });
});

// ---------- currency ----------

describe('currencies', () => {
  it('TASK-083 list devuelve las monedas del usuario, con las de sistema BOB y USD', async () => {
    const user = await createUser();

    const list = await withUser(user.id, (repos) => repos.currencies.list());

    expect(list.map((currency) => currency.code).sort()).toEqual(['BOB', 'USD']);
    expect(list.find((currency) => currency.code === 'BOB')).toMatchObject({
      symbol: 'Bs',
      isSystem: true,
      status: 'active',
    });
  });

  it('TASK-083 insert agrega una moneda al usuario y get la devuelve', async () => {
    const user = await createUser();

    await withUser(user.id, (repos) => repos.currencies.insert({ code: 'EUR', symbol: '€' }));

    const eur = await withUser(user.id, (repos) => repos.currencies.get('EUR'));
    expect(eur).toMatchObject({ code: 'EUR', symbol: '€', isSystem: false, status: 'active' });
    const list = await withUser(user.id, (repos) => repos.currencies.list());
    expect(list.map((currency) => currency.code).sort()).toEqual(['BOB', 'EUR', 'USD']);
  });

  it('TASK-083 insert de un código que el usuario ya tiene falla', async () => {
    const user = await createUser();

    await expect(
      withUser(user.id, (repos) => repos.currencies.insert({ code: 'USD', symbol: '$' })),
    ).rejects.toThrow();
  });

  it('TASK-083 get de un código que el usuario no tiene devuelve null', async () => {
    const user = await createUser();

    expect(await withUser(user.id, (repos) => repos.currencies.get('EUR'))).toBeNull();
  });

  it('TASK-083 lockForUpdate devuelve la moneda y bloquea su fila contra otras transacciones', async () => {
    const user = await createUser();
    await withUser(user.id, (repos) => repos.currencies.insert({ code: 'EUR', symbol: '€' }));

    const outcome = await withUser(user.id, async (repos) => {
      const locked = await repos.currencies.lockForUpdate('EUR');
      const forUpdate = await tryLock(user.id, 'FOR UPDATE');
      const forShare = await tryLock(user.id, 'FOR SHARE');
      return { locked, forUpdate, forShare };
    });

    expect(outcome.locked).toMatchObject({ code: 'EUR', symbol: '€' });
    expect(outcome.forUpdate).toBe('blocked');
    expect(outcome.forShare).toBe('blocked');
    expect(await tryLock(user.id, 'FOR UPDATE')).toBe('free');
  });

  it('TASK-083 lockForShare devuelve la moneda y deja leer a otros pero impide modificarla', async () => {
    const user = await createUser();
    await withUser(user.id, (repos) => repos.currencies.insert({ code: 'EUR', symbol: '€' }));

    const outcome = await withUser(user.id, async (repos) => {
      const locked = await repos.currencies.lockForShare('EUR');
      const forShare = await tryLock(user.id, 'FOR SHARE');
      const forUpdate = await tryLock(user.id, 'FOR UPDATE');
      return { locked, forShare, forUpdate };
    });

    expect(outcome.locked).toMatchObject({ code: 'EUR', symbol: '€' });
    expect(outcome.forShare).toBe('free');
    expect(outcome.forUpdate).toBe('blocked');
  });

  it('TASK-083 lockForUpdate y lockForShare de una moneda inexistente devuelven null', async () => {
    const user = await createUser();

    const [forUpdate, forShare] = await withUser(user.id, async (repos) => [
      await repos.currencies.lockForUpdate('EUR'),
      await repos.currencies.lockForShare('EUR'),
    ]);

    expect(forUpdate).toBeNull();
    expect(forShare).toBeNull();
  });
});

/** Tries to lock the EUR row of a user from another connection, without waiting. */
async function tryLock(userId: string, mode: 'FOR UPDATE' | 'FOR SHARE'): Promise<string> {
  const query = `SELECT code FROM currency WHERE user_id = '${userId}'::uuid AND code = 'EUR' ${mode} NOWAIT`;
  try {
    await testPrisma().$queryRawUnsafe(query);
    return 'free';
  } catch {
    return 'blocked';
  }
}

describe('currencies aislamiento', () => {
  it('RN-09 la moneda que agrega un usuario no aparece en la lista de otro', async () => {
    const [ana, beto] = await Promise.all([createUser(), createUser()]);
    await withUser(beto.id, (repos) => repos.currencies.insert({ code: 'EUR', symbol: '€' }));

    const list = await withUser(ana.id, (repos) => repos.currencies.list());

    expect(list.map((currency) => currency.code).sort()).toEqual(['BOB', 'USD']);
  });

  it('RN-09 get, lockForUpdate y lockForShare de la moneda de otro usuario se comportan como inexistentes', async () => {
    const [ana, beto] = await Promise.all([createUser(), createUser()]);
    await withUser(beto.id, (repos) => repos.currencies.insert({ code: 'EUR', symbol: '€' }));

    const [got, forUpdate, forShare] = await withUser(ana.id, async (repos) => [
      await repos.currencies.get('EUR'),
      await repos.currencies.lockForUpdate('EUR'),
      await repos.currencies.lockForShare('EUR'),
    ]);

    expect(got).toBeNull();
    expect(forUpdate).toBeNull();
    expect(forShare).toBeNull();
  });

  it('RN-09 dos usuarios pueden tener la misma moneda sin verse entre sí', async () => {
    const [ana, beto] = await Promise.all([createUser(), createUser()]);

    await withUser(ana.id, (repos) => repos.currencies.insert({ code: 'EUR', symbol: '€' }));
    await withUser(beto.id, (repos) => repos.currencies.insert({ code: 'EUR', symbol: 'E' }));

    expect((await withUser(ana.id, (repos) => repos.currencies.get('EUR')))?.symbol).toBe('€');
    expect((await withUser(beto.id, (repos) => repos.currencies.get('EUR')))?.symbol).toBe('E');
  });
});

// ---------- user_fx_event ----------

describe('userFxEvents', () => {
  it('RF-M3-13 insert guarda cada cambio del usuario y eventsUntil lo devuelve', async () => {
    const user = await createUser();
    await withUser(user.id, async (repos) => {
      await repos.currencies.insert({ code: 'EUR', symbol: '€' });
      await repos.userFxEvents.insert({
        id: uuidv7(),
        kind: 'reference_set',
        currencyCode: null,
        reference: 'official',
        value: null,
        effectiveAt: at('2090-05-01T10:00:00Z'),
      });
      await repos.userFxEvents.insert({
        id: uuidv7(),
        kind: 'manual_usd_on',
        currencyCode: 'USD',
        reference: null,
        value: new Decimal('9.30'),
        effectiveAt: at('2090-05-02T10:00:00Z'),
      });
      await repos.userFxEvents.insert({
        id: uuidv7(),
        kind: 'custom_rate',
        currencyCode: 'EUR',
        reference: null,
        value: new Decimal('10.80'),
        effectiveAt: at('2090-05-03T10:00:00Z'),
      });
    });

    const events = await withUser(user.id, (repos) =>
      repos.userFxEvents.eventsUntil(at('2090-06-01T00:00:00Z')),
    );

    const sorted = [...events].sort((a, b) => a.effectiveAt.getTime() - b.effectiveAt.getTime());
    expect(sorted.map((event) => event.kind)).toEqual([
      'reference_set',
      'manual_usd_on',
      'custom_rate',
    ]);
    expect(sorted[0]).toMatchObject({ currencyCode: null, reference: 'official', value: null });
    expect(sorted[1]).toMatchObject({ currencyCode: 'USD', reference: null });
    expect(fixed(sorted[1]?.value ?? 0)).toBe('9.30');
    expect(sorted[2]).toMatchObject({ currencyCode: 'EUR', reference: null });
    expect(fixed(sorted[2]?.value ?? 0)).toBe('10.80');
    expect(sorted[2]?.effectiveAt.toISOString()).toBe('2090-05-03T10:00:00.000Z');
  });

  it('RF-M3-13 eventsUntil(instant) no devuelve los eventos posteriores al instante', async () => {
    const user = await createUser();
    await withUser(user.id, async (repos) => {
      await repos.userFxEvents.insert({
        id: uuidv7(),
        kind: 'manual_usd_on',
        currencyCode: 'USD',
        reference: null,
        value: new Decimal('9.30'),
        effectiveAt: at('2090-05-01T10:00:00Z'),
      });
      await repos.userFxEvents.insert({
        id: uuidv7(),
        kind: 'manual_usd_off',
        currencyCode: 'USD',
        reference: null,
        value: null,
        effectiveAt: at('2090-05-10T10:00:00Z'),
      });
    });

    const events = await withUser(user.id, (repos) =>
      repos.userFxEvents.eventsUntil(at('2090-05-05T00:00:00Z')),
    );

    expect(events.map((event) => event.kind)).toEqual(['manual_usd_on']);
  });

  it('RF-M3-13 eventsUntil de un usuario sin eventos devuelve una lista vacía', async () => {
    const user = await createUser();

    const events = await withUser(user.id, (repos) =>
      repos.userFxEvents.eventsUntil(at('2090-06-01T00:00:00Z')),
    );

    expect(events).toEqual([]);
  });

  it('RN-09 los eventos de un usuario no son visibles para otro', async () => {
    const [ana, beto] = await Promise.all([createUser(), createUser()]);
    await withUser(beto.id, async (repos) => {
      await repos.currencies.insert({ code: 'EUR', symbol: '€' });
      await repos.userFxEvents.insert({
        id: uuidv7(),
        kind: 'custom_rate',
        currencyCode: 'EUR',
        reference: null,
        value: new Decimal('10.80'),
        effectiveAt: at('2090-05-03T10:00:00Z'),
      });
      await repos.userFxEvents.insert({
        id: uuidv7(),
        kind: 'manual_usd_on',
        currencyCode: 'USD',
        reference: null,
        value: new Decimal('9.30'),
        effectiveAt: at('2090-05-04T10:00:00Z'),
      });
    });

    const anaEvents = await withUser(ana.id, (repos) =>
      repos.userFxEvents.eventsUntil(at('2090-06-01T00:00:00Z')),
    );
    const betoEvents = await withUser(beto.id, (repos) =>
      repos.userFxEvents.eventsUntil(at('2090-06-01T00:00:00Z')),
    );

    expect(anaEvents).toEqual([]);
    expect(betoEvents).toHaveLength(2);
  });

  it('RN-09 un usuario no puede registrar un evento sobre la moneda de otro', async () => {
    const [ana, beto] = await Promise.all([createUser(), createUser()]);
    await withUser(beto.id, (repos) => repos.currencies.insert({ code: 'EUR', symbol: '€' }));

    await expect(
      withUser(ana.id, (repos) =>
        repos.userFxEvents.insert({
          id: uuidv7(),
          kind: 'custom_rate',
          currencyCode: 'EUR',
          reference: null,
          value: new Decimal('10.80'),
          effectiveAt: at('2090-05-03T10:00:00Z'),
        }),
      ),
    ).rejects.toThrow();
  });
});
