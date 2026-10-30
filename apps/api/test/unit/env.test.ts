import { describe, expect, it } from 'vitest';

import { parseEnv } from '../../src/infrastructure/config/env.js';

const SECRET_VALUES = {
  DATABASE_URL: 'postgresql://user:db-password-xyz@localhost:5432/finanzas',
  AUTH_SECRET: 'auth-secret-value-0123456789abcdef0123456789',
  HMAC_SECRET: 'hmac-secret-value-0123456789abcdef0123456789',
  JOBS_SECRET: 'jobs-secret-value-0123456789abcdef0123456789',
  RESEND_API_KEY: 're_resend-key-value-0123456789',
};

const valid = (): Record<string, string> => ({
  NODE_ENV: 'test',
  PORT: '3000',
  ...SECRET_VALUES,
  RELEASE: '1.0',
  WEB_ORIGIN: 'http://localhost:5173',
  INTEGRATIONS: 'fake',
});

const messageOf = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  throw new Error('expected parseEnv to throw');
};

describe('env', () => {
  it('TASK-030 acepta un entorno completo y válido', () => {
    const env = parseEnv(valid());
    expect(env.RELEASE).toBe('1.0');
    expect(env.INTEGRATIONS).toBe('fake');
    expect(env.NODE_ENV).toBe('test');
  });

  it('TASK-030 convierte PORT a número', () => {
    expect(parseEnv(valid()).PORT).toBe(3000);
  });

  it.each(Object.keys(valid()))(
    'TASK-030 si falta %s el error la nombra sin mostrar ningún valor',
    (name) => {
      const source = valid();
      delete source[name];
      const message = messageOf(() => parseEnv(source));
      expect(message).toContain(name);
      for (const value of Object.values(source)) {
        expect(message).not.toContain(value);
      }
    },
  );

  it('TASK-030 un valor inválido no se muestra en el error', () => {
    const message = messageOf(() =>
      parseEnv({ ...valid(), RELEASE: '9.9-super-secret-leak' }),
    );
    expect(message).toContain('RELEASE');
    expect(message).not.toContain('9.9-super-secret-leak');
    for (const value of Object.values(SECRET_VALUES)) {
      expect(message).not.toContain(value);
    }
  });

  it('TASK-030 INTEGRATIONS=fake con NODE_ENV=production falla', () => {
    const message = messageOf(() =>
      parseEnv({ ...valid(), NODE_ENV: 'production', INTEGRATIONS: 'fake' }),
    );
    expect(message).toContain('INTEGRATIONS');
  });

  it('TASK-030 INTEGRATIONS=real con NODE_ENV=production es válido', () => {
    const env = parseEnv({ ...valid(), NODE_ENV: 'production', INTEGRATIONS: 'real' });
    expect(env.INTEGRATIONS).toBe('real');
  });

  it('TASK-030 INTEGRATIONS solo admite real o fake', () => {
    expect(() => parseEnv({ ...valid(), INTEGRATIONS: 'mock' })).toThrow();
  });

  it.each(['1.0', '1.1', '1.2'])('TASK-030 RELEASE admite %s', (release) => {
    expect(parseEnv({ ...valid(), RELEASE: release }).RELEASE).toBe(release);
  });

  it('TASK-254 EMAIL_FROM es opcional y usa la dirección de prueba de Resend', () => {
    expect(parseEnv(valid()).EMAIL_FROM).toBe('Finanzas <onboarding@resend.dev>');
  });

  it('TASK-254 EMAIL_FROM toma el remitente del entorno', () => {
    const from = 'Finanzas <no-reply@appfinanzas.me>';
    expect(parseEnv({ ...valid(), EMAIL_FROM: from }).EMAIL_FROM).toBe(from);
  });

  it.each(['0.9', '1.3', '2.0', '1', '', '1.0.0'])(
    'TASK-030 RELEASE rechaza "%s"',
    (release) => {
      expect(() => parseEnv({ ...valid(), RELEASE: release })).toThrow();
    },
  );

  it('RNF-29 DB_LATENCY_MS es opcional y vale 0 por defecto', () => {
    expect(parseEnv(valid()).DB_LATENCY_MS).toBe(0);
  });

  it('RNF-29 DB_LATENCY_MS se convierte a número entero', () => {
    expect(parseEnv({ ...valid(), DB_LATENCY_MS: '25' }).DB_LATENCY_MS).toBe(25);
  });

  it.each(['2.5', '-1', 'abc'])('RNF-29 DB_LATENCY_MS rechaza "%s"', (latency) => {
    const message = messageOf(() => parseEnv({ ...valid(), DB_LATENCY_MS: latency }));
    expect(message).toContain('DB_LATENCY_MS');
    expect(message).not.toContain(latency);
  });

  it.each(['development', 'test'])(
    'RNF-29 DB_LATENCY_MS=25 es válido con NODE_ENV=%s',
    (nodeEnv) => {
      const env = parseEnv({ ...valid(), NODE_ENV: nodeEnv, DB_LATENCY_MS: '25' });
      expect(env.DB_LATENCY_MS).toBe(25);
    },
  );

  it('RNF-29 con NODE_ENV=production, parseEnv rechaza DB_LATENCY_MS distinto de 0', () => {
    const message = messageOf(() =>
      parseEnv({
        ...valid(),
        NODE_ENV: 'production',
        INTEGRATIONS: 'real',
        DB_LATENCY_MS: '25',
      }),
    );
    expect(message).toContain('DB_LATENCY_MS');
  });

  it('RNF-29 con NODE_ENV=production, DB_LATENCY_MS=0 y la variable ausente son válidos', () => {
    const production = { ...valid(), NODE_ENV: 'production', INTEGRATIONS: 'real' };
    expect(parseEnv({ ...production, DB_LATENCY_MS: '0' }).DB_LATENCY_MS).toBe(0);
    expect(parseEnv(production).DB_LATENCY_MS).toBe(0);
  });
});
