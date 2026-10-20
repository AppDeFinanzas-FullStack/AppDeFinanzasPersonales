import { DeleteAccountInput } from '@finanzas/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';
import { z } from 'zod';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ApiError, call, type Endpoint } from '@/lib/api-client';
import { clearAllDrafts } from '@/lib/drafts';
import { messageForError } from '@/lib/i18n-errors';

const CONFIRMATION_WORD = 'ELIMINAR';

const deleteAccountEndpoint: Endpoint<DeleteAccountInput, void> = {
  method: 'POST',
  path: '/api/me/delete',
  input: DeleteAccountInput,
  output: z.void(),
};

/** `/perfil/eliminar`: asks for the password and the word ELIMINAR (RF-M1-15, EC-M1-08). */
export function DeleteAccount({ userId }: { userId: string }) {
  const { t } = useTranslation('profile');
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [password, setPassword] = useState('');
  const [word, setWord] = useState('');
  const [fieldError, setFieldError] = useState<'password' | 'word' | null>(null);

  const remove = useMutation({
    mutationFn: (input: DeleteAccountInput) => call(deleteAccountEndpoint, input),
    onSuccess: async () => {
      clearAllDrafts(userId);
      await navigate('/entrar', { replace: true });
      queryClient.clear();
    },
  });

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (password.length === 0) {
      setFieldError('password');
      return;
    }
    if (word !== CONFIRMATION_WORD) {
      setFieldError('word');
      return;
    }
    setFieldError(null);
    remove.mutate({ password, confirmation: CONFIRMATION_WORD });
  };

  return (
    <section aria-labelledby="delete-account" className="flex flex-col gap-4">
      <h1 id="delete-account" className="text-2xl font-semibold">
        {t('delete.title')}
      </h1>
      <p className="text-sm text-muted-foreground">{t('delete.intro')}</p>
      <ul className="list-disc pl-5 text-sm text-muted-foreground">
        <li>{t('delete.itemData')}</li>
        <li>{t('delete.itemSessions')}</li>
        <li>{t('delete.itemIrreversible')}</li>
      </ul>
      <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <Label htmlFor="delete-password">{t('delete.password')}</Label>
          <Input
            id="delete-password"
            type="password"
            autoComplete="current-password"
            className="h-11"
            value={password}
            aria-invalid={fieldError === 'password'}
            onChange={(event) => {
              setPassword(event.target.value);
            }}
          />
          {fieldError === 'password' && (
            <p className="text-sm text-destructive">{t('delete.errors.password')}</p>
          )}
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="delete-word">{t('delete.word')}</Label>
          <Input
            id="delete-word"
            type="text"
            autoComplete="off"
            className="h-11"
            value={word}
            aria-invalid={fieldError === 'word'}
            onChange={(event) => {
              setWord(event.target.value);
            }}
          />
          {fieldError === 'word' && (
            <p className="text-sm text-destructive">{t('delete.errors.word')}</p>
          )}
        </div>
        {remove.isError && (
          <p role="alert" className="text-sm text-destructive">
            {messageForError(remove.error instanceof ApiError ? remove.error : { code: '' })}
          </p>
        )}
        <Button type="submit" variant="destructive" className="h-11" disabled={remove.isPending}>
          {remove.isPending ? t('delete.submitting') : t('delete.submit')}
        </Button>
      </form>
    </section>
  );
}
