import { CreateShortcutInput, ShortcutDto } from '@finanzas/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { uuidv7 } from 'uuidv7';
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
import { ApiError, call, type Endpoint } from '@/lib/api-client';
import { messageForError } from '@/lib/i18n-errors';
import { useBackToClose } from '@/lib/use-back-to-close';

import { REGISTER_CONTEXT_KEY } from '../hooks/use-register-context';

const createShortcutEndpoint: Endpoint<CreateShortcutInput, unknown> = {
  method: 'POST',
  path: '/api/shortcuts',
  input: CreateShortcutInput,
  output: z.union([ShortcutDto, z.unknown()]),
};

/** What the form holds now, saved as a shortcut (RF-M7-10). */
export type ShortcutDraft = Omit<CreateShortcutInput, 'id' | 'name'>;

const NAME_MAX = 30;

/**
 * "Guardar como atajo" (plan §4.7.4): names the current form as a shortcut, which then shows as a
 * chip. With 12 shortcuts already, it says so and offers to manage them (EC-M7-06).
 */
export function SaveAsShortcutDialog({
  shortcut,
  onClose,
}: {
  shortcut: ShortcutDraft;
  onClose: () => void;
}) {
  const { t } = useTranslation('register');
  const queryClient = useQueryClient();
  useBackToClose(true, onClose);
  const [name, setName] = useState('');
  const [nameError, setNameError] = useState(false);
  const save = useMutation({
    mutationFn: () => call(createShortcutEndpoint, { ...shortcut, id: uuidv7(), name: name.trim() }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: REGISTER_CONTEXT_KEY });
      onClose();
    },
  });
  const limit = save.error instanceof ApiError && save.error.code === 'LIMIT_REACHED';

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('shortcut.title')}</DialogTitle>
          <DialogDescription>{t('shortcut.description')}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2">
          <Label htmlFor="shortcut-name">{t('shortcut.name')}</Label>
          <Input
            id="shortcut-name"
            className="h-11"
            value={name}
            aria-invalid={nameError}
            aria-describedby={nameError ? 'shortcut-name-error' : undefined}
            onChange={(event) => {
              setName(event.target.value);
              setNameError(false);
            }}
          />
          {nameError && (
            <p id="shortcut-name-error" className="text-sm text-destructive">
              {t('shortcut.nameError')}
            </p>
          )}
        </div>
        {limit && (
          <div role="alert" className="flex flex-col gap-2 text-sm">
            <p>{t('shortcut.limit')}</p>
            <Link
              to="/ajustes"
              className="text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {t('shortcut.manage')}
            </Link>
          </div>
        )}
        {save.isError && !limit && (
          <p role="alert" className="text-sm text-destructive">
            {messageForError(save.error instanceof ApiError ? save.error : { code: '' })}
          </p>
        )}
        <DialogFooter>
          <Button type="button" variant="ghost" className="h-11" onClick={onClose}>
            {t('shortcut.cancel')}
          </Button>
          <Button
            type="button"
            className="h-11"
            disabled={save.isPending}
            onClick={() => {
              const trimmed = name.trim();
              if (trimmed.length === 0 || trimmed.length > NAME_MAX) {
                setNameError(true);
                return;
              }
              save.mutate();
            }}
          >
            {t('shortcut.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
