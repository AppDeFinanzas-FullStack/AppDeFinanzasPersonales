import { describe, expect, it } from 'vitest';
import { formatDate, relativeDay, weekDays } from '../src/format.js';

// Conventions used by these tests (plan §4.9.1, TASK-029):
// - Dates are calendar days as ISO text 'YYYY-MM-DD' (LocalDate, see dates.ts).
// - formatDate(date, dateFormat: 'dmy' | 'iso' | 'short_text').
// - relativeDay(date, today, weekStart: 'monday' | 'sunday') gives "Hoy", "Ayer" or
//   "Lun 13" inside the week of `today`, and the formatted date outside of it.
// - weekDays(weekStart) gives the order of the calendar days.
// 2026-10-15 is a Thursday; 2026-10-12 a Monday; 2026-10-11 a Sunday; 2026-07-13 a Monday.

const DATE_FORMATS = ['dmy', 'iso', 'short_text'] as const;

function formattedVariants(date: string): string[] {
  return DATE_FORMATS.map((dateFormat) => formatDate(date, dateFormat));
}

describe('format: formatDate (RF-M9-03)', () => {
  it('RF-M9-03 con el formato dmy muestra "15/10/2026"', () => {
    expect(formatDate('2026-10-15', 'dmy')).toBe('15/10/2026');
  });

  it('RF-M9-03 con el formato iso muestra "2026-10-15"', () => {
    expect(formatDate('2026-10-15', 'iso')).toBe('2026-10-15');
  });

  it('RF-M9-03 con el formato short_text muestra "15 oct 2026"', () => {
    expect(formatDate('2026-10-15', 'short_text')).toBe('15 oct 2026');
  });

  it('RF-M9-03 el formato iso conserva los ceros a la izquierda', () => {
    expect(formatDate('2026-01-05', 'iso')).toBe('2026-01-05');
  });
});

describe('format: relativeDay (RF-M9-03)', () => {
  it('RF-M9-03 el mismo día que hoy muestra "Hoy"', () => {
    expect(relativeDay('2026-10-15', '2026-10-15', 'monday')).toBe('Hoy');
    expect(relativeDay('2026-10-15', '2026-10-15', 'sunday')).toBe('Hoy');
  });

  it('RF-M9-03 el día anterior a hoy muestra "Ayer"', () => {
    expect(relativeDay('2026-10-14', '2026-10-15', 'monday')).toBe('Ayer');
    expect(relativeDay('2026-10-14', '2026-10-15', 'sunday')).toBe('Ayer');
  });

  it('RF-M9-03 un lunes 13 dentro de la semana muestra "Lun 13"', () => {
    expect(relativeDay('2026-07-13', '2026-07-16', 'monday')).toBe('Lun 13');
  });

  it('RF-M9-03 otro día dentro de la semana muestra el día abreviado y su número', () => {
    expect(relativeDay('2026-10-12', '2026-10-15', 'monday')).toBe('Lun 12');
    expect(relativeDay('2026-10-12', '2026-10-15', 'sunday')).toBe('Lun 12');
  });

  it('RF-M9-03 una fecha fuera de la semana muestra la fecha formateada', () => {
    const result = relativeDay('2026-10-05', '2026-10-15', 'monday');
    expect(formattedVariants('2026-10-05')).toContain(result);
  });

  it('RF-M9-04 con la semana desde el lunes, el domingo anterior queda fuera de la semana', () => {
    const result = relativeDay('2026-10-11', '2026-10-15', 'monday');
    expect(formattedVariants('2026-10-11')).toContain(result);
  });

  it('RF-M9-04 con la semana desde el domingo, el domingo anterior queda dentro de la semana', () => {
    const result = relativeDay('2026-10-11', '2026-10-15', 'sunday');
    expect(formattedVariants('2026-10-11')).not.toContain(result);
    expect(result).not.toBe('Hoy');
    expect(result).not.toBe('Ayer');
    expect(result).toMatch(/^\S+ 11$/);
  });
});

describe('format: weekDays (RF-M9-04)', () => {
  it('RF-M9-04 weekDays da los siete días sin repetir', () => {
    for (const weekStart of ['monday', 'sunday'] as const) {
      const days = weekDays(weekStart);
      expect(days).toHaveLength(7);
      expect(new Set(days.map((day) => JSON.stringify(day))).size).toBe(7);
    }
  });

  it('RF-M9-04 weekDays("sunday") empieza en domingo', () => {
    const days = weekDays('sunday');
    expect(String(days[0])).toMatch(/^(dom|sun|0$)/i);
  });

  it('RF-M9-04 weekDays("monday") empieza en lunes', () => {
    const days = weekDays('monday');
    expect(String(days[0])).toMatch(/^(lun|mon|1$)/i);
  });

  it('RF-M9-04 weekDays("sunday") es la semana del lunes con el domingo al inicio', () => {
    const monday = weekDays('monday');
    const sunday = weekDays('sunday');
    expect(sunday).toEqual([monday[6], ...monday.slice(0, 6)]);
  });
});
