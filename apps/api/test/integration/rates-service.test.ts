import { Decimal } from 'decimal.js';
import { uuidv7 } from 'uuidv7';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { UnitOfWork } from '../../src/application/ports/unit-of-work.js';
import { createRatesService } from '../../src/application/services/rates.service.js';
import { createCurrencyRepository } from '../../src/infrastructure/persistence/repositories/currency.repository.js';
import { createMarketRateRepository } from '../../src/infrastructure/persistence/repositories/market-rate.repository.js';
import { createUserFxEventRepository } from '../../src/infrastructure/persistence/repositories/user-fx-event.repository.js';
import { createUserSettingsRepository } from '../../src/infrastructure/persistence/repositories/user-settings.repository.js';
import { createUnitOfWork } from '../../src/infrastructure/persistence/unit-of-work.js';
import { createUser, deleteCreatedUsers } from '../factories/user.factory.js';
import { disconnectTestPrisma, testPrisma } from './setup/db.js';

/**
 * The plan fixes the methods of `RatesService` (tasks.md, TASK-085), the `RatesCurrentDto` shape
 * (plan §4.3.1) and the request context `{ userId, timezone, now, traceId }` (plan §1.4), but not
 * how the service is built. These tests assume:
 * - `createRatesService({ uow })` builds it over the `UnitOfWork`.
 * - `current(ctx)` returns the `RatesCurrentDto`; `currentRateFor(ctx, code)` returns the current
 *   Bs per unit of `code` (`null` without any rate); `ratesForMovement(repos, ctx, code, date)`
 *   runs inside a transaction the caller opened (`uow.run` with `userLock`) and receives its
 *   `Repositories`.
 * - Rates may come back as decimal text or `Decimal`: the tests compare them at 2 decimals.
 * - The user's state is written in both places the plan keeps it: `user_settings`
 *   (`usd_reference`, `manual_usd_value`, `manual_usd_since`) and its `user_fx_event` rows.
 *
 * `market_rate` is global (ADR-12): the file saves its rows, empties the table before each test
 * and puts the rows back at the end. Integration files run one after another.
 */
const NIL_USER = '00000000-0000-0000-0000-000000000000';
const prisma = testPrisma();

const uow: UnitOfWork = createUnitOfWork(prisma, (tx, userId) => ({
  marketRates: createMarketRateRepository(tx),
  currencies: createCurrencyRepository(tx, userId ?? NIL_USER),
  userFxEvents: createUserFxEventRepository(tx, userId ?? NIL_USER),
  userSettings: createUserSettingsRepository(tx),
}));

const service = createRatesService({ uow });

const TZ = 'America/La_Paz';
const NOW = new Date('2090-06-15T16:00:00Z'); // 12:00 in La Paz
const TODAY = '2090-06-15';

type Kind = 'parallel_bid' | 'parallel_ask' | 'parallel_median' | 'official';
type Source = 'paralelo_bo' | 'bcb' | 'seed';

interface SavedRate {
  kind: string;
  rateDate: string;
  value: string;
  observedAt: Date;
  source: string;
}

let savedRates: SavedRate[] = [];

beforeAll(async () => {
  savedRates = await prisma.$queryRaw<SavedRate[]>`
    SELECT kind::text AS kind, rate_date::text AS "rateDate", value::text AS value,
           observed_at AS "observedAt", source::text AS source
      FROM market_rate`;
});

beforeEach(async () => {
  await prisma.$executeRaw`DELETE FROM market_rate`;
});

afterAll(async () => {
  await prisma.$executeRaw`DELETE FROM market_rate`;
  for (const row of savedRates) {
    await prisma.$executeRaw`
      INSERT INTO market_rate (kind, rate_date, value, observed_at, source)
      VALUES (${row.kind}::market_rate_kind, ${row.rateDate}::date, ${row.value}::numeric,
              ${row.observedAt}, ${row.source}::rate_source)`;
  }
  await deleteCreatedUsers();
  await disconnectTestPrisma();
});

// ---------- Helpers ----------

const fixed = (value: Decimal | string | number): string => new Decimal(value).toFixed(2);

const at = (iso: string) => new Date(iso);

function ctxFor(userId: string, now: Date = NOW) {
  return { userId, timezone: TZ, now, traceId: uuidv7() };
}

async function marketRate(
  kind: Kind,
  rateDate: string,
  value: string,
  observedAt: string,
  source: Source = 'paralelo_bo',
): Promise<void> {
  await prisma.$executeRaw`
    INSERT INTO market_rate (kind, rate_date, value, observed_at, source)
    VALUES (${kind}::market_rate_kind, ${rateDate}::date, ${value}::numeric,
            ${at(observedAt)}, ${source}::rate_source)`;
}

