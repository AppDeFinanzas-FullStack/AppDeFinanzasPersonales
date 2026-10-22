import { IconKey } from '@finanzas/contracts';
import {
  Baby,
  Banknote,
  Bed,
  Bike,
  Book,
  Briefcase,
  Building2,
  Bus,
  Cake,
  Camera,
  Car,
  Cat,
  Coffee,
  Coins,
  CreditCard,
  Dog,
  Droplet,
  Dumbbell,
  Ellipsis,
  Film,
  Fuel,
  Gamepad2,
  Gift,
  GraduationCap,
  HandCoins,
  HeartPulse,
  House,
  Lamp,
  Landmark,
  Laptop,
  Music,
  Palette,
  PartyPopper,
  Percent,
  Pill,
  PiggyBank,
  Pizza,
  Plane,
  Receipt,
  Scissors,
  Shield,
  Shirt,
  ShoppingBag,
  ShoppingCart,
  Smartphone,
  Star,
  Stethoscope,
  Sun,
  Tag,
  TrainFront,
  TreePine,
  TrendingUp,
  Tv,
  Umbrella,
  Utensils,
  Wallet,
  Wifi,
  Wine,
  Wrench,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';

/**
 * The lucide icon of each catalog key. Naming the icons one by one keeps the 1,700 icons of
 * lucide-react out of the bundle (RNF-01).
 */
const ICONS: Record<IconKey, LucideIcon> = {
  utensils: Utensils,
  'shopping-cart': ShoppingCart,
  'shopping-bag': ShoppingBag,
  coffee: Coffee,
  pizza: Pizza,
  wine: Wine,
  car: Car,
  bus: Bus,
  bike: Bike,
  fuel: Fuel,
  plane: Plane,
  'train-front': TrainFront,
  house: House,
  bed: Bed,
  lamp: Lamp,
  wrench: Wrench,
  zap: Zap,
  droplet: Droplet,
  wifi: Wifi,
  smartphone: Smartphone,
  laptop: Laptop,
  tv: Tv,
  'gamepad-2': Gamepad2,
  music: Music,
  film: Film,
  book: Book,
  'graduation-cap': GraduationCap,
  briefcase: Briefcase,
  'building-2': Building2,
  'heart-pulse': HeartPulse,
  pill: Pill,
  stethoscope: Stethoscope,
  dumbbell: Dumbbell,
  shirt: Shirt,
  scissors: Scissors,
  baby: Baby,
  dog: Dog,
  cat: Cat,
  gift: Gift,
  cake: Cake,
  'party-popper': PartyPopper,
  camera: Camera,
  palette: Palette,
  'tree-pine': TreePine,
  sun: Sun,
  umbrella: Umbrella,
  shield: Shield,
  landmark: Landmark,
  wallet: Wallet,
  banknote: Banknote,
  'piggy-bank': PiggyBank,
  'credit-card': CreditCard,
  receipt: Receipt,
  coins: Coins,
  'trending-up': TrendingUp,
  percent: Percent,
  'hand-coins': HandCoins,
  tag: Tag,
  star: Star,
  ellipsis: Ellipsis,
};

/** The lucide icon of a catalog key (`shopping-cart` → `ShoppingCart`). */
export function iconFor(key: string): LucideIcon | undefined {
  const parsed = IconKey.safeParse(key);
  return parsed.success ? ICONS[parsed.data] : undefined;
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
