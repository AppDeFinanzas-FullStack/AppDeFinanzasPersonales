import { AccountDto, ArchiveInput, RestoreInput } from '@finanzas/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router';
import { z } from 'zod';

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useFormatters } from '@/features/settings/hooks/use-settings';
import { ApiError, call, type Endpoint } from '@/lib/api-client';
import { messageForError } from '@/lib/i18n-errors';

import { useCurrencySymbol } from '../hooks/use-accounts';

import { AdjustBalanceDialog } from './adjust-balance-dialog';

const path = (id: string, action = '') => `/api/accounts/${encodeURIComponent(id)}${action}`;

const archiveEndpoint = (id: string): Endpoint<ArchiveInput, AccountDto> => ({
  method: 'POST',
  path: path(id, '/archive'),
  input: ArchiveInput,
  output: AccountDto,
});

const restoreEndpoint = (id: string): Endpoint<RestoreInput, AccountDto> => ({
  method: 'POST',
  path: path(id, '/restore'),
  input: RestoreInput,
  output: AccountDto,
});

const deleteEndpoint = (id: string): Endpoint<undefined, void> => ({
  method: 'DELETE',
  path: path(id),
  input: z.undefined(),
  output: z.void(),
});

const ZERO = '0.00';
const NAME_MAX = 40;

type Confirm = 'archive' | 'delete' | 'rename' | null;

const errorText = (error: unknown) =>
  messageForError(error instanceof ApiError ? error : { code: '' });

/**
 * Ajustar, Editar, Archivar (confirming a balance other than 0), Restaurar (asking for a new name
 * when it is taken, EC-M4-04) and Eliminar (plan §4.4.4).
 */
export function AccountActions({
  account,
  adjustOpen,
  onAdjustOpenChange,
}: {
  account: AccountDto;
  adjustOpen: boolean;
  onAdjustOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation('accounts');
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const formatters = useFormatters();
  const symbolOf = useCurrencySymbol();
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [newName, setNewName] = useState('');
  const [nameError, setNameError] = useState<string | null>(null);
  const active = account.status === 'active';
  const refresh = () => queryClient.invalidateQueries();

  const archive = useMutation({
    mutationFn: (confirmNonZero: boolean) => call(archiveEndpoint(account.id), { confirmNonZero }),
    onSuccess: async () => {
      setConfirm(null);
      await refresh();
    },
    onError: (error) => {
      // Someone else moved the balance meanwhile: ask again with the new one.
      if (error instanceof ApiError && error.code === 'ARCHIVE_CONFIRMATION_REQUIRED') {
        setConfirm('archive');
      }
    },
  });

  const restore = useMutation({
    mutationFn: (name: string | undefined) =>
      call(restoreEndpoint(account.id), name === undefined ? {} : { newName: name }),
    onSuccess: async () => {
      setConfirm(null);
      setNewName('');
      await refresh();
    },
    onError: (error, name) => {
      if (error instanceof ApiError && error.code === 'NAME_TAKEN') {
        setNameError(name === undefined ? null : t('form.errors.nameTaken'));
        setConfirm('rename');
      }
    },
  });

  const remove = useMutation({
    mutationFn: () => call(deleteEndpoint(account.id), undefined),
    onSuccess: async () => {
      setConfirm(null);
      await navigate('/cuentas', { replace: true });
      await refresh();
    },
  });

  const balance = formatters.money(account.balance, symbolOf(account.currencyCode));
  const pending = archive.isPending || restore.isPending || remove.isPending;
  const actionError = [archive, restore, remove].find(
    (mutation) =>
      mutation.isError &&
      !(
        mutation.error instanceof ApiError &&
        ['ARCHIVE_CONFIRMATION_REQUIRED', 'NAME_TAKEN'].includes(mutation.error.code)
      ),
  )?.error;

  return (
    <section aria-label={t('detail.actions')} className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-2">
        {active && (
          <Button
            type="button"
            className="h-11"
            onClick={() => {
              onAdjustOpenChange(true);
            }}
          >
            {t('form.adjust')}
          </Button>
        )}
        <Link
          to={`/cuentas/${account.id}/editar`}
          className="inline-flex h-11 items-center justify-center rounded-md border border-input bg-background px-4 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        >
          {t('detail.edit')}
        </Link>
        {active ? (
          <Button
            type="button"
            variant="outline"
            className="h-11"
            disabled={pending}
            onClick={() => {
              if (account.balance === ZERO) archive.mutate(false);
              else setConfirm('archive');
            }}
          >
            {t('detail.archive')}
          </Button>
        ) : (
          <Button
            type="button"
            variant="outline"
            className="h-11"
            disabled={pending}
            onClick={() => {
              restore.mutate(undefined);
            }}
          >
            {t('detail.restore')}
          </Button>
        )}
        <Button
          type="button"
          variant="outline"
          className="h-11 text-destructive"
          disabled={pending}
          onClick={() => {
            setConfirm('delete');
          }}
        >
          {t('detail.delete')}
        </Button>
      </div>
      {actionError !== undefined && (
        <p role="alert" className="text-sm text-destructive">
          {errorText(actionError)}
        </p>
      )}

      <AdjustBalanceDialog account={account} open={adjustOpen} onOpenChange={onAdjustOpenChange} />

      <AlertDialog
        open={confirm === 'archive'}
        onOpenChange={(open) => {
          if (!open) setConfirm(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('detail.archiveTitle', { name: account.name })}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('detail.archiveNonZero', { balance })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="h-11">{t('detail.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              className="h-11"
              onClick={(event) => {
                event.preventDefault();
                archive.mutate(true);
              }}
            >
              {t('detail.archive')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={confirm === 'delete'}
        onOpenChange={(open) => {
          if (!open) setConfirm(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('detail.deleteTitle', { name: account.name })}</AlertDialogTitle>
            <AlertDialogDescription>{t('detail.deleteDescription')}</AlertDialogDescription>
          </AlertDialogHeader>
          {remove.isError && (
            <p role="alert" className="text-sm text-destructive">
              {errorText(remove.error)}
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel className="h-11">{t('detail.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              className="h-11 bg-destructive text-destructive-foreground"
              onClick={(event) => {
                event.preventDefault();
                remove.mutate();
              }}
            >
              {t('detail.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={confirm === 'rename'}
        onOpenChange={(open) => {
          if (!open) setConfirm(null);
        }}
      >
        <AlertDialogContent>
          <form
            noValidate
            className="flex flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              const name = newName.trim();
              if (name.length === 0 || name.length > NAME_MAX) {
                setNameError(t('form.errors.name'));
                return;
              }
              setNameError(null);
              restore.mutate(name);
            }}
          >
            <AlertDialogHeader>
              <AlertDialogTitle>{t('detail.renameTitle')}</AlertDialogTitle>
              <AlertDialogDescription>
                {t('detail.renameDescription', { name: account.name })}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <div className="flex flex-col gap-2">
              <Label htmlFor="restore-name">{t('form.name')}</Label>
              <Input
                id="restore-name"
                autoComplete="off"
                maxLength={NAME_MAX}
                className="h-11"
                value={newName}
                aria-invalid={nameError !== null}
                onChange={(event) => {
                  setNewName(event.target.value);
                }}
              />
              {nameError !== null && <p className="text-sm text-destructive">{nameError}</p>}
            </div>
            <AlertDialogFooter>
              <AlertDialogCancel className="h-11">{t('detail.cancel')}</AlertDialogCancel>
              <Button type="submit" className="h-11" disabled={restore.isPending}>
                {t('detail.restore')}
              </Button>
            </AlertDialogFooter>
          </form>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
