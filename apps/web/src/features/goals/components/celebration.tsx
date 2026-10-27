import type { GoalDto } from '@finanzas/contracts';
import { createElement, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useCurrencySymbol } from '@/features/accounts/hooks/use-accounts';
import { iconFor } from '@/features/categories/components/icon-gallery';
import { useFormatters } from '@/features/settings/hooks/use-settings';

import { useMarkCelebrated } from '../hooks/use-goals';

/** Shown the first time a goal is achieved; closing it marks it as celebrated (spec §2.12.2). */
export function Celebration({ goal }: { goal: GoalDto }) {
  const { t } = useTranslation('goals');
  const formatters = useFormatters();
  const symbol = useCurrencySymbol()(goal.currencyCode);
  const markCelebrated = useMarkCelebrated(goal.id);
  const [closed, setClosed] = useState(false);
  const Icon = iconFor(goal.icon);

  if (!goal.firstAchievement) return null;

  const close = () => {
    setClosed(true);
    markCelebrated.mutate();
  };

  return (
    <Dialog
      open={!closed}
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogContent closeLabel={t('celebration.close')}>
        <DialogHeader className="items-center text-center">
          {Icon === undefined
            ? null
            : createElement(Icon, { className: 'h-8 w-8', 'aria-hidden': true })}
          <DialogTitle>{t('celebration.title', { name: goal.name })}</DialogTitle>
          <DialogDescription>{t('celebration.description')}</DialogDescription>
          <p className="text-3xl font-semibold tabular-nums">
            {formatters.money(goal.progress, symbol)}
          </p>
        </DialogHeader>
        <Button onClick={close}>{t('celebration.close')}</Button>
      </DialogContent>
    </Dialog>
  );
}
