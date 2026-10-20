import { zodResolver } from '@hookform/resolvers/zod';
import { SignUpInput } from '@finanzas/contracts';
import { useMutation } from '@tanstack/react-query';
import { Controller, useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router';
import type { z } from 'zod';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ApiError, call } from '@/lib/api-client';
import { messageForError } from '@/lib/i18n-errors';

import { signUpEndpoint } from '../api';

type SignUpFields = z.input<typeof SignUpInput>;

/** IANA zone of the device (RF-M1-11); the API falls back to Bolivia when it is missing. */
function deviceTimezone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
}

export function SignUpForm() {
  const { t } = useTranslation('auth');
  const navigate = useNavigate();
  const {
    register,
    control,
    handleSubmit,
    formState: { errors },
  } = useForm<SignUpFields, unknown, SignUpInput>({
    resolver: zodResolver(SignUpInput),
    defaultValues: { name: '', email: '', password: '' },
  });

  const signUp = useMutation({
    mutationFn: (input: SignUpInput) => call(signUpEndpoint, input),
    onSuccess: (_result, input) => {
      void navigate('/revisa-tu-correo', { state: { email: input.email } });
    },
  });

  const onSubmit = handleSubmit((values) => {
    const timezone = deviceTimezone();
    signUp.mutate(timezone === undefined ? values : { ...values, timezone });
  });

  const serverError =
    signUp.error === null
      ? null
      : messageForError(signUp.error instanceof ApiError ? signUp.error : { code: '' });

  return (
    <section className="mx-auto flex min-h-screen w-full max-w-sm flex-col justify-center gap-6 px-4 py-8">
      <h1 className="text-2xl font-semibold">{t('signUp.title')}</h1>
      <form onSubmit={(event) => void onSubmit(event)} noValidate className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <Label htmlFor="name">{t('signUp.name')}</Label>
          <Input
            id="name"
            autoComplete="name"
            aria-invalid={errors.name !== undefined}
            {...register('name')}
          />
          {errors.name !== undefined && (
            <p className="text-sm text-destructive">{t('signUp.errors.name')}</p>
          )}
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="email">{t('signUp.email')}</Label>
          <Input
            id="email"
            type="email"
            autoComplete="email"
            aria-invalid={errors.email !== undefined}
            {...register('email')}
          />
          {errors.email !== undefined && (
            <p className="text-sm text-destructive">{t('signUp.errors.email')}</p>
          )}
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="password">{t('signUp.password')}</Label>
          <Input
            id="password"
            type="password"
            autoComplete="new-password"
            aria-invalid={errors.password !== undefined}
            {...register('password')}
          />
          {errors.password !== undefined ? (
            <p className="text-sm text-destructive">{t('signUp.errors.password')}</p>
          ) : (
            <p className="text-sm text-muted-foreground">{t('signUp.passwordHint')}</p>
          )}
        </div>
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-3">
            <Controller
              control={control}
              name="acceptTerms"
              render={({ field }) => (
                <Checkbox
                  id="acceptTerms"
                  checked={field.value === true}
                  onCheckedChange={(checked) => field.onChange(checked === true)}
                  onBlur={field.onBlur}
                />
              )}
            />
            <Label htmlFor="acceptTerms">{t('signUp.terms')}</Label>
          </div>
          {errors.acceptTerms !== undefined && (
            <p className="text-sm text-destructive">{t('signUp.errors.acceptTerms')}</p>
          )}
        </div>
        {serverError !== null && <p className="text-sm text-destructive">{serverError}</p>}
        <Button type="submit" className="h-11" disabled={signUp.isPending}>
          {signUp.isPending ? t('signUp.submitting') : t('signUp.submit')}
        </Button>
      </form>
      <p className="text-sm text-muted-foreground">
        {t('signUp.haveAccount')}{' '}
        <Link to="/entrar" className="text-primary underline">
          {t('signUp.signInLink')}
        </Link>
      </p>
    </section>
  );
}
