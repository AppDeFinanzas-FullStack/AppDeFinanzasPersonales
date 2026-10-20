import { zodResolver } from '@hookform/resolvers/zod';
import { ChangePwdInput } from '@finanzas/contracts';
import { useMutation } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ApiError, call } from '@/lib/api-client';
import { messageForError } from '@/lib/i18n-errors';

import { changePasswordEndpoint } from '../api';

/** Changes the password; the API closes the other sessions and mails a notice (RF-M1-10, EC-M1-05). */
export function ChangePasswordForm() {
  const { t } = useTranslation('profile');
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<ChangePwdInput>({
    resolver: zodResolver(ChangePwdInput),
    defaultValues: { currentPassword: '', newPassword: '' },
  });

  const change = useMutation({
    mutationFn: (input: ChangePwdInput) => call(changePasswordEndpoint, input),
    onSuccess: () => {
      reset();
    },
  });

  const onSubmit = handleSubmit((values) => {
    change.mutate(values);
  });

  return (
    <section aria-labelledby="profile-password" className="flex flex-col gap-4">
      <h2 id="profile-password" className="text-lg font-semibold">
        {t('password.title')}
      </h2>
      <p className="text-sm text-muted-foreground">{t('password.intro')}</p>
      <form onSubmit={(event) => void onSubmit(event)} noValidate className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <Label htmlFor="current-password">{t('password.current')}</Label>
          <Input
            id="current-password"
            type="password"
            autoComplete="current-password"
            className="h-11"
            aria-invalid={errors.currentPassword !== undefined}
            {...register('currentPassword')}
          />
          {errors.currentPassword !== undefined && (
            <p className="text-sm text-destructive">{t('password.errors.current')}</p>
          )}
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="new-password">{t('password.next')}</Label>
          <Input
            id="new-password"
            type="password"
            autoComplete="new-password"
            className="h-11"
            aria-invalid={errors.newPassword !== undefined}
            {...register('newPassword')}
          />
          <p className="text-sm text-muted-foreground">{t('password.nextHint')}</p>
          {errors.newPassword !== undefined && (
            <p className="text-sm text-destructive">{t('password.errors.next')}</p>
          )}
        </div>
        {change.isError && (
          <p role="alert" className="text-sm text-destructive">
            {messageForError(change.error instanceof ApiError ? change.error : { code: '' })}
          </p>
        )}
        {change.isSuccess && (
          <p role="status" className="text-sm text-muted-foreground">
            {t('password.changed')}
          </p>
        )}
        <Button type="submit" variant="outline" className="h-11" disabled={change.isPending}>
          {change.isPending ? t('password.submitting') : t('password.submit')}
        </Button>
      </form>
    </section>
  );
}
