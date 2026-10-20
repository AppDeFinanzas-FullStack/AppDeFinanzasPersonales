import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useNavigate, type RouteObject } from 'react-router';

import { i18n, LANGUAGE } from '@/app/providers/i18n';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { useMe } from '@/features/auth/hooks/use-me';
import { ApiError, call } from '@/lib/api-client';
import { clearAllDrafts } from '@/lib/drafts';
import { messageForError } from '@/lib/i18n-errors';
import profile from '@/locales/es-BO/profile.json';

import { signOutAllEndpoint, signOutEndpoint } from './api';
import { ChangePasswordForm } from './components/change-password-form';
import { ProfileForm } from './components/profile-form';

// The feature registers its own namespace (RNF-07).
i18n.addResourceBundle(LANGUAGE, 'profile', profile, true, true);

/** "Cerrar sesión" closes this device; "en todos los dispositivos" closes every session (RF-M1-07). */
function SessionActions({ userId }: { userId: string }) {
  const { t } = useTranslation('profile');
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const leave = async () => {
    clearAllDrafts(userId);
    await navigate('/entrar', { replace: true });
    queryClient.clear();
  };

  const signOut = useMutation({
    mutationFn: () => call(signOutEndpoint, undefined),
    onSuccess: leave,
  });
  const signOutAll = useMutation({
    mutationFn: () => call(signOutAllEndpoint, undefined),
    onSuccess: leave,
  });
  const pending = signOut.isPending || signOutAll.isPending;
  const error = signOut.error ?? signOutAll.error;

  return (
    <section aria-labelledby="profile-session" className="flex flex-col gap-4">
      <h2 id="profile-session" className="text-lg font-semibold">
        {t('session.title')}
      </h2>
      {error !== null && (
        <p role="alert" className="text-sm text-destructive">
          {messageForError(error instanceof ApiError ? error : { code: '' })}
        </p>
      )}
      <Button
        type="button"
        variant="outline"
        className="h-11"
        disabled={pending}
        onClick={() => {
          signOut.mutate();
        }}
      >
        {t('session.signOut')}
      </Button>
      <div className="flex flex-col gap-2">
        <Button
          type="button"
          variant="outline"
          className="h-11"
          disabled={pending}
          onClick={() => {
            signOutAll.mutate();
          }}
        >
          {t('session.signOutAll')}
        </Button>
        <p className="text-sm text-muted-foreground">{t('session.signOutAllHint')}</p>
      </div>
    </section>
  );
}

/** `/perfil` (plan §4.1.4). */
export function ProfilePage() {
  const me = useMe();
  if (!me.data) return null;
  return (
    <div className="flex flex-col gap-8">
      <ProfileForm me={me.data} />
      <Separator />
      <ChangePasswordForm />
      <Separator />
      <SessionActions userId={me.data.id} />
    </div>
  );
}

/** Private routes of the profile (plan §4.1.4). */
export const profileRoutes: RouteObject[] = [{ path: 'perfil', element: <ProfilePage /> }];
