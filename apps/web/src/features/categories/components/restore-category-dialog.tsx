import { RestoreCategoryInput, type CategoryNode } from '@finanzas/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
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
import { ApiError, call, type Endpoint } from '@/lib/api-client';
import { messageForError } from '@/lib/i18n-errors';
import { useBackToClose } from '@/lib/use-back-to-close';

import { invalidateAfterCategoryChange } from './category-form';

const restoreEndpoint = (id: string): Endpoint<RestoreCategoryInput, void> => ({
  method: 'POST',
  path: `/api/categories/${encodeURIComponent(id)}/restore`,
  input: RestoreCategoryInput,
  output: z.void(),
});

/**
 * Restores an archived category with the subcategories the user picks; a name already in use can be
 * changed here (EC-M5-04). A subcategory whose parent is archived gets PARENT_ARCHIVED (EC-M5-06).
 */
export function RestoreCategoryDialog({
  category,
  onClose,
}: {
  category: CategoryNode;
  onClose: () => void;
}) {
  const { t } = useTranslation('categories');
  const queryClient = useQueryClient();
  useBackToClose(true, onClose);
  const [childIds, setChildIds] = useState<string[]>(category.children.map((child) => child.id));
  const [newName, setNewName] = useState('');
  const restore = useMutation({
    mutationFn: () =>
      call(restoreEndpoint(category.id), {
        childIds,
        ...(newName.trim() === '' ? {} : { newName: newName.trim() }),
      }),
    onSuccess: async () => {
      await invalidateAfterCategoryChange(queryClient);
      onClose();
    },
  });
  const nameTaken = restore.error instanceof ApiError && restore.error.code === 'NAME_TAKEN';

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('restoreDialog.title', { name: category.name })}</DialogTitle>
          <DialogDescription>{t('restoreDialog.description')}</DialogDescription>
        </DialogHeader>
        {category.children.length > 0 && (
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-2 text-sm font-medium">{t('restoreDialog.children')}</legend>
            {category.children.map((child) => (
              <label key={child.id} className="flex min-h-11 items-center gap-3">
                <input
                  type="checkbox"
                  className="h-4 w-4"
                  checked={childIds.includes(child.id)}
                  onChange={(event) => {
                    setChildIds(
                      event.target.checked
                        ? [...childIds, child.id]
                        : childIds.filter((id) => id !== child.id),
                    );
                  }}
                />
                {child.name}
              </label>
            ))}
          </fieldset>
        )}
        {nameTaken && (
          <div className="flex flex-col gap-2">
            <Label htmlFor="restore-name">{t('restoreDialog.newName')}</Label>
            <Input
              id="restore-name"
              className="h-11"
              value={newName}
              onChange={(event) => {
                setNewName(event.target.value);
              }}
            />
          </div>
        )}
        {restore.isError && (
          <p role="alert" className="text-sm text-destructive">
            {messageForError(restore.error instanceof ApiError ? restore.error : { code: '' })}
          </p>
        )}
        <DialogFooter>
          <Button type="button" variant="ghost" className="h-11" onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button
            type="button"
            className="h-11"
            disabled={restore.isPending}
            onClick={() => {
              restore.mutate();
            }}
          >
            {t('restore')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
