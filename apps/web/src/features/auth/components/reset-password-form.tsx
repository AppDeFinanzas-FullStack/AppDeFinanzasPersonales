import { zodResolver } from '@hookform/resolvers/zod';
import { ResetInput } from '@finanzas/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { z } from 'zod';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ApiError, call, type Endpoint } from '@/lib/api-client';
import { messageForError } from '@/lib/i18n-errors';

import { ME_QUERY_KEY } from '../hooks/use-me';

const resetEndpoint: Endpoint<ResetInput, { next: 'dashboard' | 'onboarding' }> = {
  method: 'POST',
  path: '/api/auth/password/reset',
  input: ResetInput,
  output: z.object({ next: z.enum(['dashboard', 'onboarding']) }),
};

const PasswordFields = ResetInput.pick({ newPassword: true });
type PasswordFields = z.infer<typeof PasswordFields>;

function InvalidLink() {
  const { t } = useTranslation('auth');
  return (
    <section className="mx-auto flex min-h-screen w-full max-w-sm flex-col justify-center gap-6 px-4 py-8">
      <h1 className="text-2xl font-semibold">{t('reset.invalidTitle')}</h1>
      <p>{t('reset.invalidBody')}</p>
      <Link to="/olvide-mi-contrasena" className="text-sm text-primary underline">
        {t('reset.requestAnother')}
      </Link>
    </section>
  );
}

export function ResetPasswordForm() {
  const { t } = useTranslation('auth');
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const token = useSearchParams()[0].get('token');
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<PasswordFields>({
    resolver: zodResolver(PasswordFields),
    defaultValues: { newPassword: '' },
  });

  const reset = useMutation({
    mutationFn: (input: ResetInput) => call(resetEndpoint, input),
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: ME_QUERY_KEY });
      void navigate(result.next === 'onboarding' ? '/onboarding' : '/', { replace: true });
    },
  });

  if (token === null || (reset.error instanceof ApiError && reset.error.code === 'LINK_INVALID')) {
    return <InvalidLink />;
  }

  const onSubmit = handleSubmit((values) => {
    reset.mutate({ token, newPassword: values.newPassword });
  });

  return (
    <section className="mx-auto flex min-h-screen w-full max-w-sm flex-col justify-center gap-6 px-4 py-8">
      <h1 className="text-2xl font-semibold">{t('reset.title')}</h1>
      <p className="text-sm text-muted-foreground">{t('reset.linkNotice')}</p>
      <form onSubmit={(event) => void onSubmit(event)} noValidate className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <Label htmlFor="newPassword">{t('reset.password')}</Label>
          <Input
            id="newPassword"
            type="password"
            autoComplete="new-password"
            aria-invalid={errors.newPassword !== undefined}
            {...register('newPassword')}
          />
          <p className="text-sm text-muted-foreground">{t('reset.passwordHint')}</p>
          {errors.newPassword !== undefined && (
            <p className="text-sm text-destructive">{t('reset.errors.password')}</p>
          )}
        </div>
        {reset.isError && (
          <p role="alert" className="text-sm text-destructive">
            {messageForError(reset.error instanceof ApiError ? reset.error : { code: '' })}
          </p>
        )}
        <Button type="submit" className="h-11" disabled={reset.isPending || reset.isSuccess}>
          {reset.isPending ? t('reset.submitting') : t('reset.submit')}
        </Button>
      </form>
    </section>
  );
}
