import type { GoalDto } from '@finanzas/contracts';
import { useMutation } from '@tanstack/react-query';
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

import { useInvalidateGoals } from './goal-form';

function buildUseAndCloseEndpoint(goalId: string): Endpoint<undefined, unknown> {
  return {
    method: 'POST',
    path: `/api/goals/${encodeURIComponent(goalId)}/use-and-close`,
    input: z.undefined(),
    output: z.unknown(),
  };
}

/** "Usar y cerrar": releases every earmark and archives the goal (RF-M12-09). */
export function UseAndCloseDialog({
  goal,
  open,
  onOpenChange,
}: {
  goal: GoalDto;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation('goals');
  const invalidate = useInvalidateGoals();
  const close = () => {
    closeGoal.reset();
    onOpenChange(false);
  };
  const closeGoal = useMutation({
    mutationFn: () => call(buildUseAndCloseEndpoint(goal.id), undefined),
    onSuccess: async () => {
      await invalidate();
      close();
    },
  });

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
          <DialogTitle>{t('useAndClose.title')}</DialogTitle>
          <DialogDescription>{t('useAndClose.description', { name: goal.name })}</DialogDescription>
        </DialogHeader>
        {closeGoal.isError && (
          <p role="alert" className="text-sm text-destructive">
            {messageForError(closeGoal.error instanceof ApiError ? closeGoal.error : { code: '' })}
          </p>
        )}
        <DialogFooter className="gap-2">
          <Button type="button" variant="outline" className="h-11" onClick={close}>
            {t('actions.cancel')}
          </Button>
          <Button
            type="button"
            className="h-11"
            disabled={closeGoal.isPending}
            onClick={() => {
              closeGoal.mutate();
            }}
          >
            {t('useAndClose.submit')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
