import {
  ReorderShortcutsInput,
  ShortcutDto,
  UpdateShortcutInput,
} from '@finanzas/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, Pencil, Trash2 } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';

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
import { REGISTER_CONTEXT_KEY } from '@/features/register/hooks/use-register-context';
import { ApiError, call, type Endpoint } from '@/lib/api-client';
import { messageForError } from '@/lib/i18n-errors';
import { useBackToClose } from '@/lib/use-back-to-close';

const SHORTCUTS_KEY = ['shortcuts'] as const;
const NAME_MAX = 30;

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

/** Registrar shows the shortcuts of its context, so it is refreshed with every change. */
function useRefreshShortcuts() {
  const queryClient = useQueryClient();
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: SHORTCUTS_KEY }),
      queryClient.invalidateQueries({ queryKey: REGISTER_CONTEXT_KEY }),
    ]);
}

function errorText(error: unknown): string {
  return messageForError(error instanceof ApiError ? error : { code: '' });
}

function EditShortcutDialog({
  shortcut,
  onClose,
}: {
  shortcut: ShortcutDto;
  onClose: () => void;
}) {
  const { t } = useTranslation('settings');
  const refresh = useRefreshShortcuts();
  useBackToClose(true, onClose);
  const [name, setName] = useState(shortcut.name);
  const [nameError, setNameError] = useState(false);
  const save = useMutation({
    mutationFn: (next: string) => call(updateShortcutEndpoint(shortcut.id), { name: next }),
    onSuccess: async () => {
      await refresh();
      onClose();
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (trimmed.length === 0 || trimmed.length > NAME_MAX) {
      setNameError(true);
      return;
    }
    save.mutate(trimmed);
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent>
        <form className="flex flex-col gap-4" onSubmit={submit} noValidate>
          <DialogHeader>
            <DialogTitle>{t('register.shortcuts.editTitle')}</DialogTitle>
            <DialogDescription>{t('register.shortcuts.editDescription')}</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <Label htmlFor="settings-shortcut-name">{t('register.shortcuts.name')}</Label>
            <Input
              id="settings-shortcut-name"
              className="h-11"
              value={name}
              aria-invalid={nameError}
              aria-describedby={nameError ? 'settings-shortcut-name-error' : undefined}
              onChange={(event) => {
                setName(event.target.value);
                setNameError(false);
              }}
            />
            {nameError && (
              <p id="settings-shortcut-name-error" className="text-sm text-destructive">
                {t('register.shortcuts.nameError', { max: NAME_MAX })}
              </p>
            )}
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
            <Button type="submit" className="h-11" disabled={save.isPending}>
              {t('register.shortcuts.save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function RemoveShortcutDialog({
  shortcut,
  onClose,
}: {
  shortcut: ShortcutDto;
  onClose: () => void;
}) {
  const { t } = useTranslation('settings');
  const refresh = useRefreshShortcuts();
  useBackToClose(true, onClose);
  const remove = useMutation({
    mutationFn: () => call(removeShortcutEndpoint(shortcut.id), undefined),
    onSuccess: async () => {
      await refresh();
      onClose();
    },
  });

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('register.shortcuts.removeTitle', { name: shortcut.name })}</DialogTitle>
          <DialogDescription>{t('register.shortcuts.removeDescription')}</DialogDescription>
        </DialogHeader>
        {remove.isError && (
          <p role="alert" className="text-sm text-destructive">
            {errorText(remove.error)}
          </p>
        )}
        <DialogFooter>
          <Button type="button" variant="ghost" className="h-11" onClick={onClose}>
            {t('register.shortcuts.cancel')}
          </Button>
          <Button
            type="button"
            variant="destructive"
            className="h-11"
            disabled={remove.isPending}
            onClick={() => {
              remove.mutate();
            }}
          >
            {t('register.shortcuts.removeConfirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The shortcuts of Registrar (RF-M7-10): edited, reordered with "Subir" and "Bajar" (RNF-06) and
 * deleted. They are created from Registrar with "Guardar como atajo".
 */
export function ShortcutsManager() {
  const { t } = useTranslation('settings');
  const queryClient = useQueryClient();
  const refresh = useRefreshShortcuts();
  const list = useQuery({
    queryKey: SHORTCUTS_KEY,
    queryFn: ({ signal }) => call(listShortcutsEndpoint, undefined, { signal }),
  });
  const [editing, setEditing] = useState<ShortcutDto | null>(null);
  const [removing, setRemoving] = useState<ShortcutDto | null>(null);

  const reorder = useMutation({
    mutationFn: (ids: string[]) => call(reorderShortcutsEndpoint, { ids }),
    onMutate: async (ids) => {
      await queryClient.cancelQueries({ queryKey: SHORTCUTS_KEY });
      const previous = queryClient.getQueryData<ShortcutList>(SHORTCUTS_KEY);
      if (previous !== undefined) {
        const items = ids.flatMap((id) => previous.items.filter((item) => item.id === id));
        queryClient.setQueryData<ShortcutList>(SHORTCUTS_KEY, { items });
      }
      return { previous };
    },
    onError: (_error, _ids, context) => {
      if (context?.previous !== undefined) {
        queryClient.setQueryData(SHORTCUTS_KEY, context.previous);
      }
    },
    onSettled: refresh,
  });

  if (list.isError && list.data === undefined) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {t('register.shortcuts.loadError')}
      </p>
    );
  }
  if (list.data === undefined) return null;
  const items = list.data.items;

  const move = (index: number, offset: -1 | 1) => {
    const ids = items.map((item) => item.id);
    const [moved] = ids.splice(index, 1);
    if (moved === undefined) return;
    ids.splice(index + offset, 0, moved);
    reorder.mutate(ids);
  };

  return (
    <div className="flex flex-col gap-3">
      {reorder.isError && (
        <p role="alert" className="text-sm text-destructive">
          {t('register.shortcuts.reorderError')}
        </p>
      )}
      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('register.shortcuts.empty')}</p>
      ) : (
        <ul className="divide-y divide-border border-y border-border">
          {items.map((shortcut, index) => (
            <li key={shortcut.id} className="flex flex-wrap items-center gap-1 py-1">
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-base">{shortcut.name}</span>
                <span className="text-sm text-muted-foreground">
                  {t(`register.shortcuts.kind.${shortcut.kind}`)}
                </span>
              </span>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-11 w-11"
                disabled={index === 0}
                aria-label={t('register.shortcuts.up', { name: shortcut.name })}
                onClick={() => {
                  move(index, -1);
                }}
              >
                <ArrowUp className="h-4 w-4" aria-hidden />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-11 w-11"
                disabled={index === items.length - 1}
                aria-label={t('register.shortcuts.down', { name: shortcut.name })}
                onClick={() => {
                  move(index, 1);
                }}
              >
                <ArrowDown className="h-4 w-4" aria-hidden />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-11 w-11"
                aria-label={t('register.shortcuts.edit', { name: shortcut.name })}
                onClick={() => {
                  setEditing(shortcut);
                }}
              >
                <Pencil className="h-4 w-4" aria-hidden />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-11 w-11"
                aria-label={t('register.shortcuts.remove', { name: shortcut.name })}
                onClick={() => {
                  setRemoving(shortcut);
                }}
              >
                <Trash2 className="h-4 w-4" aria-hidden />
              </Button>
            </li>
          ))}
        </ul>
      )}
      {editing !== null && (
        <EditShortcutDialog
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
    </div>
  );
}
