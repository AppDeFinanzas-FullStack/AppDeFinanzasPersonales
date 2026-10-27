import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ApiError } from '@/lib/api-client';
import { messageForError } from '@/lib/i18n-errors';

type Choice = 'delete' | 'keep';

/**
 * Deleting a debt with linked movements: delete the N movements too or keep them as normal ones
 * (RF-M13-11). N comes from the API and includes the initial movement.
 */
export function DeleteDebtDialog({
  count,
  open,
  onOpenChange,
  onConfirm,
  pending,
  error,
}: {
  count: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (choice: Choice) => void;
  pending: boolean;
  error: unknown;
}) {
  const { t } = useTranslation('debts');
  const [choice, setChoice] = useState<Choice | null>(null);

  const close = () => {
    setChoice(null);
    onOpenChange(false);
  };

  const options: { value: Choice; label: string }[] = [
    { value: 'delete', label: t('delete.withMovements', { count }) },
    { value: 'keep', label: t('delete.keepMovements') },
  ];
  const failed =
    error !== null &&
    !(error instanceof ApiError && error.code === 'MOVEMENTS_CHOICE_REQUIRED');

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) onOpenChange(true);
        else close();
      }}
    >
      <DialogContent closeLabel={t('actions.close')}>
        <DialogHeader>
          <DialogTitle>{t('delete.title')}</DialogTitle>
          <DialogDescription>{t('delete.description')}</DialogDescription>
        </DialogHeader>
        <fieldset className="flex flex-col gap-2">
          <legend className="sr-only">{t('delete.title')}</legend>
          {options.map((option) => (
            <label
              key={option.value}
              className="flex min-h-11 cursor-pointer items-center gap-3 rounded-md border border-border px-3 py-2 focus-within:ring-2 focus-within:ring-ring"
            >
              <input
                type="radio"
                name="debt-movements"
                value={option.value}
                checked={choice === option.value}
                className="h-4 w-4 accent-primary"
                onChange={() => {
                  setChoice(option.value);
                }}
              />
              <span>{option.label}</span>
            </label>
          ))}
        </fieldset>
        {failed && (
          <p role="alert" className="text-sm text-destructive">
            {messageForError(error instanceof ApiError ? error : { code: '' })}
          </p>
        )}
        <DialogFooter className="gap-2">
          <Button type="button" variant="outline" className="h-11" onClick={close}>
            {t('actions.cancel')}
          </Button>
          <Button
            type="button"
            variant="destructive"
            className="h-11"
            disabled={choice === null || pending}
            onClick={() => {
              if (choice !== null) onConfirm(choice);
            }}
          >
            {t('delete.submit')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
