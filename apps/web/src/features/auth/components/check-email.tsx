import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, Navigate, useLocation, useNavigate } from 'react-router';

import { Button } from '@/components/ui/button';
import { call } from '@/lib/api-client';

import { resendConfirmationEndpoint } from '../api';
import { useConfirmationWatch } from '../hooks/use-confirmation-watch';
import { ME_QUERY_KEY } from '../hooks/use-me';

/** RF-M1-05: one resend every 60 seconds. */
const RESEND_COOLDOWN_SECONDS = 60;
const TICK_MILLISECONDS = 1000;

function emailFrom(state: unknown): string | null {
  if (typeof state === 'object' && state !== null && 'email' in state) {
    const { email } = state;
    return typeof email === 'string' && email !== '' ? email : null;
  }
  return null;
}

export function CheckEmail() {
  const { t } = useTranslation('auth');
  const email = emailFrom(useLocation().state);
  const [endsAt, setEndsAt] = useState(() => Date.now() + RESEND_COOLDOWN_SECONDS * 1000);
  const [remaining, setRemaining] = useState(RESEND_COOLDOWN_SECONDS);
  const [resent, setResent] = useState(false);
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  // RF-M1-18, EC-M1-11: the server opened the session of the confirmed account; continue alone.
  const onConfirmed = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ME_QUERY_KEY });
    void navigate('/bienvenida', { replace: true });
  }, [queryClient, navigate]);
  useConfirmationWatch({ onConfirmed });

  useEffect(() => {
    const update = () => {
      setRemaining(Math.max(0, Math.ceil((endsAt - Date.now()) / 1000)));
    };
    update();
    const timer = setInterval(update, TICK_MILLISECONDS);
    return () => {
      clearInterval(timer);
    };
  }, [endsAt]);

  const resend = useMutation({
    mutationFn: (to: string) => call(resendConfirmationEndpoint, { email: to }),
  });

  const onResend = useCallback(() => {
    if (email === null) return;
    setEndsAt(Date.now() + RESEND_COOLDOWN_SECONDS * 1000);
    setRemaining(RESEND_COOLDOWN_SECONDS);
    setResent(true);
    resend.mutate(email);
  }, [email, resend]);

  if (email === null) {
    return <Navigate to="/registro" replace />;
  }

  return (
    <section className="mx-auto flex min-h-screen w-full max-w-sm flex-col justify-center gap-6 px-4 py-8">
      <h1 className="text-2xl font-semibold">{t('checkEmail.title')}</h1>
      <p>{t('checkEmail.neutral')}</p>
      <Button
        type="button"
        className="h-11"
        disabled={remaining > 0 || resend.isPending}
        onClick={onResend}
      >
        {remaining > 0
          ? t('checkEmail.resendIn', { seconds: remaining })
          : t('checkEmail.resend')}
      </Button>
      {resent && <p className="text-sm text-muted-foreground">{t('checkEmail.resent')}</p>}
      <Link to="/registro" className="text-sm text-primary underline">
        {t('checkEmail.backToSignUp')}
      </Link>
    </section>
  );
}
