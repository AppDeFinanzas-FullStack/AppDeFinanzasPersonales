import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useParams } from 'react-router';

import { i18n, LANGUAGE } from '@/app/providers/i18n';
import { ResourceNotFound } from '@/components/resource-not-found';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { ApiError } from '@/lib/api-client';
import goals from '@/locales/es-BO/goals.json';

import { Celebration } from './components/celebration';
import { DedicateDialog } from './components/dedicate-dialog';
import { EarmarkDialog } from './components/earmark-dialog';
import { GoalCards } from './components/goal-cards';
import { GoalForm } from './components/goal-form';
import { GoalHistory } from './components/goal-history';
import { GoalProgress } from './components/goal-progress';
import { ProgressByAccount } from './components/progress-by-account';
import { ReleaseDialog } from './components/release-dialog';
import { SuggestedBox } from './components/suggested-box';
import { UseAndCloseDialog } from './components/use-and-close-dialog';
import { useGoal, useGoals } from './hooks/use-goals';

// The feature registers its own namespace (RNF-07).
i18n.addResourceBundle(LANGUAGE, 'goals', goals, true, true);

/** `/metas` (plan §4.12.4). */
export function GoalsPage() {
  const { t } = useTranslation('goals');
  const query = useGoals();
  const [creating, setCreating] = useState(false);
  if (query.isError && query.data === undefined) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {t('loadError')}
      </p>
    );
  }
  if (query.data === undefined) return null;
  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between gap-4">
        <h2 className="text-2xl font-semibold">{t('title')}</h2>
        <Button
          className="h-11"
          onClick={() => {
            setCreating(true);
          }}
        >
          {t('new')}
        </Button>
      </div>
      <GoalForm open={creating} onOpenChange={setCreating} />
      {query.data.items.length === 0 ? (
        <p className="text-muted-foreground">{t('empty')}</p>
      ) : (
        <GoalCards goals={query.data.items} />
      )}
    </div>
  );
}

/** `/metas/:id` (plan §4.12.4). */
export function GoalDetailPage() {
  const { t } = useTranslation('goals');
  const { id = '' } = useParams();
  const query = useGoal(id);
  const [dialog, setDialog] = useState<'earmark' | 'release' | 'dedicate' | 'close' | null>(null);

  if (query.isError && query.data === undefined) {
    if (query.error instanceof ApiError && query.error.code === 'NOT_FOUND') {
      return <ResourceNotFound />;
    }
    return (
      <p role="alert" className="text-sm text-destructive">
        {t('loadError')}
      </p>
    );
  }
  if (query.data === undefined) return null;
  const goal = query.data;
  const archived = goal.status === 'archived';
  const hasProgress = !/^0(\.0+)?$/.test(goal.progress);
  const open = (next: NonNullable<typeof dialog>) => () => {
    setDialog(next);
  };
  const onOpenChange = (next: boolean) => {
    if (!next) setDialog(null);
  };

  return (
    <div className="flex flex-col gap-8">
      <GoalProgress goal={goal} />
      {!archived && (
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" className="h-11" onClick={open('earmark')}>
            {t('actions.earmark')}
          </Button>
          {hasProgress && (
            <Button variant="outline" className="h-11" onClick={open('release')}>
              {t('actions.release')}
            </Button>
          )}
          {goal.dedicatedAccount === undefined && (
            <Button variant="outline" className="h-11" onClick={open('dedicate')}>
              {t('actions.dedicate')}
            </Button>
          )}
          {goal.status === 'achieved' && (
            <Button className="h-11" onClick={open('close')}>
              {t('actions.useAndClose')}
            </Button>
          )}
        </div>
      )}
      <SuggestedBox goal={goal} />
      <Separator />
      <ProgressByAccount goal={goal} />
      <GoalHistory goal={goal} history={goal.history} />
      <Celebration goal={goal} />
      <EarmarkDialog goal={goal} open={dialog === 'earmark'} onOpenChange={onOpenChange} />
      <ReleaseDialog goal={goal} open={dialog === 'release'} onOpenChange={onOpenChange} />
      <DedicateDialog goal={goal} open={dialog === 'dedicate'} onOpenChange={onOpenChange} />
      <UseAndCloseDialog goal={goal} open={dialog === 'close'} onOpenChange={onOpenChange} />
    </div>
  );
}
