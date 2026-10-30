import { useTranslation } from 'react-i18next';

import { i18n, LANGUAGE } from '@/app/providers/i18n';
import navigation from '@/locales/es-BO/navigation.json';

// The access screens can render before the AppShell registers this namespace (RNF-07).
i18n.addResourceBundle(LANGUAGE, 'navigation', navigation, true, true);

/** Pixel size of the mark: 24 px in the header and 48 px over the access screens (RF-M2-14). */
const SIZE = { header: 24, public: 48 } as const;

interface BrandMarkProps {
  size: keyof typeof SIZE;
  className?: string;
}

/**
 * The brand logo (docs/design-direction.md, "Marca"). Its fixed width and height reserve the space
 * before the file loads, so the title next to it does not move. The same file serves both themes.
 */
export function BrandMark({ size, className }: BrandMarkProps) {
  const { t } = useTranslation('navigation');
  const px = SIZE[size];
  return <img src="/logo.svg" alt={t('brand')} width={px} height={px} className={className} />;
}
