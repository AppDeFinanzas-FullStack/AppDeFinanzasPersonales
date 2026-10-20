import type { IconKey, PaletteKey } from '@finanzas/contracts';

export type PresetCategory = {
  kind: 'expense' | 'income';
  name: string;
  icon: IconKey;
  color: PaletteKey;
  seedOrder: number;
  systemKey?: 'debts' | 'debts_interest';
  children?: PresetCategory[];
};

type Kind = PresetCategory['kind'];
type ChildDef = readonly [name: string, icon: IconKey];

function root(
  kind: Kind,
  seedOrder: number,
  name: string,
  icon: IconKey,
  color: PaletteKey,
  children: readonly ChildDef[] = [],
  systemKey?: 'debts',
): PresetCategory {
  const node: PresetCategory = { kind, name, icon, color, seedOrder };
  if (systemKey !== undefined) node.systemKey = systemKey;
  if (children.length > 0) {
    node.children = children.map(([childName, childIcon], index) => ({
      kind,
      name: childName,
      icon: childIcon,
      color,
      seedOrder: index,
    }));
  }
  return node;
}

function debts(kind: Kind, seedOrder: number): PresetCategory {
  return {
    kind,
    name: 'Deudas y préstamos',
    icon: 'landmark',
    color: 'slate',
    seedOrder,
    systemKey: 'debts',
    children: [
      {
        kind,
        name: 'Intereses',
        icon: 'percent',
        color: 'slate',
        seedOrder: 0,
        systemKey: 'debts_interest',
      },
    ],
  };
}

export const PRESET_CATEGORIES: readonly PresetCategory[] = [
  root('expense', 0, 'Comida', 'utensils', 'orange', [
    ['Supermercado', 'shopping-cart'],
    ['Restaurantes', 'pizza'],
  ]),
  root('expense', 1, 'Transporte', 'bus', 'blue', [
    ['Micro/Trufi', 'bus'],
    ['Taxi/Apps', 'car'],
    ['Combustible', 'fuel'],
  ]),
  root('expense', 2, 'Vivienda', 'house', 'indigo', [
    ['Alquiler', 'house'],
    ['Anticrético', 'building-2'],
  ]),
  root('expense', 3, 'Servicios', 'zap', 'amber', [
    ['Luz', 'zap'],
    ['Agua', 'droplet'],
    ['Gas', 'fuel'],
    ['Internet', 'wifi'],
    ['Celular', 'smartphone'],
    ['Comisiones bancarias', 'credit-card'],
  ]),
  root('expense', 4, 'Salud', 'heart-pulse', 'red'),
  root('expense', 5, 'Educación', 'graduation-cap', 'teal'),
  root('expense', 6, 'Ocio', 'gamepad-2', 'purple'),
  root('expense', 7, 'Ropa', 'shirt', 'pink'),
  root('expense', 8, 'Cuidado personal', 'scissors', 'rose'),
  root('expense', 9, 'Regalos', 'gift', 'cyan'),
  root('expense', 10, 'Mascotas', 'dog', 'green'),
  root('expense', 11, 'Otros gastos', 'ellipsis', 'slate'),
  debts('expense', 12),
  root('income', 0, 'Sueldo', 'wallet', 'green'),
  root('income', 1, 'Negocio/Ventas', 'briefcase', 'blue'),
  root('income', 2, 'Mesada', 'piggy-bank', 'teal'),
  root('income', 3, 'Trabajos independientes', 'laptop', 'indigo'),
  root('income', 4, 'Regalos recibidos', 'gift', 'pink'),
  root('income', 5, 'Otros ingresos', 'ellipsis', 'slate'),
  debts('income', 6),
];