/** Parallel bid, ask and median and the official rate of today. */
async function marketToday(median = '10.40'): Promise<void> {
  await marketRate('parallel_bid', TODAY, '10.30', '2090-06-15T15:30:00Z');
  await marketRate('parallel_ask', TODAY, '10.50', '2090-06-15T15:30:00Z');
  await marketRate('parallel_median', TODAY, median, '2090-06-15T15:30:00Z');
  await marketRate('official', TODAY, '6.96', '2090-06-15T12:00:00Z', 'bcb');
}

async function fxEvent(
  userId: string,
  kind: 'reference_set' | 'manual_usd_on' | 'manual_usd_off' | 'custom_rate',
  currencyCode: string | null,
  reference: Kind | null,
  value: string | null,
  effectiveAt: Date,
): Promise<void> {
  await prisma.$executeRaw`
    INSERT INTO user_fx_event (id, user_id, kind, currency_code, reference, value, effective_at)
    VALUES (${uuidv7()}::uuid, ${userId}::uuid, ${kind}::fx_event_kind, ${currencyCode},
            ${reference}::market_rate_kind, ${value}::numeric, ${effectiveAt})`;
}

/** Activates the manual USD value, as `PUT /api/fx/manual` leaves it (plan §4.3.2). */
async function setManual(userId: string, value: string, since: Date): Promise<void> {
  await prisma.$executeRaw`
    UPDATE user_settings SET manual_usd_value = ${value}::numeric, manual_usd_since = ${since}
     WHERE user_id = ${userId}::uuid`;
  await fxEvent(userId, 'manual_usd_on', 'USD', null, value, since);
}

/** Changes the USD reference, as `PATCH /api/fx-settings` leaves it (plan §4.3.2). */
async function setReference(userId: string, reference: Kind, effectiveAt: Date): Promise<void> {
  await prisma.$executeRaw`
    UPDATE user_settings SET usd_reference = ${reference}::market_rate_kind
     WHERE user_id = ${userId}::uuid`;
  await fxEvent(userId, 'reference_set', null, reference, null, effectiveAt);
}

/** Adds a currency with its rate, as `POST /api/currencies` leaves it (plan §4.3.2). */
async function addCurrency(userId: string, code: string, rate: string, at: Date): Promise<void> {
  await prisma.$executeRaw`
    INSERT INTO currency (user_id, code, symbol) VALUES (${userId}::uuid, ${code}, ${code})`;
  await fxEvent(userId, 'custom_rate', code, null, rate, at);
}

function ratesForMovement(userId: string, currencyCode: string, date: string, now: Date = NOW) {
  return uow.run(
    (repos) => service.ratesForMovement(repos, ctxFor(userId, now), currencyCode, date),
    {
      userLock: userId,
    },
  );
}

// ---------- current ----------

