import { PALETTE, PaletteKey } from '@finanzas/contracts';
import type { CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * The 12 colors of the catalog as a radio group, so the arrow keys move between them (RF-M5-04,
 * RNF-06). `null` means no color: a subcategory then takes its parent's.
 */
export function ColorPalette({
  value,
  onChange,
}: {
  value: PaletteKey | null;
  onChange: (color: PaletteKey) => void;
}) {
  const { t } = useTranslation('categories');
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-2 text-sm font-medium">{t('form.color')}</legend>
      <div className="flex flex-wrap gap-2">
        {PaletteKey.options.map((key) => {
          const swatch = {
            '--swatch-light': PALETTE[key].light,
            '--swatch-dark': PALETTE[key].dark,
          } as CSSProperties;
          return (
            <label
              key={key}
              data-testid={`color-${key}`}
              className="flex h-11 w-11 cursor-pointer items-center justify-center rounded-md border border-border has-[:checked]:ring-2 has-[:checked]:ring-ring has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring"
            >
              <input
                type="radio"
                name="category-color"
                value={key}
                className="sr-only"
                checked={value === key}
                onChange={() => {
                  onChange(key);
                }}
              />
              <span
                aria-hidden
                style={swatch}
                className="h-6 w-6 rounded-full bg-[var(--swatch-light)] dark:bg-[var(--swatch-dark)]"
              />
              <span className="sr-only">{t(`colors.${key}`)}</span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
