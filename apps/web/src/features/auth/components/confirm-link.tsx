import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router';

import { Button } from '@/components/ui/button';
import { ApiError, call } from '@/lib/api-client';

import { confirmEndpoint, resendConfirmationEndpoint } from '../api';
import { ME_QUERY_KEY } from '../hooks/use-me';

export function ConfirmLink() {
  const { t } = useTranslation('auth');
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const token = useSearchParams()[0].get('token');
  const started = useRef(false);

  const confirm = useMutation({
    mutationFn: (value: string) => call(confirmEndpoint, { token: value }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ME_QUERY_KEY });
      void navigate('/bienvenida', { replace: true });
    },
    onError: (error) => {
      // EC-M1-02: the link was already used and the account is active.
      if (error instanceof ApiError && error.code === 'LINK_ALREADY_USED') {
        void navigate('/entrar', { replace: true });
      }
    },
  });
  const resend = useMutation({
    mutationFn: (value: string) => call(resendConfirmationEndpoint, { token: value }),
  });

  const { mutate } = confirm;
  useEffect(() => {
    // The link is single use: a second request (StrictMode) would turn it into "already used".
    if (token === null || started.current) return;
    started.current = true;
    mutate(token);
  }, [token, mutate]);

  if (token === null) {
    return <Navigate to="/registro" replace />;
  }

  const failed =
    confirm.isError &&
    !(confirm.error instanceof ApiError && confirm.error.code === 'LINK_ALREADY_USED');

  if (!failed) {
    return (
      <section className="mx-auto flex min-h-screen w-full max-w-sm flex-col justify-center gap-6 px-4 py-8">
        <p role="status">{t('confirm.confirming')}</p>
      </section>
    );
  }

  return (
    <section className="mx-auto flex min-h-screen w-full max-w-sm flex-col justify-center gap-6 px-4 py-8">
      <h1 className="text-2xl font-semibold">{t('confirm.invalidTitle')}</h1>
      <p>{t('confirm.invalidBody')}</p>
      <Button
        type="button"
        className="h-11"
        disabled={resend.isPending || resend.isSuccess}
        onClick={() => {
          resend.mutate(token);
        }}
      >
        {resend.isPending ? t('confirm.resending') : t('confirm.resend')}
      </Button>
      {resend.isSuccess && (
        <p role="status" className="text-sm text-muted-foreground">
          {t('confirm.resent')}
        </p>
      )}
      <Link to="/entrar" className="text-sm text-primary underline">
        {t('confirm.signInLink')}
      </Link>
    </section>
  );
}