describe('RatesService.current', () => {
  it('RF-M3-03 Valor manual con prioridad: con el manual en 10,00 y el paralelo en 10,40, inUse vale 10,00 y trae since', async () => {
    const user = await createUser();
    await marketToday('10.40');
    const since = at('2090-06-10T14:00:00Z');
    await setManual(user.id, '10.00', since);

    const current = await service.current(ctxFor(user.id));

    expect(current.inUse.kind).toBe('manual');
    expect(fixed(current.inUse.value ?? '0')).toBe('10.00');
    expect(current.inUse.since).toBeDefined();
    expect(new Date(current.inUse.since ?? '').toISOString()).toBe(since.toISOString());
    expect(fixed(current.references.parallel_median?.value ?? '0')).toBe('10.40');
  });

  it('RF-M3-03 sin valor manual, la referencia por defecto en uso es la mediana del paralelo', async () => {
    const user = await createUser();
    await marketToday('10.40');

    const current = await service.current(ctxFor(user.id));

    expect(current.inUse.kind).toBe('parallel_median');
    expect(fixed(current.inUse.value ?? '0')).toBe('10.40');
  });

  it('RF-M3-12 con el valor manual activo, la brecha compara el valor manual contra el oficial', async () => {
    const user = await createUser();
    await marketToday('10.40');
    await setManual(user.id, '10.00', at('2090-06-10T14:00:00Z'));

    const current = await service.current(ctxFor(user.id));

    expect(current.gap).not.toBeNull();
    expect(current.gap?.comparedKind).toBe('manual');
    // (10,00 − 6,96) ÷ 6,96 = 43,68 % · Bs 3,04
    expect(fixed(current.gap?.pct ?? '0')).toBe('43.68');
    expect(fixed(current.gap?.bs ?? '0')).toBe('3.04');
  });

  it('RF-M3-12 con el oficial en uso, la brecha compara la mediana del paralelo contra el oficial', async () => {
    const user = await createUser();
    await marketToday('10.40');
    await setReference(user.id, 'official', at('2090-06-12T14:00:00Z'));

    const current = await service.current(ctxFor(user.id));

    expect(current.inUse.kind).toBe('official');
    expect(fixed(current.inUse.value ?? '0')).toBe('6.96');
    expect(current.gap).not.toBeNull();
    expect(current.gap?.comparedKind).toBe('parallel_median');
    // (10,40 − 6,96) ÷ 6,96 = 49,43 % · Bs 3,44
    expect(fixed(current.gap?.pct ?? '0')).toBe('49.43');
    expect(fixed(current.gap?.bs ?? '0')).toBe('3.44');
  });

  it('RF-M3-12 con una referencia del paralelo en uso, la brecha compara esa referencia contra el oficial', async () => {
    const user = await createUser();
    await marketToday('10.40');
    await setReference(user.id, 'parallel_ask', at('2090-06-12T14:00:00Z'));

    const current = await service.current(ctxFor(user.id));

    expect(current.inUse.kind).toBe('parallel_ask');
    expect(fixed(current.inUse.value ?? '0')).toBe('10.50');
    expect(current.gap?.comparedKind).toBe('parallel_ask');
    // (10,50 − 6,96) ÷ 6,96 = 50,86 % · Bs 3,54
    expect(fixed(current.gap?.pct ?? '0')).toBe('50.86');
    expect(fixed(current.gap?.bs ?? '0')).toBe('3.54');
  });

  it('RF-M3-05 cada referencia trae su valor, el instante en que se observó y su fuente', async () => {
    const user = await createUser();
    await marketToday('10.40');

    const current = await service.current(ctxFor(user.id));

    const official = current.references.official;
    expect(official).not.toBeNull();
    expect(fixed(official?.value ?? '0')).toBe('6.96');
    expect(official?.source).toBe('bcb');
    expect(new Date(official?.observedAt ?? '').toISOString()).toBe('2090-06-15T12:00:00.000Z');

    const median = current.references.parallel_median;
    expect(fixed(median?.value ?? '0')).toBe('10.40');
    expect(median?.source).toBe('paralelo_bo');
    expect(new Date(median?.observedAt ?? '').toISOString()).toBe('2090-06-15T15:30:00.000Z');
    expect(fixed(current.references.parallel_bid?.value ?? '0')).toBe('10.30');
    expect(fixed(current.references.parallel_ask?.value ?? '0')).toBe('10.50');
  });

  it('EC-M3-02 sin ninguna tasa, inUse.value es null, la brecha es null y no hay referencias', async () => {
    const user = await createUser();

    const current = await service.current(ctxFor(user.id));

    expect(current.inUse.value).toBeNull();
    expect(current.gap).toBeNull();
    expect(current.references.parallel_bid).toBeNull();
    expect(current.references.parallel_ask).toBeNull();
    expect(current.references.parallel_median).toBeNull();
    expect(current.references.official).toBeNull();
  });

  it('TASK-085 un usuario nuevo tiene BOB como moneda base y USD como la otra moneda', async () => {
    const user = await createUser();
    await marketToday();

    const current = await service.current(ctxFor(user.id));

    expect(current.base).toBe('BOB');
    expect(current.other).toBe('USD');
  });

  it('TASK-085 el valor manual de otro usuario no cambia la tasa en uso (aislamiento)', async () => {
    const [ana, beto] = await Promise.all([createUser(), createUser()]);
    await marketToday('10.40');
    await setManual(beto.id, '12.00', at('2090-06-10T14:00:00Z'));

    const current = await service.current(ctxFor(ana.id));

    expect(current.inUse.kind).toBe('parallel_median');
    expect(fixed(current.inUse.value ?? '0')).toBe('10.40');
  });
});

// ---------- currentRateFor ----------

