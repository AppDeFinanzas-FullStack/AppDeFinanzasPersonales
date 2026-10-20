import { PALETTE, type CategoryChip } from '@finanzas/contracts';
import { createElement, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { iconFor } from '@/features/categories/components/icon-gallery';

/** The accent of a category in light and dark (the 12 colors of `PALETTE`). */
export function swatchOf(color: CategoryChip['color']): CSSProperties {
  return {
    '--swatch-light': PALETTE[color].light,
    '--swatch-dark': PALETTE[color].dark,
  } as CSSProperties;
}

/** The icon of a category on its color, as shown in the grid and the full list. */
export function CategoryMark({ category }: { category: Pick<CategoryChip, 'color' | 'icon'> }) {
  const Icon = iconFor(category.icon);
  return (
    <span
      aria-hidden
      style={swatchOf(category.color)}
      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[var(--swatch-light)] text-white dark:bg-[var(--swatch-dark)] dark:text-background"
    >
      {Icon === undefined ? null : createElement(Icon, { className: 'h-4 w-4' })}
    </span>
  );
}

interface CategoryGridProps {
  chips: readonly CategoryChip[];
  /** The selected category when it came from the full list and is not in the grid. */
  extra: CategoryChip | undefined;
  selectedId: string;
  loading: boolean;
  onSelect: (category: CategoryChip) => void;
  onShowAll: () => void;
}

/**
 * `<CategoryGrid>` with the 8 categories of the kind (RF-M7-04) and "Ver todas". Each chip is a
 * toggle button, so the form is filled with Tab and Enter alone (RF-M7-12).
 */
export function CategoryGrid({
  chips,
  extra,
  selectedId,
  loading,
  onSelect,
  onShowAll,
}: CategoryGridProps) {
  const { t } = useTranslation('register');
  const shown =
    extra === undefined || chips.some((chip) => chip.id === extra.id) ? chips : [...chips, extra];

  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-2 text-sm text-muted-foreground">{t('category.label')}</legend>
      {loading ? (
        <Skeleton className="h-28 w-full" />
      ) : (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {shown.map((chip) => (
            <button
              key={chip.id}
              type="button"
              aria-pressed={selectedId === chip.id}
              className="flex min-h-11 items-center gap-2 rounded-md border border-border px-2 py-1.5 text-left text-sm aria-pressed:border-primary aria-pressed:ring-1 aria-pressed:ring-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onClick={() => {
                onSelect(chip);
              }}
            >
              <CategoryMark category={chip} />
              <span className="min-w-0 truncate">{chip.name}</span>
            </button>
          ))}
        </div>
      )}
      <Button type="button" variant="ghost" className="h-11 self-start px-2" onClick={onShowAll}>
        {t('category.all')}
      </Button>
    </fieldset>
  );
}
