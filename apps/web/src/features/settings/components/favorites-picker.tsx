import { MAX_FAVORITE_CATEGORIES, type CategoryNode, type FavoriteKind } from '@finanzas/contracts';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { useCategories } from '@/features/categories/hooks/use-categories';

interface CategoryOption {
  id: string;
  label: string;
}

/** The categories of a kind with their subcategories as "Parent › Child" (RF-M7-04). */
function flatten(nodes: readonly CategoryNode[]): CategoryOption[] {
  return nodes.flatMap((node) => [
    { id: node.id, label: node.name },
    ...node.children.map((child) => ({ id: child.id, label: `${node.name} › ${child.name}` })),
  ]);
}

/** A copy of `list` with the item at `index` moved `delta` places (Subir / Bajar, RNF-06). */
export function moveItem<T>(list: readonly T[], index: number, delta: -1 | 1): T[] {
  const target = index + delta;
  const next = [...list];
  const [item] = next.splice(index, 1);
  if (item === undefined || target < 0 || target > next.length) return [...list];
  next.splice(target, 0, item);
  return next;
}

interface FavoritesPickerProps {
  kind: FavoriteKind;
  /** The favorite ids in their order. */
  selected: readonly string[];
  onChange: (ids: string[]) => void;
}

/**
 * `<FavoritesPicker>` (plan §4.9.4): up to 8 favorite categories of one kind, which Registrar shows
 * first and in this order (RF-M7-04). The order changes with the Subir and Bajar buttons.
 */
export function FavoritesPicker({ kind, selected, onChange }: FavoritesPickerProps) {
  const { t } = useTranslation('settings');
  const categories = useCategories({ kind, status: 'active' });

  if (categories.isError) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {t('register.favorites.loadError')}
      </p>
    );
  }
  if (categories.data === undefined) return null;

  const options = flatten(categories.data);
  const labels = new Map(options.map((option) => [option.id, option.label]));
  // An archived favorite is no longer in the list, and Registrar never shows it.
  const ids = selected.filter((id) => labels.has(id));
  const full = ids.length >= MAX_FAVORITE_CATEGORIES;
  const headingId = `favorites-${kind}`;

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between gap-4">
        <h3 id={headingId} className="text-base font-medium">
          {t(`register.favorites.${kind}.title`)}
        </h3>
        <p className="text-sm tabular-nums text-muted-foreground">
          {t('register.favorites.count', { count: ids.length, max: MAX_FAVORITE_CATEGORIES })}
        </p>
      </div>

      {ids.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('register.favorites.empty')}</p>
      ) : (
        <ol className="divide-y divide-border border-y border-border">
          {ids.map((id, index) => {
            const label = labels.get(id) ?? id;
            return (
              <li key={id} className="flex flex-wrap items-center gap-2 py-2">
                <span className="min-w-0 flex-1 text-base">{label}</span>
                <Button
                  type="button"
                  variant="ghost"
                  className="h-11"
                  disabled={index === 0}
                  aria-label={t('register.move.up', { name: label })}
                  onClick={() => {
                    onChange(moveItem(ids, index, -1));
                  }}
                >
                  {t('register.move.upShort')}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  className="h-11"
                  disabled={index === ids.length - 1}
                  aria-label={t('register.move.down', { name: label })}
                  onClick={() => {
                    onChange(moveItem(ids, index, 1));
                  }}
                >
                  {t('register.move.downShort')}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  className="h-11"
                  aria-label={t('register.favorites.remove', { name: label })}
                  onClick={() => {
                    onChange(ids.filter((other) => other !== id));
                  }}
                >
                  {t('register.favorites.removeShort')}
                </Button>
              </li>
            );
          })}
        </ol>
      )}

      <div className="flex flex-col gap-2">
        <h4 className="text-sm font-medium">{t('register.favorites.add')}</h4>
        {full && (
          <p className="text-sm text-muted-foreground">{t('register.favorites.full')}</p>
        )}
        <ul className="flex flex-wrap gap-2">
          {options
            .filter((option) => !ids.includes(option.id))
            .map((option) => (
              <li key={option.id}>
                <Button
                  type="button"
                  variant="outline"
                  className="h-11 rounded-full"
                  disabled={full}
                  aria-label={t('register.favorites.addOne', { name: option.label })}
                  onClick={() => {
                    onChange([...ids, option.id]);
                  }}
                >
                  {option.label}
                </Button>
              </li>
            ))}
        </ul>
      </div>
    </section>
  );
}
