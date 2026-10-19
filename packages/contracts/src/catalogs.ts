import { z } from 'zod';

export const THEME_BACKGROUND = { light: '#ffffff', dark: '#020817' } as const;

export const PALETTE = {
  red: { light: '#b91c1c', dark: '#f87171' },
  orange: { light: '#c2410c', dark: '#fb923c' },
  amber: { light: '#b45309', dark: '#fbbf24' },
  green: { light: '#15803d', dark: '#4ade80' },
  teal: { light: '#0f766e', dark: '#2dd4bf' },
  cyan: { light: '#0e7490', dark: '#22d3ee' },
  blue: { light: '#1d4ed8', dark: '#60a5fa' },
  indigo: { light: '#4338ca', dark: '#818cf8' },
  purple: { light: '#7e22ce', dark: '#c084fc' },
  pink: { light: '#be185d', dark: '#f472b6' },
  rose: { light: '#be123c', dark: '#fb7185' },
  slate: { light: '#475569', dark: '#94a3b8' },
} as const;

const paletteKeys = Object.keys(PALETTE) as [keyof typeof PALETTE, ...(keyof typeof PALETTE)[]];

export const PaletteKey = z.enum(paletteKeys);
export type PaletteKey = z.infer<typeof PaletteKey>;

export const ICON_KEYS = [
  'utensils',
  'shopping-cart',
  'shopping-bag',
  'coffee',
  'pizza',
  'wine',
  'car',
  'bus',
  'bike',
  'fuel',
  'plane',
  'train-front',
  'house',
  'bed',
  'lamp',
  'wrench',
  'zap',
  'droplet',
  'wifi',
  'smartphone',
  'laptop',
  'tv',
  'gamepad-2',
  'music',
  'film',
  'book',
  'graduation-cap',
  'briefcase',
  'building-2',
  'heart-pulse',
  'pill',
  'stethoscope',
  'dumbbell',
  'shirt',
  'scissors',
  'baby',
  'dog',
  'cat',
  'gift',
  'cake',
  'party-popper',
  'camera',
  'palette',
  'tree-pine',
  'sun',
  'umbrella',
  'shield',
  'landmark',
  'wallet',
  'banknote',
  'piggy-bank',
  'credit-card',
  'receipt',
  'coins',
  'trending-up',
  'percent',
  'hand-coins',
  'tag',
  'star',
  'ellipsis',
] as const;

export const IconKey = z.enum(ICON_KEYS);
export type IconKey = z.infer<typeof IconKey>;
