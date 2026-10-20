import { MergeInput, MergePreviewDto, type CategoryNode } from '@finanzas/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
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
import { Label } from '@/components/ui/label';
import { ApiError, call, type Endpoint } from '@/lib/api-client';
import { messageForError } from '@/lib/i18n-errors';
import { useBackToClose } from '@/lib/use-back-to-close';

import { invalidateAfterCategoryChange } from './category-form';

const PreviewQuery = z.object({ from: z.string().uuid(), to: z.string().uuid() });

const previewEndpoint: Endpoint<z.infer<typeof PreviewQuery>, MergePreviewDto> = {
  method: 'GET',
  path: '/api/categories/merge-preview',
  input: PreviewQuery,
  output: MergePreviewDto,
};

const mergeEndpoint: Endpoint<MergeInput, void> = {
  method: 'POST',
  path: '/api/categories/merge',
  input: MergeInput,
  output: z.void(),
};

/** Categories of the tree that can be merged into another: no subcategories, not of the system. */
export function mergeableSources(roots: readonly CategoryNode[]): CategoryNode[] {
  return roots
    .flatMap((root) => [root, ...root.children])
    .filter((category) => !category.isSystem && category.children.length === 0);
}

/**
 * Merges A into B (RF-M5-08): the user picks B among the other active categories of the same kind
 * and sees how many movements will move before confirming. A with subcategories is never offered as
 * a source (EC-M5-02).
 */
export function MergeDialog({
  source,
  roots,
  onClose,
}: {
  source: CategoryNode;
  roots: readonly CategoryNode[];
  onClose: () => void;
}) {
  const { t } = useTranslation('categories');
  const queryClient = useQueryClient();
  useBackToClose(true, onClose);
  const targets = roots
    .flatMap((root) => [root, ...root.children])
    .filter((category) => category.id !== source.id && !category.isSystem);
  const [targetId, setTargetId] = useState('');
  const preview = useQuery({
    queryKey: ['categories', 'merge-preview', source.id, targetId],
    queryFn: ({ signal }) =>
      call(previewEndpoint, { from: source.id, to: targetId }, { signal }),
    enabled: targetId !== '',
  });
  const merge = useMutation({
    mutationFn: () => call(mergeEndpoint, { fromId: source.id, toId: targetId }),
    onSuccess: async () => {
      await invalidateAfterCategoryChange(queryClient);
      onClose();
    },
  });
  const error = preview.error ?? merge.error;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('mergeDialog.title', { name: source.name })}</DialogTitle>
          <DialogDescription>{t('mergeDialog.description')}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2">
          <Label htmlFor="merge-target">{t('mergeDialog.target')}</Label>
          <select
            id="merge-target"
            value={targetId}
            onChange={(event) => {
              setTargetId(event.target.value);
            }}
            className="flex h-11 w-full rounded-md border border-input bg-background px-3 py-2 text-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:text-sm"
          >
            <option value="">{t('mergeDialog.pick')}</option>
            {targets.map((category) => (
              <option key={category.id} value={category.id}>
                {category.name}
              </option>
            ))}
          </select>
        </div>
        {preview.data !== undefined && (
          <p className="text-sm">{t('mergeDialog.preview', { count: preview.data.movements })}</p>
        )}
        {error !== null && (
          <p role="alert" className="text-sm text-destructive">
            {messageForError(error instanceof ApiError ? error : { code: '' })}
          </p>
        )}
        <DialogFooter>
          <Button type="button" variant="ghost" className="h-11" onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button
            type="button"
            className="h-11"
            disabled={preview.data === undefined || merge.isPending}
            onClick={() => {
              merge.mutate();
            }}
          >
            {t('merge')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