describe('RatesService.currentRateFor', () => {
  it('RN-05 Valor manual con prioridad: los saldos actuales siguen convirtiéndose con Bs 10,00', async () => {
    const user = await createUser();
    await marketToday('10.40');
    await setManual(user.id, '10.00', at('2090-06-10T14:00:00Z'));

    const rate = await service.currentRateFor(ctxFor(user.id), 'USD');

    expect(fixed(rate ?? '0')).toBe('10.00');
  });

  it('RN-05 sin valor manual, el dólar usa la referencia vigente', async () => {
    const user = await createUser();
    await marketToday('10.40');

    expect(fixed((await service.currentRateFor(ctxFor(user.id), 'USD')) ?? '0')).toBe('10.40');
  });

  it('RN-05 el boliviano vale 1,00 y una moneda agregada usa su tasa más reciente', async () => {
    const user = await createUser();
    await marketToday('10.40');
    await addCurrency(user.id, 'EUR', '11.00', at('2090-06-01T14:00:00Z'));
    await fxEvent(user.id, 'custom_rate', 'EUR', null, '11.50', at('2090-06-12T14:00:00Z'));

    expect(fixed((await service.currentRateFor(ctxFor(user.id), 'BOB')) ?? '0')).toBe('1.00');
    expect(fixed((await service.currentRateFor(ctxFor(user.id), 'EUR')) ?? '0')).toBe('11.50');
  });

  it('EC-M3-02 sin ninguna tasa, el dólar no tiene tasa vigente', async () => {
    const user = await createUser();

    expect(await service.currentRateFor(ctxFor(user.id), 'USD')).toBeNull();
  });
});

// ---------- ratesForMovement ----------

describe('RatesService.ratesForMovement', () => {
  it('RF-M3-06 un movimiento en BOB guarda igualmente la tasa boliviano-dólar', async () => {
    const user = await createUser();
    await marketToday('10.40');

    const rates = await ratesForMovement(user.id, 'BOB', TODAY);

    expect(fixed(rates.rateCurBob)).toBe('1.00');
    expect(rates.rateUsdBob).not.toBeNull();
    expect(fixed(rates.rateUsdBob ?? '0')).toBe('10.40');
  });

  it('RF-M3-06 un movimiento de hoy en USD guarda el valor manual activo como tasa de su moneda y boliviano-dólar', async () => {
    const user = await createUser();
    await marketToday('10.40');
    await setManual(user.id, '10.00', at('2090-06-10T14:00:00Z'));

    const rates = await ratesForMovement(user.id, 'USD', TODAY);

    expect(fixed(rates.rateCurBob)).toBe('10.00');
    expect(fixed(rates.rateUsdBob ?? '0')).toBe('10.00');
  });

  it('RN-04 un movimiento en una moneda agregada guarda su tasa frente al boliviano y la boliviano-dólar', async () => {
    const user = await createUser();
    await marketToday('10.40');
    await addCurrency(user.id, 'EUR', '11.20', at('2090-06-01T14:00:00Z'));

    const rates = await ratesForMovement(user.id, 'EUR', TODAY);

    expect(fixed(rates.rateCurBob)).toBe('11.20');
    expect(fixed(rates.rateUsdBob ?? '0')).toBe('10.40');
  });

  it('RF-M3-06 un movimiento con fecha pasada guarda las tasas del historial con el estado del usuario ese día', async () => {
    const user = await createUser();
    await marketRate('parallel_median', '2090-06-05', '9.50', '2090-06-05T15:00:00Z');
    await marketRate('official', '2090-06-05', '6.96', '2090-06-05T12:00:00Z', 'bcb');
    await marketToday('10.40');
    await setManual(user.id, '10.00', at('2090-06-10T14:00:00Z'));

    const usd = await ratesForMovement(user.id, 'USD', '2090-06-05');

    // The manual value was not active on 05/06: the median of that day applies.
    expect(fixed(usd.rateCurBob)).toBe('9.50');
    expect(fixed(usd.rateUsdBob ?? '0')).toBe('9.50');
  });

  it('RN-04 un movimiento con fecha pasada en una moneda agregada guarda la tasa que tenía ese día', async () => {
    const user = await createUser();
    await marketRate('parallel_median', '2090-06-05', '9.50', '2090-06-05T15:00:00Z');
    await marketToday('10.40');
    await addCurrency(user.id, 'EUR', '11.00', at('2090-06-01T14:00:00Z'));
    await fxEvent(user.id, 'custom_rate', 'EUR', null, '11.50', at('2090-06-12T14:00:00Z'));

    const rates = await ratesForMovement(user.id, 'EUR', '2090-06-05');

    expect(fixed(rates.rateCurBob)).toBe('11.00');
    expect(fixed(rates.rateUsdBob ?? '0')).toBe('9.50');
  });

  it('EC-M3-02 sin ninguna tasa, rateUsdBob es null y un movimiento en BOB igual tiene su tasa 1,00', async () => {
    const user = await createUser();

    const bob = await ratesForMovement(user.id, 'BOB', TODAY);

    expect(fixed(bob.rateCurBob)).toBe('1.00');
    expect(bob.rateUsdBob).toBeNull();
  });
});
