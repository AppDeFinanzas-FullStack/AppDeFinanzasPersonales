import { useTranslation } from 'react-i18next';

import type { DebtsView } from '../api';

const VIEWS: readonly DebtsView[] = ['debt', 'person'];

/**
 * The list by debt or by person (RF-M13-13). Toggle buttons, not tabs: the toggle reorders one list
 * and has no panels of its own for `aria-controls` to point at (RNF-06).
 */
export function ViewToggle({
  value,
  onChange,
}: {
  value: DebtsView;
  onChange: (view: DebtsView) => void;
}) {
  const { t } = useTranslation('debts');
  return (
    <div
      role="group"
      aria-label={t('view.label')}
      className="inline-grid h-11 auto-cols-fr grid-flow-col gap-1 rounded-md bg-muted p-1"
    >
      {VIEWS.map((view) => (
        <button
          key={view}
          type="button"
          aria-pressed={value === view}
          className="h-9 rounded-[calc(var(--radius)-2px)] px-3 text-sm font-medium text-muted-foreground aria-pressed:bg-background aria-pressed:text-foreground aria-pressed:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => {
            onChange(view);
          }}
        >
          {t(`view.${view}`)}
        </button>
      ))}
    </div>
  );
}
