import {
  ReorderShortcutsInput,
  ShortcutDto,
  UpdateShortcutInput,
  type AccountDto,
} from '@finanzas/contracts';
import { parseAmountInput } from '@finanzas/domain';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useAccounts, useCurrencySymbol } from '@/features/accounts/hooks/use-accounts';
import { ApiError, call, type Endpoint } from '@/lib/api-client';
import { messageForError } from '@/lib/i18n-errors';

import { useFormatters } from '../hooks/use-settings';

import { moveItem } from './favorites-picker';

const SHORTCUTS_KEY = ['shortcuts'] as const;

const ShortcutList = z.object({ items: z.array(ShortcutDto) });
type ShortcutList = z.infer<typeof ShortcutList>;

const listShortcutsEndpoint: Endpoint<undefined, ShortcutList> = {
  method: 'GET',
  path: '/api/shortcuts',
  input: z.undefined(),
  output: ShortcutList,
};

const reorderShortcutsEndpoint: Endpoint<ReorderShortcutsInput, void> = {
  method: 'PUT',
  path: '/api/shortcuts/order',
  input: ReorderShortcutsInput,
  output: z.void(),
};

const updateShortcutEndpoint = (id: string): Endpoint<UpdateShortcutInput, unknown> => ({
  method: 'PATCH',
  path: `/api/shortcuts/${id}`,
  input: UpdateShortcutInput,
  output: z.unknown(),
});

const removeShortcutEndpoint = (id: string): Endpoint<undefined, void> => ({
  method: 'DELETE',
  path: `/api/shortcuts/${id}`,
  input: z.undefined(),
  output: z.void(),
});

const NAME_MAX = 30;
const NOTE_MAX = 140;

const errorText = (error: unknown): string =>
  messageForError(error instanceof ApiError ? error : { code: '' });

/**
 * The shortcuts of Ajustes › Registrar (RF-M7-10, plan §4.9.4): edit, reorder with Subir and Bajar
 * (RNF-06) and delete. They are created from Registrar with "Guardar como atajo".
 */
export function ShortcutsManager() {
  const { t } = useTranslation('settings');
  const queryClient = useQueryClient();
  const accounts = useAccounts('active');
  const [editing, setEditing] = useState<ShortcutDto | null>(null);
  const [removing, setRemoving] = useState<ShortcutDto | null>(null);

  const shortcuts = useQuery({
    queryKey: SHORTCUTS_KEY,
    queryFn: ({ signal }) => call(listShortcutsEndpoint, undefined, { signal }),
  });

  const reorder = useMutation({
    mutationFn: (ids: string[]) => call(reorderShortcutsEndpoint, { ids }),
    onMutate: async (ids) => {
      await queryClient.cancelQueries({ queryKey: SHORTCUTS_KEY });
      const previous = queryClient.getQueryData<ShortcutList>(SHORTCUTS_KEY);
      if (previous !== undefined) {
        const byId = new Map(previous.items.map((item) => [item.id, item]));
        const items = ids.flatMap((id) => byId.get(id) ?? []);
        queryClient.setQueryData<ShortcutList>(SHORTCUTS_KEY, { items });
      }
      return { previous };
    },
    onError: (_error, _ids, context) => {
      if (context?.previous !== undefined) {
        queryClient.setQueryData(SHORTCUTS_KEY, context.previous);
      }
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: SHORTCUTS_KEY }),
  });

  if (shortcuts.isError) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {t('register.shortcuts.loadError')}
      </p>
    );
  }
  if (shortcuts.data === undefined) return null;

  const items = shortcuts.data.items;
  const ids = items.map((item) => item.id);

  return (
    <section aria-labelledby="shortcuts-title" className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h3 id="shortcuts-title" className="text-base font-medium">
          {t('register.shortcuts.title')}
        </h3>
        <p className="text-sm text-muted-foreground">{t('register.shortcuts.description')}</p>
      </div>

      {reorder.isError && (
        <p role="alert" className="text-sm text-destructive">
          {t('register.shortcuts.reorderError')}
        </p>
      )}

      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('register.shortcuts.empty')}</p>
      ) : (
        <ol className="divide-y divide-border border-y border-border">
          {items.map((shortcut, index) => (
            <li key={shortcut.id} className="flex flex-wrap items-center gap-2 py-2">
              <ShortcutSummary shortcut={shortcut} accounts={accounts.data?.items ?? []} />
              <Button
                type="button"
                variant="ghost"
                className="h-11"
                disabled={index === 0 || reorder.isPending}
                aria-label={t('register.move.up', { name: shortcut.name })}
                onClick={() => {
                  reorder.mutate(moveItem(ids, index, -1));
                }}
              >
                {t('register.move.upShort')}
              </Button>
              <Button
                type="button"
                variant="ghost"
                className="h-11"
                disabled={index === items.length - 1 || reorder.isPending}
                aria-label={t('register.move.down', { name: shortcut.name })}
                onClick={() => {
                  reorder.mutate(moveItem(ids, index, 1));
                }}
              >
                {t('register.move.downShort')}
              </Button>
              <Button
                type="button"
                variant="ghost"
                className="h-11"
                aria-label={t('register.shortcuts.edit', { name: shortcut.name })}
                onClick={() => {
                  setEditing(shortcut);
                }}
              >
                {t('register.shortcuts.editShort')}
              </Button>
              <Button
                type="button"
                variant="ghost"
                className="h-11"
                aria-label={t('register.shortcuts.remove', { name: shortcut.name })}
                onClick={() => {
                  setRemoving(shortcut);
                }}
              >
                {t('register.shortcuts.removeShort')}
              </Button>
            </li>
          ))}
        </ol>
      )}

      {editing !== null && (
        <EditShortcutDialog
          key={editing.id}
          shortcut={editing}
          onClose={() => {
            setEditing(null);
          }}
        />
      )}
      {removing !== null && (
        <RemoveShortcutDialog
          shortcut={removing}
          onClose={() => {
            setRemoving(null);
          }}
        />
      )}
    </section>
  );
}

