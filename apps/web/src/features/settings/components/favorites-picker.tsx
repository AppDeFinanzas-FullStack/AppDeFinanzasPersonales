import {
  MAX_FAVORITE_CATEGORIES,
  type CategoryNode,
  type FavoriteKind,
} from '@finanzas/contracts';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { useCategories } from '@/features/categories/hooks/use-categories';

interface PickerProps {
  kind: FavoriteKind;
  /** The favorites of this kind, in their order. */
  ids: readonly string[];
  onChange: (ids: string[]) => void;
}

interface CheckProps {
  category: CategoryNode;
  checked: boolean;
  disabled: boolean;
  onToggle: () => void;
}

function CategoryCheck({ category, checked, disabled, onToggle }: CheckProps) {
  return (
    <label className="flex min-h-11 flex-1 items-center gap-3">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        className="h-4 w-4 accent-[hsl(var(--primary))]"
        onChange={onToggle}
      />
      <span>{category.name}</span>
    </label>
  );
}

function PickerList({
  roots,
  ids,
  onChange,
}: {
  roots: readonly CategoryNode[];
  ids: readonly string[];
  onChange: (ids: string[]) => void;
}) {
  const { t } = useTranslation('settings');
  const [open, setOpen] = useState<ReadonlySet<string>>(
    () =>
      new Set(
        roots
          .filter((root) => root.children.some((child) => ids.includes(child.id)))
          .map((root) => root.id),
      ),
  );
  const full = ids.length >= MAX_FAVORITE_CATEGORIES;

  const toggle = (id: string) => {
    onChange(ids.includes(id) ? ids.filter((item) => item !== id) : [...ids, id]);
  };
  const check = (category: CategoryNode) => (
    <CategoryCheck
      category={category}
      checked={ids.includes(category.id)}
      disabled={full && !ids.includes(category.id)}
      onToggle={() => {
        toggle(category.id);
      }}
    />
  );

  return (
    <div className="flex flex-col">
      {roots.map((root) => {
        const expanded = open.has(root.id);
        return (
          <div key={root.id} className="flex flex-col">
            <div className="flex items-center gap-1">
              {check(root)}
              {root.children.length > 0 && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-11 w-11"
                  aria-expanded={expanded}
                  aria-label={t(
                    expanded ? 'register.favorites.collapse' : 'register.favorites.expand',
                    { name: root.name },
                  )}
                  onClick={() => {
                    const next = new Set(open);
                    if (expanded) next.delete(root.id);
                    else next.add(root.id);
                    setOpen(next);
                  }}
                >
                  {expanded ? (
                    <ChevronDown className="h-4 w-4" aria-hidden />
                  ) : (
                    <ChevronRight className="h-4 w-4" aria-hidden />
                  )}
                </Button>
              )}
            </div>
            {expanded && (
              <div className="flex flex-col pl-8">
                {root.children.map((child) => (
                  <div key={child.id} className="flex items-center">
                    {check(child)}
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/**
 * `<FavoritesPicker>` (plan §4.9.4): up to 8 favorite categories of one kind, main ones and
 * subcategories. They show first in the grid of Registrar, in the order they were chosen (RF-M7-04).
 */
export function FavoritesPicker({ kind, ids, onChange }: PickerProps) {
  const { t } = useTranslation('settings');
  const tree = useCategories({ kind, status: 'active' });

  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="pb-1 text-base font-medium">{t(`register.favorites.${kind}`)}</legend>
      <p className="text-sm text-muted-foreground">
        {t('register.favorites.count', { selected: ids.length, max: MAX_FAVORITE_CATEGORIES })}
        {ids.length >= MAX_FAVORITE_CATEGORIES && ` ${t('register.favorites.full')}`}
      </p>
      {tree.isError && tree.data === undefined && (
        <p role="alert" className="text-sm text-destructive">
          {t('register.favorites.loadError')}
        </p>
      )}
      {tree.data !== undefined && (
        <PickerList roots={tree.data} ids={ids} onChange={onChange} />
      )}
    </fieldset>
  );
}
