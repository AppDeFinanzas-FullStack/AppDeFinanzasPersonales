import type { ResumeInput } from '@finanzas/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { useFormatters } from '@/features/settings/hooks/use-settings';
import { ApiError, call, type Endpoint } from '@/lib/api-client';
import { messageForError } from '@/lib/i18n-errors';

import { RECURRING_KEY } from '../hooks/use-recurring';

const skippedEndpoint = (ruleId: string): Endpoint<undefined, { dates: string[] }> => ({
  method: 'GET',
  path: `/api/recurring/${encodeURIComponent(ruleId)}/skipped`,
  input: z.undefined(),
  output: z.object({ dates: z.array(z.string()) }),
});

const resumeEndpoint = (ruleId: string): Endpoint<ResumeInput, unknown> => ({
  method: 'POST',
  path: `/api/recurring/${encodeURIComponent(ruleId)}/resume`,
  input: z.custom<ResumeInput>((value) => typeof value === 'object' && value !== null),
  output: z.unknown(),
});

/** Asks which skipped occurrences to register when a paused rule resumes (RF-M14-09). */
export function ResumeDialog({
  ruleId,
  ruleName,
  onClose,
}: {
  ruleId: string;
  ruleName: string;
  onClose: () => void;
}) {
  const { t } = useTranslation('recurring');
  const formatters = useFormatters();
  const queryClient = useQueryClient();
  const skipped = useQuery({
    queryKey: [...RECURRING_KEY, 'skipped', ruleId],
    queryFn: ({ signal }) => call(skippedEndpoint(ruleId), undefined, { signal }),
  });
  const [unchecked, setUnchecked] = useState<ReadonlySet<string>>(new Set());
  const resume = useMutation({
    mutationFn: (input: ResumeInput) => call(resumeEndpoint(ruleId), input),
    onSuccess: async () => {
      await Promise.all(
        [RECURRING_KEY, ['transactions'], ['accounts'], ['dashboard']].map((queryKey) =>
          queryClient.invalidateQueries({ queryKey }),
        ),
      );
      onClose();
    },
  });

  const dates = skipped.data?.dates ?? [];
  const toggle = (date: string, checked: boolean) => {
    setUnchecked((current) => {
      const next = new Set(current);
      if (checked) next.delete(date);
      else next.add(date);
      return next;
    });
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent closeLabel={t('resume.close')}>
        <DialogHeader>
          <DialogTitle>{t('resume.title', { name: ruleName })}</DialogTitle>
          <DialogDescription>{t('resume.description')}</DialogDescription>
        </DialogHeader>
        {skipped.isError && (
          <p role="alert" className="text-sm text-destructive">
            {t('loadError')}
          </p>
        )}
        {skipped.data !== undefined &&
          (dates.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('resume.none')}</p>
          ) : (
            <fieldset className="flex flex-col gap-1">
              <legend className="mb-2 font-medium">
                {t('resume.question', { count: dates.length })}
              </legend>
              {dates.map((date) => (
                <div key={date} className="flex min-h-11 items-center gap-3">
                  <Checkbox
                    id={`resume-${date}`}
                    checked={!unchecked.has(date)}
                    onCheckedChange={(value) => {
                      toggle(date, value === true);
                    }}
                  />
                  <Label htmlFor={`resume-${date}`} className="tabular-nums">
                    {formatters.date(date)}
                  </Label>
                </div>
              ))}
            </fieldset>
          ))}
        {resume.isError && (
          <p role="alert" className="text-sm text-destructive">
            {messageForError(resume.error instanceof ApiError ? resume.error : { code: '' })}
          </p>
        )}
        <DialogFooter className="gap-2">
          <Button type="button" variant="outline" className="h-11" onClick={onClose}>
            {t('resume.cancel')}
          </Button>
          <Button
            type="button"
            className="h-11"
            disabled={skipped.data === undefined || resume.isPending}
            onClick={() => {
              resume.mutate({ registerDates: dates.filter((date) => !unchecked.has(date)) });
            }}
          >
            {t('resume.submit')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
