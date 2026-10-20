import type { SettingsDto } from '@finanzas/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as domain from '@finanzas/domain';
import { ThemeProvider } from '../src/app/providers/theme';
import { buildFormatters } from '../src/lib/formatters';

const hoisted = vi.hoisted(() => ({
  effects: [] as (() => void)[],
  data: undefined as { theme: 'system' | 'light' | 'dark' } | undefined,
}));

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return {
    ...actual,
    useState: (init: unknown) => [
      typeof init === 'function' ? (init as () => unknown)() : init,
      vi.fn(),
    ],
    useEffect: (fn: () => void) => {
      hoisted.effects.push(fn);
    },
  };
});

vi.mock('@/features/settings/hooks/use-settings', () => ({
  useSettings: () => ({ data: hoisted.data }),
}));

function settings(overrides: Partial<SettingsDto> = {}): SettingsDto {
  return {
    numberFormat: 'dot_comma',
    dateFormat: 'dmy',
    weekStart: 'monday',
    theme: 'system',
    sidebarCollapsed: false,
    defaultAccountId: null,
    alwaysShowNote: false,
    dashboardBlocks: [],
    favorites: { expense: [], income: [] },
    ...overrides,
  };
}

describe('buildFormatters money', () => {
  it('RF-M9-02 dot_comma da "Bs 1.234,56" con el simbolo antes y un espacio', () => {
    const f = buildFormatters(settings({ numberFormat: 'dot_comma' }));
    expect(f.money('1234.56', 'Bs')).toBe('Bs 1.234,56');
  });

  it('RF-M9-02 comma_dot da "Bs 1,234.56"', () => {
    const f = buildFormatters(settings({ numberFormat: 'comma_dot' }));
    expect(f.money('1234.56', 'Bs')).toBe('Bs 1,234.56');
  });

  it('RF-M9-02 el simbolo del dolar va antes del monto: "$ 97,09"', () => {
    const f = buildFormatters(settings({ numberFormat: 'dot_comma' }));
    expect(f.money('97.09', '$')).toBe('$ 97,09');
  });

  it('RF-M9-02 siempre muestra dos decimales', () => {
    const f = buildFormatters(settings({ numberFormat: 'dot_comma' }));
    expect(f.money('35', 'Bs')).toBe('Bs 35,00');
  });
});

describe('buildFormatters date', () => {
  it('RF-M9-03 dmy da 15/10/2026', () => {
    expect(buildFormatters(settings({ dateFormat: 'dmy' })).date('2026-10-15')).toBe('15/10/2026');
  });

  it('RF-M9-03 iso da 2026-10-15', () => {
    expect(buildFormatters(settings({ dateFormat: 'iso' })).date('2026-10-15')).toBe('2026-10-15');
  });

  it('RF-M9-03 short_text da "15 oct 2026"', () => {
    expect(buildFormatters(settings({ dateFormat: 'short_text' })).date('2026-10-15')).toBe(
      '15 oct 2026',
    );
  });
});

describe('buildFormatters relativeDay', () => {
  // 2026-10-15 is a Thursday.
  it('RF-M9-03 muestra "Hoy" y "Ayer"', () => {
    const f = buildFormatters(settings());
    expect(f.relativeDay('2026-10-15', '2026-10-15')).toBe('Hoy');
    expect(f.relativeDay('2026-10-14', '2026-10-15')).toBe('Ayer');
  });

  it('RF-M9-03 dentro de la semana muestra "Lun 12"', () => {
    const f = buildFormatters(settings({ weekStart: 'monday' }));
    expect(f.relativeDay('2026-10-12', '2026-10-15')).toBe('Lun 12');
  });

  it('RF-M9-03 fuera de la semana usa el formato de fecha elegido', () => {
    expect(
      buildFormatters(settings({ dateFormat: 'dmy' })).relativeDay('2026-10-10', '2026-10-15'),
    ).toBe('10/10/2026');
    expect(
      buildFormatters(settings({ dateFormat: 'iso' })).relativeDay('2026-10-10', '2026-10-15'),
    ).toBe('2026-10-10');
    expect(
      buildFormatters(settings({ dateFormat: 'short_text' })).relativeDay(
        '2026-10-10',
        '2026-10-15',
      ),
    ).toBe('10 oct 2026');
  });

  it('RF-M9-03 el primer dia de la semana cambia que dias se consideran de la semana', () => {
    // Sunday 2026-10-11 is outside a Monday-start week but inside a Sunday-start one.
    const monday = buildFormatters(settings({ weekStart: 'monday', dateFormat: 'iso' }));
    const sunday = buildFormatters(settings({ weekStart: 'sunday', dateFormat: 'iso' }));
    expect(monday.relativeDay('2026-10-11', '2026-10-15')).toBe('2026-10-11');
    expect(sunday.relativeDay('2026-10-11', '2026-10-15')).toBe('Dom 11');
  });
});

describe('buildFormatters pureza', () => {
  it('TASK-070 con los mismos ajustes del servidor da el mismo resultado y no los muta', () => {
    const server = settings({ numberFormat: 'comma_dot', dateFormat: 'iso' });
    const copy = structuredClone(server);
    const a = buildFormatters(server);
    const b = buildFormatters(server);
    expect(a.money('1234.5', 'Bs')).toBe(b.money('1234.5', 'Bs'));
    expect(a.date('2026-01-02')).toBe(b.date('2026-01-02'));
    expect(server).toEqual(copy);
  });
});

describe('packages/domain reexporta el formato', () => {
  it('RF-M9-03 reexporta formatDate, relativeDay y weekDays', () => {
    expect(domain.formatDate('2026-10-15', 'dmy')).toBe('15/10/2026');
    expect(domain.relativeDay('2026-10-15', '2026-10-15', 'monday', 'iso')).toBe('Hoy');
    expect(domain.relativeDay('2026-10-10', '2026-10-15', 'monday', 'iso')).toBe('2026-10-10');
    expect(domain.weekDays('monday')[0]).toBe('Lun');
    expect(domain.weekDays('sunday')[0]).toBe('Dom');
  });
});

describe('ThemeProvider', () => {
  const store = new Map<string, string>();
  const classes = new Set<string>();

  beforeEach(() => {
    hoisted.effects.length = 0;
    hoisted.data = undefined;
    store.clear();
    classes.clear();
    vi.stubGlobal('window', {
      localStorage: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => store.set(k, v),
      },
      matchMedia: () => ({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }),
    });
    vi.stubGlobal('document', {
      documentElement: {
        classList: {
          toggle: (c: string, on: boolean) => {
            if (on) classes.add(c);
            else classes.delete(c);
          },
        },
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function render(): void {
    ThemeProvider({ children: null });
    for (const effect of [...hoisted.effects]) effect();
  }

  it('RF-M9-01 el tema del servidor reemplaza al de localStorage al cargar', () => {
    store.set('ui:theme', 'light');
    hoisted.data = { theme: 'dark' };
    render();
    expect(store.get('ui:theme')).toBe('dark');
    expect(classes.has('dark')).toBe(true);
  });

  it('RF-M9-01 el primer pintado usa la copia de localStorage mientras no hay datos del servidor', () => {
    store.set('ui:theme', 'dark');
    render();
    expect(classes.has('dark')).toBe(true);
    expect(store.get('ui:theme')).toBe('dark');
  });

  it('RF-M9-01 el servidor con light quita la clase dark guardada en localStorage', () => {
    store.set('ui:theme', 'dark');
    hoisted.data = { theme: 'light' };
    render();
    expect(store.get('ui:theme')).toBe('light');
    expect(classes.has('dark')).toBe(false);
  });
});