/** The name of a shortcut with its kind and, when its account is known, its amount. */
function ShortcutSummary({
  shortcut,
  accounts,
}: {
  shortcut: ShortcutDto;
  accounts: readonly AccountDto[];
}) {
  const { t } = useTranslation('settings');
  const formatters = useFormatters();
  const symbolOf = useCurrencySymbol();
  const account = accounts.find((candidate) => candidate.id === shortcut.accountId);
  const amount =
    shortcut.amount === null || account === undefined
      ? null
      : formatters.money(shortcut.amount, symbolOf(account.currencyCode));

  return (
    <span className="flex min-w-0 flex-1 flex-col">
      <span className="text-base">{shortcut.name}</span>
      <span className="text-sm tabular-nums text-muted-foreground">
        {[t(`register.shortcuts.kind.${shortcut.kind}`), amount].filter(Boolean).join(' · ')}
      </span>
    </span>
  );
}

/** Name, amount and note of a shortcut; the account and category are kept as they are. */
function EditShortcutDialog({ shortcut, onClose }: { shortcut: ShortcutDto; onClose: () => void }) {
  const { t } = useTranslation('settings');
  const queryClient = useQueryClient();
  const [name, setName] = useState(shortcut.name);
  const [amount, setAmount] = useState(shortcut.amount ?? '');
  const [note, setNote] = useState(shortcut.note ?? '');
  const [invalid, setInvalid] = useState<'name' | 'amount' | null>(null);

  const save = useMutation({
    mutationFn: (input: UpdateShortcutInput) => call(updateShortcutEndpoint(shortcut.id), input),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: SHORTCUTS_KEY });
      onClose();
    },
  });

  const submit = (): void => {
    const trimmed = name.trim();
    if (trimmed.length === 0 || trimmed.length > NAME_MAX) {
      setInvalid('name');
      return;
    }
    const patch: UpdateShortcutInput = { name: trimmed, note: note.trim() };
    // The amount can be changed but not cleared; an empty field leaves it as it is.
    if (amount.trim() !== '') {
      const parsed = parseAmountInput(amount)?.toFixed(2);
      if (parsed === undefined) {
        setInvalid('amount');
        return;
      }
      patch.amount = parsed;
    }
    setInvalid(null);
    save.mutate(patch);
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('register.shortcuts.editTitle')}</DialogTitle>
          <DialogDescription>{t('register.shortcuts.editDescription')}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2">
          <Label htmlFor="shortcut-edit-name">{t('register.shortcuts.name')}</Label>
          <Input
            id="shortcut-edit-name"
            className="h-11"
            value={name}
            maxLength={NAME_MAX}
            aria-invalid={invalid === 'name'}
            aria-describedby={invalid === 'name' ? 'shortcut-edit-name-error' : undefined}
            onChange={(event) => {
              setName(event.target.value);
            }}
          />
          {invalid === 'name' && (
            <p id="shortcut-edit-name-error" className="text-sm text-destructive">
              {t('register.shortcuts.nameError')}
            </p>
          )}
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="shortcut-edit-amount">{t('register.shortcuts.amount')}</Label>
          <Input
            id="shortcut-edit-amount"
            className="h-11 tabular-nums"
            inputMode="decimal"
            autoComplete="off"
            value={amount}
            aria-invalid={invalid === 'amount'}
            aria-describedby={invalid === 'amount' ? 'shortcut-edit-amount-error' : undefined}
            onChange={(event) => {
              setAmount(event.target.value);
            }}
          />
          {invalid === 'amount' && (
            <p id="shortcut-edit-amount-error" className="text-sm text-destructive">
              {t('register.shortcuts.amountError')}
            </p>
          )}
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="shortcut-edit-note">{t('register.shortcuts.note')}</Label>
          <Input
            id="shortcut-edit-note"
            className="h-11"
            value={note}
            maxLength={NOTE_MAX}
            onChange={(event) => {
              setNote(event.target.value);
            }}
          />
        </div>
        {save.isError && (
          <p role="alert" className="text-sm text-destructive">
            {errorText(save.error)}
          </p>
        )}
        <DialogFooter>
          <Button type="button" variant="ghost" className="h-11" onClick={onClose}>
            {t('register.shortcuts.cancel')}
          </Button>
          <Button type="button" className="h-11" disabled={save.isPending} onClick={submit}>
            {t('register.shortcuts.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Deleting a shortcut asks first; the movements already saved do not change. */
function RemoveShortcutDialog({
  shortcut,
  onClose,
}: {
  shortcut: ShortcutDto;
  onClose: () => void;
}) {
  const { t } = useTranslation('settings');
  const queryClient = useQueryClient();
  const remove = useMutation({
    mutationFn: () => call(removeShortcutEndpoint(shortcut.id), undefined),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: SHORTCUTS_KEY });
      onClose();
    },
  });

  return (
    <AlertDialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t('register.shortcuts.removeTitle')}</AlertDialogTitle>
          <AlertDialogDescription>
            {t('register.shortcuts.removeDescription', { name: shortcut.name })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {remove.isError && (
          <p role="alert" className="text-sm text-destructive">
            {errorText(remove.error)}
          </p>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel className="h-11">{t('register.shortcuts.cancel')}</AlertDialogCancel>
          <AlertDialogAction
            className="h-11"
            disabled={remove.isPending}
            onClick={(event) => {
              event.preventDefault();
              remove.mutate();
            }}
          >
            {t('register.shortcuts.removeConfirm')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
