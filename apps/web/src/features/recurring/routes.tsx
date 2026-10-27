import type { RuleDto } from '@finanzas/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';

import { i18n, LANGUAGE } from '@/app/providers/i18n';
import { Button } from '@/components/ui/button';
import { call, type Endpoint } from '@/lib/api-client';
import recurring from '@/locales/es-BO/recurring.json';

import { PendingList } from './components/pending-list';
import { ResumeDialog } from './components/resume-dialog';
import { RuleForm } from './components/rule-form';
import { RulesList } from './components/rules-list';
import { Upcoming30 } from './components/upcoming-30';
import { RECURRING_KEY, useRecurring } from './hooks/use-recurring';

// The feature registers its own namespace (RNF-07).
i18n.addResourceBundle(LANGUAGE, 'recurring', recurring, true, true);

const pauseEndpoint = (ruleId: string): Endpoint<undefined, unknown> => ({
  method: 'POST',
  path: `/api/recurring/${encodeURIComponent(ruleId)}/pause`,
  input: z.undefined(),
  output: z.unknown(),
});

/** Pause and resume actions per rule; resuming asks about the skipped dates (RF-M14-09). */
function RuleActions({ rules }: { rules: RuleDto[] }) {
  const { t } = useTranslation('recurring');
  const queryClient = useQueryClient();
  const [resuming, setResuming] = useState<RuleDto | null>(null);
  const pause = useMutation({
    mutationFn: (ruleId: string) => call(pauseEndpoint(ruleId), undefined),
    onSettled: () => queryClient.invalidateQueries({ queryKey: RECURRING_KEY }),
  });
  const manageable = rules.filter((rule) => rule.status !== 'finished');
  if (manageable.length === 0) return null;
  return (
    <section className="flex flex-col gap-3" aria-labelledby="recurring-actions">
      <h3 id="recurring-actions" className="text-lg font-semibold">
        {t('actions.title')}
      </h3>
      <ul className="flex flex-col divide-y divide-border border-y border-border">
        {manageable.map((rule) => (
          <li key={rule.id} className="flex items-center justify-between gap-4 py-2">
            <span className="font-medium">{rule.name}</span>
            {rule.status === 'paused' ? (
              <Button
                type="button"
                variant="outline"
                className="h-11"
                onClick={() => {
                  setResuming(rule);
                }}
              >
                {t('actions.resume')}
              </Button>
            ) : (
              <Button
                type="button"
                variant="outline"
                className="h-11"
                disabled={pause.isPending}
                onClick={() => {
                  pause.mutate(rule.id);
                }}
              >
                {t('actions.pause')}
              </Button>
            )}
          </li>
        ))}
      </ul>
      {resuming !== null && (
        <ResumeDialog
          ruleId={resuming.id}
          ruleName={resuming.name}
          onClose={() => {
            setResuming(null);
          }}
        />
      )}
    </section>
  );
}

/** `/recurrentes` (plan §4.14.4). */
export function RecurringPage() {
  const { t } = useTranslation('recurring');
  const query = useRecurring();
  const [creating, setCreating] = useState(false);
  if (query.isError && query.data === undefined) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {t('loadError')}
      </p>
    );
  }
  if (query.data === undefined) return null;
  const { rules, pending, upcoming30 } = query.data;
  return (
    <div className="flex flex-col gap-8">
      <div className="flex items-center justify-between gap-4">
        <h2 className="text-2xl font-semibold">{t('title')}</h2>
        <Button
          type="button"
          className="h-11"
          onClick={() => {
            setCreating(true);
          }}
        >
          {t('newRule')}
        </Button>
      </div>
      <PendingList pending={pending} rules={rules} />
      <RulesList rules={rules} />
      <RuleActions rules={rules} />
      <Upcoming30 upcoming={upcoming30} rules={rules} />
      {creating && (
        <RuleForm
          onClose={() => {
            setCreating(false);
          }}
        />
      )}
    </div>
  );
}
