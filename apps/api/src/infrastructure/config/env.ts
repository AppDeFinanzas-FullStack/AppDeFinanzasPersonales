import { z } from 'zod';

const secret = z.string().min(1);

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']),
    PORT: z.coerce.number().int().min(1).max(65535),
    DATABASE_URL: secret,
    AUTH_SECRET: secret,
    HMAC_SECRET: secret,
    JOBS_SECRET: secret,
    RESEND_API_KEY: secret,
    // Sender of the account emails. Resend's test address only delivers to the account owner, so
    // production sets one on a verified domain.
    EMAIL_FROM: z.string().min(1).default('Finanzas <onboarding@resend.dev>'),
    RELEASE: z.enum(['1.0', '1.1', '1.2']),
    WEB_ORIGIN: z.string().url(),
    INTEGRATIONS: z.enum(['real', 'fake']),
    // Milliseconds every Prisma operation waits, to reproduce the distance to the database in
    // tests (plan §4.0, RNF-29). Never in production.
    DB_LATENCY_MS: z.coerce.number().int().min(0).default(0),
  })
  .refine((env) => !(env.NODE_ENV === 'production' && env.INTEGRATIONS === 'fake'), {
    path: ['INTEGRATIONS'],
    message: 'fake is not allowed in production',
  })
  .refine((env) => !(env.NODE_ENV === 'production' && env.DB_LATENCY_MS !== 0), {
    path: ['DB_LATENCY_MS'],
    message: 'a database latency is not allowed in production',
  });

export type Env = z.infer<typeof envSchema>;

export const parseEnv = (source: Record<string, string | undefined>): Env => {
  const result = envSchema.safeParse(source);
  if (result.success) return result.data;
  const names = [
    ...new Set(result.error.issues.map((issue) => issue.path.join('.') || 'env')),
  ];
  throw new Error(`Invalid environment variables: ${names.join(', ')}`);
};

export const loadEnv = (): Env => parseEnv(process.env);
