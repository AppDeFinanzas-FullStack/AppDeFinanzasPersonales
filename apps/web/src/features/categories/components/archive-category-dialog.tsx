import { ArchiveImpactDto, type CategoryNode } from '@finanzas/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
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
import { ApiError, call, type Endpoint } from '@/lib/api-client';
import { messageForError } from '@/lib/i18n-errors';
import { useBackToClose } from '@/lib/use-back-to-close';

import { invalidateAfterCategoryChange } from './category-form';

const impactEndpoint = (id: string): Endpoint<undefined, ArchiveImpactDto> => ({
  method: 'GET',
  path: `/api/categories/${encodeURIComponent(id)}/archive-impact`,
  input: z.undefined(),
  output: ArchiveImpactDto,
});

const archiveEndpoint = (id: string): Endpoint<undefined, void> => ({
  method: 'POST',
  path: `/api/categories/${encodeURIComponent(id)}/archive`,
  input: z.undefined(),
  output: z.void(),
});

/** Lists what archiving affects before confirming (RF-M5-07). */
export function ArchiveCategoryDialog({
  category,
  onClose,
}: {
  category: CategoryNode;
  onClose: () => void;
}) {
  const { t } = useTranslation('categories');
  const queryClient = useQueryClient();
  useBackToClose(true, onClose);
  const impact = useQuery({
    queryKey: ['categories', 'archive-impact', category.id],
    queryFn: ({ signal }) => call(impactEndpoint(category.id), undefined, { signal }),
  });
  const archive = useMutation({
    mutationFn: () => call(archiveEndpoint(category.id), undefined),
    onSuccess: async () => {
      await invalidateAfterCategoryChange(queryClient);
      onClose();
    },
  });

  const lists: { key: 'children' | 'recurring' | 'shortcuts'; names: string[] }[] = [
    { key: 'children', names: impact.data?.children.map((item) => item.name) ?? [] },
    { key: 'recurring', names: impact.data?.recurring.map((item) => item.name) ?? [] },
    { key: 'shortcuts', names: impact.data?.shortcuts.map((item) => item.name) ?? [] },
  ];
  const budgets = impact.data?.budgets.length ?? 0;
  const empty = lists.every((list) => list.names.length === 0) && budgets === 0;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('archiveDialog.title', { name: category.name })}</DialogTitle>
          <DialogDescription>{t('archiveDialog.description')}</DialogDescription>
        </DialogHeader>
        {impact.data !== undefined && (
          <div className="flex flex-col gap-3 text-sm">
            {empty && <p>{t('archiveDialog.noImpact')}</p>}
            {lists
              .filter((list) => list.names.length > 0)
              .map((list) => (
                <section key={list.key}>
                  <h3 className="font-medium">{t(`archiveDialog.${list.key}`)}</h3>
                  <ul className="list-inside list-disc text-muted-foreground">
                    {list.names.map((name) => (
                      <li key={name}>{name}</li>
                    ))}
                  </ul>
                </section>
              ))}
            {budgets > 0 && <p>{t('archiveDialog.budgets', { count: budgets })}</p>}
          </div>
        )}
        {archive.isError && (
          <p role="alert" className="text-sm text-destructive">
            {messageForError(archive.error instanceof ApiError ? archive.error : { code: '' })}
          </p>
        )}
        <DialogFooter>
          <Button type="button" variant="ghost" className="h-11" onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button
            type="button"
            className="h-11"
            disabled={impact.data === undefined || archive.isPending}
            onClick={() => {
              archive.mutate();
            }}
          >
            {t('archive')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
