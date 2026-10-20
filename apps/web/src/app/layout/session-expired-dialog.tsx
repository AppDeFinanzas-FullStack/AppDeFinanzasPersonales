import { zodResolver } from '@hookform/resolvers/zod';
import { MeDto, SignInInput } from '@finanzas/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';
import { z } from 'zod';

import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ME_QUERY_KEY } from '@/features/auth/hooks/use-me';
import { ApiError, call, type Endpoint } from '@/lib/api-client';
import { clearAllDrafts } from '@/lib/drafts';
import { messageForError } from '@/lib/i18n-errors';
import { uiStore, useUiStore } from '@/lib/ui-store';

const SignInResult = z.object({ me: MeDto, next: z.enum(['dashboard', 'onboarding']) });
type SignInResult = z.infer<typeof SignInResult>;

const signInEndpoint: Endpoint<SignInInput, SignInResult> = {
  method: 'POST',
  path: '/api/auth/sign-in',
  input: SignInInput,
  output: SignInResult,
};

function errorText(error: unknown, invalid: string): string {
  if (error instanceof ApiError && error.code === 'INVALID_CREDENTIALS') return invalid;
  return messageForError(error instanceof ApiError ? error : { code: '' });
}

/** Sign-in on top of the current screen; the screen underneath stays mounted (RF-M2-08). */
function SessionSignInForm() {
  const { t } = useTranslation('navigation');
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<SignInInput>({
    resolver: zodResolver(SignInInput),
    defaultValues: { email: '', password: '' },
  });

  const signIn = useMutation({
    mutationFn: (input: SignInInput) => call(signInEndpoint, input),
    onSuccess: async (result) => {
      const previous = queryClient.getQueryData<MeDto>(ME_QUERY_KEY);
      if (previous !== undefined && previous.id === result.me.id) {
        // Same user: back to the same screen with its drafts, retrying the queries.
        queryClient.setQueryData(ME_QUERY_KEY, result.me);
        uiStore.closeSessionExpired();
        await queryClient.invalidateQueries();
        return;
      }
      // EC-M2-01: another person signed in, so the previous user's drafts and data go away.
      if (previous !== undefined) clearAllDrafts(previous.id);
      queryClient.clear();
      queryClient.setQueryData(ME_QUERY_KEY, result.me);
      uiStore.closeSessionExpired();
      await navigate('/', { replace: true });
    },
  });

  const onSubmit = handleSubmit((values) => {
    signIn.mutate(values);
  });

  return (
    <form onSubmit={(event) => void onSubmit(event)} noValidate className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <Label htmlFor="session-email">{t('sessionExpired.email')}</Label>
        <Input
          id="session-email"
          type="email"
          autoComplete="email"
          className="h-11"
          aria-invalid={errors.email !== undefined}
          {...register('email')}
        />
        {errors.email !== undefined && (
          <p className="text-sm text-destructive">{t('sessionExpired.errors.email')}</p>
        )}
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="session-password">{t('sessionExpired.password')}</Label>
        <Input
          id="session-password"
          type="password"
          autoComplete="current-password"
          className="h-11"
          aria-invalid={errors.password !== undefined}
          {...register('password')}
        />
        {errors.password !== undefined && (
          <p className="text-sm text-destructive">{t('sessionExpired.errors.password')}</p>
        )}
      </div>
      {signIn.error !== null && (
        <p role="alert" className="text-sm text-destructive">
          {errorText(signIn.error, t('sessionExpired.errors.invalid'))}
        </p>
      )}
      <Button type="submit" className="h-11" disabled={signIn.isPending}>
        {signIn.isPending ? t('sessionExpired.submitting') : t('sessionExpired.submit')}
      </Button>
    </form>
  );
}

/** Opens when the API answers SESSION_EXPIRED; it only closes by signing in again (plan §4.2.3). */
export function SessionExpiredDialog() {
  const { t } = useTranslation('navigation');
  const open = useUiStore((state) => state.sessionExpired);
  return (
    <AlertDialog open={open}>
      <AlertDialogContent className="max-w-sm">
        <AlertDialogHeader>
          <AlertDialogTitle className="text-2xl">{t('sessionExpired.title')}</AlertDialogTitle>
          <AlertDialogDescription className="text-base">
            {t('sessionExpired.description')}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <SessionSignInForm />
      </AlertDialogContent>
    </AlertDialog>
  );
}
