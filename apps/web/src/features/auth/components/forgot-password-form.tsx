import { zodResolver } from '@hookform/resolvers/zod';
import { ForgotInput } from '@finanzas/contracts';
import { useMutation } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { z } from 'zod';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ApiError, call, type Endpoint } from '@/lib/api-client';
import { messageForError } from '@/lib/i18n-errors';

const forgotEndpoint: Endpoint<ForgotInput, void> = {
  method: 'POST',
  path: '/api/auth/password/forgot',
  input: ForgotInput,
  output: z.void(),
};

export function ForgotPasswordForm() {
  const { t } = useTranslation('auth');
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<ForgotInput>({
    resolver: zodResolver(ForgotInput),
    defaultValues: { email: '' },
  });

  const forgot = useMutation({
    mutationFn: (input: ForgotInput) => call(forgotEndpoint, input),
  });

  const onSubmit = handleSubmit((values) => {
    forgot.mutate(values);
  });

  if (forgot.isSuccess) {
    return (
      <section className="mx-auto flex min-h-screen w-full max-w-sm flex-col justify-center gap-6 px-4 py-8">
        <h1 className="text-2xl font-semibold">{t('forgot.sentTitle')}</h1>
        <p role="status">{t('forgot.neutral')}</p>
        <Link to="/entrar" className="text-sm text-primary underline">
          {t('forgot.signInLink')}
        </Link>
      </section>
    );
  }

  return (
    <section className="mx-auto flex min-h-screen w-full max-w-sm flex-col justify-center gap-6 px-4 py-8">
      <h1 className="text-2xl font-semibold">{t('forgot.title')}</h1>
      <p className="text-sm text-muted-foreground">{t('forgot.intro')}</p>
      <form onSubmit={(event) => void onSubmit(event)} noValidate className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <Label htmlFor="email">{t('forgot.email')}</Label>
          <Input
            id="email"
            type="email"
            autoComplete="email"
            aria-invalid={errors.email !== undefined}
            {...register('email')}
          />
          {errors.email !== undefined && (
            <p className="text-sm text-destructive">{t('forgot.errors.email')}</p>
          )}
        </div>
        {forgot.isError && (
          <p role="alert" className="text-sm text-destructive">
            {messageForError(forgot.error instanceof ApiError ? forgot.error : { code: '' })}
          </p>
        )}
        <Button type="submit" className="h-11" disabled={forgot.isPending}>
          {forgot.isPending ? t('forgot.submitting') : t('forgot.submit')}
        </Button>
      </form>
      <Link to="/entrar" className="text-sm text-primary underline">
        {t('forgot.signInLink')}
      </Link>
    </section>
  );
}
