import { zodResolver } from '@hookform/resolvers/zod';
import { MeDto, SignInInput } from '@finanzas/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router';
import { z } from 'zod';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ApiError, call, type Endpoint } from '@/lib/api-client';
import { messageForError } from '@/lib/i18n-errors';

import { ME_QUERY_KEY } from '../hooks/use-me';

const SignInResult = z.object({ me: MeDto, next: z.enum(['dashboard', 'onboarding']) });
type SignInResult = z.infer<typeof SignInResult>;

const signInEndpoint: Endpoint<SignInInput, SignInResult> = {
  method: 'POST',
  path: '/api/auth/sign-in',
  input: SignInInput,
  output: SignInResult,
};

const TICK_MILLISECONDS = 1000;
const SECONDS_PER_MINUTE = 60;

/** `m:ss` text of the remaining wait (EC-M1-04). */
function formatWait(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / SECONDS_PER_MINUTE);
  const seconds = totalSeconds % SECONDS_PER_MINUTE;
  return `${String(minutes)}:${String(seconds).padStart(2, '0')}`;
}

function retryAfterFrom(error: unknown): number | null {
  if (!(error instanceof ApiError) || error.code !== 'LOGIN_LOCKED') return null;
  const seconds = error.data?.['retryAfterSeconds'];
  return typeof seconds === 'number' && seconds > 0 ? Math.ceil(seconds) : null;
}

interface Countdown {
  remaining: number;
  start: (seconds: number | null) => void;
}

/** Counts down from the `retryAfterSeconds` the API sent (RF-M1-08). */
function useCountdown(): Countdown {
  const [wait, setWait] = useState<{ endsAt: number; now: number } | null>(null);
  const active = wait !== null;

  useEffect(() => {
    if (!active) return undefined;
    const timer = setInterval(() => {
      setWait((current) => {
        if (current === null) return null;
        const now = Date.now();
        return now >= current.endsAt ? null : { endsAt: current.endsAt, now };
      });
    }, TICK_MILLISECONDS);
    return () => {
      clearInterval(timer);
    };
  }, [active]);

  const start = useCallback((seconds: number | null) => {
    const now = Date.now();
    setWait(seconds === null ? null : { endsAt: now + seconds * 1000, now });
  }, []);

  return {
    remaining: wait === null ? 0 : Math.max(0, Math.ceil((wait.endsAt - wait.now) / 1000)),
    start,
  };
}

export function SignInForm() {
  const { t } = useTranslation('auth');
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const {
    register,
    handleSubmit,
    getValues,
    formState: { errors },
  } = useForm<SignInInput>({
    resolver: zodResolver(SignInInput),
    defaultValues: { email: '', password: '' },
  });

  const { remaining, start } = useCountdown();

  const signIn = useMutation({
    mutationFn: (input: SignInInput) => call(signInEndpoint, input),
    onSuccess: (result) => {
      queryClient.setQueryData(ME_QUERY_KEY, result.me);
      void navigate(result.next === 'onboarding' ? '/onboarding' : '/', { replace: true });
    },
    onError: (error) => {
      start(retryAfterFrom(error));
      if (error instanceof ApiError && error.code === 'EMAIL_NOT_CONFIRMED') {
        void navigate('/revisa-tu-correo', { state: { email: getValues('email').trim() } });
      }
    },
  });

  const onSubmit = handleSubmit((values) => {
    signIn.mutate(values);
  });

  let serverError: string | null = null;
  if (signIn.error !== null && remaining === 0 && retryAfterFrom(signIn.error) === null) {
    if (signIn.error instanceof ApiError && signIn.error.code === 'INVALID_CREDENTIALS') {
      serverError = t('signIn.errors.invalid');
    } else if (!(signIn.error instanceof ApiError && signIn.error.code === 'EMAIL_NOT_CONFIRMED')) {
      serverError = messageForError(
        signIn.error instanceof ApiError ? signIn.error : { code: '' },
      );
    }
  }

  return (
    <section className="mx-auto flex min-h-screen w-full max-w-sm flex-col justify-center gap-6 px-4 py-8">
      <h1 className="text-2xl font-semibold">{t('signIn.title')}</h1>
      <form onSubmit={(event) => void onSubmit(event)} noValidate className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <Label htmlFor="email">{t('signIn.email')}</Label>
          <Input
            id="email"
            type="email"
            autoComplete="email"
            aria-invalid={errors.email !== undefined}
            {...register('email')}
          />
          {errors.email !== undefined && (
            <p className="text-sm text-destructive">{t('signIn.errors.email')}</p>
          )}
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="password">{t('signIn.password')}</Label>
          <Input
            id="password"
            type="password"
            autoComplete="current-password"
            aria-invalid={errors.password !== undefined}
            {...register('password')}
          />
          {errors.password !== undefined && (
            <p className="text-sm text-destructive">{t('signIn.errors.password')}</p>
          )}
        </div>
        {serverError !== null && (
          <p role="alert" className="text-sm text-destructive">
            {serverError}
          </p>
        )}
        {remaining > 0 && (
          <p role="alert" className="text-sm text-destructive">
            {t('signIn.locked', { time: formatWait(remaining) })}
          </p>
        )}
        <Button type="submit" className="h-11" disabled={signIn.isPending || remaining > 0}>
          {signIn.isPending ? t('signIn.submitting') : t('signIn.submit')}
        </Button>
      </form>
      <p className="text-sm text-muted-foreground">
        {t('signIn.noAccount')}{' '}
        <Link to="/registro" className="text-primary underline">
          {t('signIn.signUpLink')}
        </Link>
      </p>
    </section>
  );
}
