import { BatchDeleteInput, BatchRecategorizeInput, UndoInput } from '@finanzas/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';

import { Button } from '@/components/ui/button';
import { useCategories } from '@/features/categories/hooks/use-categories';
import { ApiError, call, type Endpoint } from '@/lib/api-client';
import { messageForError } from '@/lib/i18n-errors';

const BatchResult = z.object({
  processed: z.number().int(),
  skipped: z.number().int(),
  undoToken: z.string().nullable(),
});
type BatchResult = z.infer<typeof BatchResult>;

const batchDeleteEndpoint: Endpoint<BatchDeleteInput, BatchResult> = {
  method: 'POST',
  path: '/api/transactions/batch-delete',
  input: BatchDeleteInput,
  output: BatchResult,
};

const batchRecategorizeEndpoint: Endpoint<BatchRecategorizeInput, BatchResult> = {
  method: 'POST',
  path: '/api/transactions/batch-recategorize',
  input: BatchRecategorizeInput,
  output: BatchResult,
};

const undoEndpoint: Endpoint<UndoInput, void> = {
  method: 'POST',
  path: '/api/transactions/undo',
  input: UndoInput,
  output: z.void(),
};

/** What a batch action can change on other screens. */
const AFFECTED = ['transactions', 'accounts', 'dashboard', 'budgets'];

/**
 * Actions over the selected movements (plan §4.6.4, RF-M6-13): delete or recategorize them all.
 * Afterwards it says how many were left out and offers a single "Deshacer".
 */
export function BatchToolbar({ ids, onDone }: { ids: readonly string[]; onDone: () => void }) {
  const { t } = useTranslation('transactions');
  const queryClient = useQueryClient();
  const expense = useCategories({ kind: 'expense', status: 'active' });
  const income = useCategories({ kind: 'income', status: 'active' });
  const [categoryId, setCategoryId] = useState('');
  const [result, setResult] = useState<BatchResult | null>(null);

  const refresh = () =>
    Promise.all(AFFECTED.map((key) => queryClient.invalidateQueries({ queryKey: [key] })));

  const run = useMutation({
    mutationFn: (action: 'delete' | 'recategorize') =>
      action === 'delete'
        ? call(batchDeleteEndpoint, { ids: [...ids] })
        : call(batchRecategorizeEndpoint, { ids: [...ids], categoryId }),
    onSuccess: async (batch) => {
      setResult(batch);
      onDone();
      await refresh();
    },
  });
  const undo = useMutation({
    mutationFn: (undoToken: string) => call(undoEndpoint, { undoToken }),
    onSuccess: async () => {
      setResult(null);
      await refresh();
    },
  });

  const categories = [...(expense.data ?? []), ...(income.data ?? [])].flatMap((root) => [
    root,
    ...root.children,
  ]);
  const error = run.error ?? undo.error;
  if (ids.length === 0 && result === null && error === null) return null;

  return (
    <div
      role="region"
      aria-label={t('batch.toolbar')}
      className="sticky bottom-20 z-10 flex flex-col gap-3 rounded-md border border-border bg-background p-4 shadow-md lg:bottom-4"
    >
      {ids.length > 0 && (
        <>
          <p className="text-sm font-medium" aria-live="polite">
            {t('batch.count', { count: ids.length })}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="destructive"
              className="h-11"
              disabled={run.isPending}
              onClick={() => {
                run.mutate('delete');
              }}
            >
              {t('batch.delete')}
            </Button>
            <label htmlFor="batch-category" className="sr-only">
              {t('batch.category')}
            </label>
            <select
              id="batch-category"
              value={categoryId}
              onChange={(event) => {
                setCategoryId(event.target.value);
              }}
              className="h-11 rounded-md border border-input bg-background px-3 text-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:text-sm"
            >
              <option value="">{t('batch.category')}</option>
              {categories.map((category) => (
                <option key={category.id} value={category.id}>
                  {category.name}
                </option>
              ))}
            </select>
            <Button
              type="button"
              variant="secondary"
              className="h-11"
              disabled={categoryId === '' || run.isPending}
              onClick={() => {
                run.mutate('recategorize');
              }}
            >
              {t('batch.recategorize')}
            </Button>
            <Button type="button" variant="ghost" className="h-11" onClick={onDone}>
              {t('batch.clear')}
            </Button>
          </div>
        </>
      )}
      {result !== null && (
        <div className="flex flex-wrap items-center gap-3" aria-live="polite">
          <p className="text-sm">
            {t('batch.done', { count: result.processed })}
            {result.skipped > 0 && ` ${t('batch.skipped', { count: result.skipped })}`}
          </p>
          {result.undoToken !== null && (
            <Button
              type="button"
              variant="secondary"
              className="h-11"
              disabled={undo.isPending}
              onClick={() => {
                if (result.undoToken !== null) undo.mutate(result.undoToken);
              }}
            >
              {t('batch.undo')}
            </Button>
          )}
        </div>
      )}
      {error !== null && (
        <p role="alert" className="text-sm text-destructive">
          {messageForError(error instanceof ApiError ? error : { code: '' })}
        </p>
      )}
    </div>
  );
}
