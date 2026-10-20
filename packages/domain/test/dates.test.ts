import { describe, expect, it } from 'vitest';
import { boliviaDay, clampDay, isFutureFor, startOfDayInstant, todayFor } from '../src/index.js';

// Conventions used by these tests (plan §4.0 `Clock`, plan contracts):
// - LocalDate is an ISO calendar day string 'YYYY-MM-DD'.
// - Instant is a JavaScript Date (what `Clock.now()` returns).

const LA_PAZ = 'America/La_Paz';
const MADRID = 'Europe/Madrid';
const SANTIAGO = 'America/Santiago';

const at = (iso: string): Date => new Date(iso);

// Pure UTC arithmetic over calendar days, independent of any time zone.
function shiftDay(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

function daysOfYear(year: number): string[] {
  const out: string[] = [];
  for (let day = `${year}-01-01`; day.startsWith(String(year)); day = shiftDay(day, 1)) out.push(day);
  return out;
}

describe('dates: todayFor e isFutureFor (RN-07, RNF-20)', () => {
  it('RN-07 America/La_Paz: el cruce de medianoche (UTC-4) cambia el día local', () => {
    expect(todayFor(LA_PAZ, at('2026-10-19T03:59:59.999Z'))).toBe('2026-10-18');
    expect(todayFor(LA_PAZ, at('2026-10-19T04:00:00.000Z'))).toBe('2026-10-19');
  });

  it('RN-07 America/La_Paz: el día siguiente es futuro un instante antes de medianoche y deja de serlo a medianoche', () => {
    expect(isFutureFor('2026-10-19', LA_PAZ, at('2026-10-19T03:59:59.999Z'))).toBe(true);
    expect(isFutureFor('2026-10-19', LA_PAZ, at('2026-10-19T04:00:00.000Z'))).toBe(false);
  });

  it('RN-07 Europe/Madrid: el cruce de medianoche (CEST, UTC+2) cambia el día local', () => {
    expect(todayFor(MADRID, at('2026-10-18T21:59:59.999Z'))).toBe('2026-10-18');
    expect(todayFor(MADRID, at('2026-10-18T22:00:00.000Z'))).toBe('2026-10-19');
    expect(isFutureFor('2026-10-19', MADRID, at('2026-10-18T21:59:59.999Z'))).toBe(true);
    expect(isFutureFor('2026-10-19', MADRID, at('2026-10-18T22:00:00.000Z'))).toBe(false);
  });

  it('RN-07 Europe/Madrid: el cruce de medianoche en horario de invierno (CET, UTC+1)', () => {
    expect(isFutureFor('2026-12-01', MADRID, at('2026-11-30T22:59:59.999Z'))).toBe(true);
    expect(isFutureFor('2026-12-01', MADRID, at('2026-11-30T23:00:00.000Z'))).toBe(false);
  });

  it('RN-07 America/Santiago: el cruce de medianoche (horario de verano, UTC-3) cambia el día local', () => {
    expect(todayFor(SANTIAGO, at('2026-10-19T02:59:59.999Z'))).toBe('2026-10-18');
    expect(todayFor(SANTIAGO, at('2026-10-19T03:00:00.000Z'))).toBe('2026-10-19');
    expect(isFutureFor('2026-10-19', SANTIAGO, at('2026-10-19T02:59:59.999Z'))).toBe(true);
    expect(isFutureFor('2026-10-19', SANTIAGO, at('2026-10-19T03:00:00.000Z'))).toBe(false);
  });

  it('RN-07 America/Santiago: el cruce de medianoche en horario estándar (UTC-4)', () => {
    expect(isFutureFor('2026-06-15', SANTIAGO, at('2026-06-15T03:59:59.999Z'))).toBe(true);
    expect(isFutureFor('2026-06-15', SANTIAGO, at('2026-06-15T04:00:00.000Z'))).toBe(false);
  });

  it('RN-07 el mismo instante da días distintos según la zona del perfil', () => {
    const now = at('2026-10-19T02:00:00.000Z');
    expect(todayFor(LA_PAZ, now)).toBe('2026-10-18');
    expect(todayFor(MADRID, now)).toBe('2026-10-19');
    expect(todayFor(SANTIAGO, now)).toBe('2026-10-18');
    expect(isFutureFor('2026-10-19', LA_PAZ, now)).toBe(true);
    expect(isFutureFor('2026-10-19', MADRID, now)).toBe(false);
    expect(isFutureFor('2026-10-19', SANTIAGO, now)).toBe(true);
  });

  it('RN-07 hoy no es futuro y mañana sí, en las tres zonas', () => {
    const now = at('2026-10-19T15:00:00.000Z');
    for (const tz of [LA_PAZ, MADRID, SANTIAGO]) {
      expect(isFutureFor('2026-10-19', tz, now)).toBe(false);
      expect(isFutureFor('2026-10-20', tz, now)).toBe(true);
    }
  });

  it('RN-07 no hay fecha mínima: fechas muy antiguas no son futuras', () => {
    const now = at('2026-10-19T15:00:00.000Z');
    for (const tz of [LA_PAZ, MADRID, SANTIAGO]) {
      expect(isFutureFor('1900-01-01', tz, now)).toBe(false);
      expect(isFutureFor('2026-10-18', tz, now)).toBe(false);
    }
  });

  it('RN-07 el cruce de medianoche de fin de año en America/La_Paz', () => {
    expect(todayFor(LA_PAZ, at('2027-01-01T03:59:59.999Z'))).toBe('2026-12-31');
    expect(todayFor(LA_PAZ, at('2027-01-01T04:00:00.000Z'))).toBe('2027-01-01');
    expect(isFutureFor('2027-01-01', LA_PAZ, at('2027-01-01T03:59:59.999Z'))).toBe(true);
  });

  it('RNF-20 todayFor respeta los días de cambio de horario en Europe/Madrid', () => {
    // 2026-03-29: 02:00 CET -> 03:00 CEST. 2026-10-25: 03:00 CEST -> 02:00 CET.
    expect(todayFor(MADRID, at('2026-03-28T22:59:59.999Z'))).toBe('2026-03-28');
    expect(todayFor(MADRID, at('2026-03-28T23:00:00.000Z'))).toBe('2026-03-29');
    expect(todayFor(MADRID, at('2026-03-29T21:59:59.999Z'))).toBe('2026-03-29');
    expect(todayFor(MADRID, at('2026-03-29T22:00:00.000Z'))).toBe('2026-03-30');
    expect(todayFor(MADRID, at('2026-10-24T21:59:59.999Z'))).toBe('2026-10-24');
    expect(todayFor(MADRID, at('2026-10-24T22:00:00.000Z'))).toBe('2026-10-25');
    expect(todayFor(MADRID, at('2026-10-25T22:59:59.999Z'))).toBe('2026-10-25');
    expect(todayFor(MADRID, at('2026-10-25T23:00:00.000Z'))).toBe('2026-10-26');
  });

  it('RNF-20 todayFor respeta los días de cambio de horario en America/Santiago', () => {
    // 2026-04-05: 00:00 -03 -> 23:00 -04 del día anterior. 2026-09-06: 00:00 -04 -> 01:00 -03.
    expect(todayFor(SANTIAGO, at('2026-04-05T03:30:00.000Z'))).toBe('2026-04-04');
    expect(todayFor(SANTIAGO, at('2026-04-05T04:00:00.000Z'))).toBe('2026-04-05');
    expect(todayFor(SANTIAGO, at('2026-09-06T03:59:59.999Z'))).toBe('2026-09-05');
    expect(todayFor(SANTIAGO, at('2026-09-06T04:00:00.000Z'))).toBe('2026-09-06');
  });
});

describe('dates: startOfDayInstant (RNF-20)', () => {
  it('RNF-20 America/La_Paz: el día empieza a las 04:00 UTC', () => {
    expect(startOfDayInstant('2026-10-19', LA_PAZ).toISOString()).toBe('2026-10-19T04:00:00.000Z');
  });

  it('RNF-20 Europe/Madrid: inicio del día de entrada al horario de verano (día de 23 h)', () => {
    expect(startOfDayInstant('2026-03-29', MADRID).toISOString()).toBe('2026-03-28T23:00:00.000Z');
    expect(startOfDayInstant('2026-03-30', MADRID).toISOString()).toBe('2026-03-29T22:00:00.000Z');
  });

  it('RNF-20 Europe/Madrid: inicio del día de salida del horario de verano (día de 25 h)', () => {
    expect(startOfDayInstant('2026-10-25', MADRID).toISOString()).toBe('2026-10-24T22:00:00.000Z');
    expect(startOfDayInstant('2026-10-26', MADRID).toISOString()).toBe('2026-10-25T23:00:00.000Z');
  });

  it('RNF-20 America/Santiago: el día de entrada al horario de verano no tiene medianoche y empieza a la 01:00 local', () => {
    expect(startOfDayInstant('2026-09-05', SANTIAGO).toISOString()).toBe('2026-09-05T04:00:00.000Z');
    expect(startOfDayInstant('2026-09-06', SANTIAGO).toISOString()).toBe('2026-09-06T04:00:00.000Z');
    expect(startOfDayInstant('2026-09-07', SANTIAGO).toISOString()).toBe('2026-09-07T03:00:00.000Z');
  });

  it('RNF-20 America/Santiago: el día de salida del horario de verano empieza en la medianoche única', () => {
    expect(startOfDayInstant('2026-04-04', SANTIAGO).toISOString()).toBe('2026-04-04T03:00:00.000Z');
    expect(startOfDayInstant('2026-04-05', SANTIAGO).toISOString()).toBe('2026-04-05T04:00:00.000Z');
  });

  it('RNF-20 propiedad: en cada día de 2026 y en cada zona, startOfDayInstant es el primer instante del día local', () => {
    for (const tz of [LA_PAZ, MADRID, SANTIAGO]) {
      for (const day of daysOfYear(2026)) {
        const start = startOfDayInstant(day, tz);
        expect(todayFor(tz, start), `${tz} ${day}`).toBe(day);
        expect(todayFor(tz, new Date(start.getTime() - 1)), `${tz} ${day} - 1 ms`).toBe(shiftDay(day, -1));
      }
    }
  });
});

describe('dates: boliviaDay (RF-M3-13)', () => {
  it('RF-M3-13 boliviaDay usa el calendario de Bolivia (UTC-4), no el día UTC', () => {
    expect(boliviaDay(at('2026-10-19T03:59:59.999Z'))).toBe('2026-10-18');
    expect(boliviaDay(at('2026-10-19T04:00:00.000Z'))).toBe('2026-10-19');
    expect(boliviaDay(at('2026-10-19T23:30:00.000Z'))).toBe('2026-10-19');
  });

  it('RF-M3-13 boliviaDay coincide con todayFor en America/La_Paz y no con Madrid ni Santiago en verano', () => {
    const instant = at('2026-10-19T03:30:00.000Z');
    expect(boliviaDay(instant)).toBe(todayFor(LA_PAZ, instant));
    expect(boliviaDay(instant)).toBe('2026-10-18');
    expect(todayFor(MADRID, instant)).toBe('2026-10-19');
    expect(todayFor(SANTIAGO, instant)).toBe('2026-10-19');
  });

  it('RF-M3-13 boliviaDay no cambia en los días de cambio de horario de otras zonas', () => {
    expect(boliviaDay(at('2026-03-29T03:59:59.999Z'))).toBe('2026-03-28');
    expect(boliviaDay(at('2026-03-29T04:00:00.000Z'))).toBe('2026-03-29');
    expect(boliviaDay(at('2026-09-06T03:59:59.999Z'))).toBe('2026-09-05');
    expect(boliviaDay(at('2026-09-06T04:00:00.000Z'))).toBe('2026-09-06');
  });
});

describe('dates: clampDay (RF-M14-02)', () => {
  it('RF-M14-02 clampDay(2027, 2, 29) da el 28 (año no bisiesto)', () => {
    expect(clampDay(2027, 2, 29)).toBe(28);
  });

  it('RF-M14-02 clampDay(2026, 11, 31) da el 30', () => {
    expect(clampDay(2026, 11, 31)).toBe(30);
  });

  it('RF-M14-02 el 29 de febrero se mantiene en los años bisiestos', () => {
    expect(clampDay(2028, 2, 29)).toBe(29);
    expect(clampDay(2000, 2, 31)).toBe(29);
  });

  it('RF-M14-02 los años seculares no bisiestos llevan el 29 de febrero al 28', () => {
    expect(clampDay(2100, 2, 29)).toBe(28);
  });

  it('RF-M14-02 un día que existe en el mes no se modifica', () => {
    expect(clampDay(2026, 1, 31)).toBe(31);
    expect(clampDay(2026, 4, 30)).toBe(30);
    expect(clampDay(2026, 4, 15)).toBe(15);
    expect(clampDay(2026, 12, 31)).toBe(31);
  });

  it('RF-M14-02 el 31 cae en el último día de cada mes de 30 días', () => {
    for (const month of [4, 6, 9, 11]) expect(clampDay(2026, month, 31)).toBe(30);
  });
});
