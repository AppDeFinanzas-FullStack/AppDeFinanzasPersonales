import { IconKey } from '@finanzas/contracts';
import { icons, type LucideIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';

/** The lucide icon of a catalog key (`shopping-cart` → `ShoppingCart`). */
export function iconFor(key: string): LucideIcon | undefined {
  const name = key
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
  return icons[name as keyof typeof icons];
}

/** The catalog icons as a radio group, navigable with the arrow keys (RF-M5-04, RNF-06). */
export function IconGallery({
  value,
  onChange,
}: {
  value: IconKey;
  onChange: (icon: IconKey) => void;
}) {
  const { t } = useTranslation('categories');
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-2 text-sm font-medium">{t('form.icon')}</legend>
      <div className="flex max-h-64 flex-wrap gap-2 overflow-y-auto">
        {IconKey.options.map((key) => {
          const Icon = iconFor(key);
          return (
            <label
              key={key}
              title={key}
              className="flex h-11 w-11 cursor-pointer items-center justify-center rounded-md border border-border has-[:checked]:ring-2 has-[:checked]:ring-ring has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring"
            >
              <input
                type="radio"
                name="category-icon"
                value={key}
                aria-label={key}
                className="sr-only"
                checked={value === key}
                onChange={() => {
                  onChange(key);
                }}
              />
              {Icon !== undefined && <Icon aria-hidden className="h-5 w-5" />}
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
