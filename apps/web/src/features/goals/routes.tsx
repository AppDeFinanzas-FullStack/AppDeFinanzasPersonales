import { useTranslation } from 'react-i18next';
import { Link, useParams, type RouteObject } from 'react-router';

import { i18n, LANGUAGE } from '@/app/providers/i18n';
import { ResourceNotFound } from '@/components/resource-not-found';
import { Separator } from '@/components/ui/separator';
import { ApiError } from '@/lib/api-client';
import goals from '@/locales/es-BO/goals.json';

import { Celebration } from './components/celebration';
import { GoalCards } from './components/goal-cards';
import { GoalHistory } from './components/goal-history';
import { GoalProgress } from './components/goal-progress';
import { ProgressByAccount } from './components/progress-by-account';
import { SuggestedBox } from './components/suggested-box';
import { useGoal, useGoals } from './hooks/use-goals';

// The feature registers its own namespace (RNF-07).
i18n.addResourceBundle(LANGUAGE, 'goals', goals, true, true);

/** `/metas` (plan §4.12.4). */
export function GoalsPage() {
  const { t } = useTranslation('goals');
  const query = useGoals();
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
      <h2 className="text-2xl font-semibold">{t('title')}</h2>
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

  return (
    <div className="flex flex-col gap-8">
      <GoalProgress goal={goal} />
      <SuggestedBox goal={goal} />
      <Separator />
      <ProgressByAccount goal={goal} />
      <GoalHistory goal={goal} history={goal.history} />
      <Celebration goal={goal} />
      <Link to="/metas" className="text-sm text-primary underline">
        {t('back')}
      </Link>
    </div>
  );
}

/** Private routes of the goals (plan §4.12.4). */
export const goalsRoutes: RouteObject[] = [
  { path: 'metas', element: <GoalsPage /> },
  { path: 'metas/:id', element: <GoalDetailPage /> },
];
