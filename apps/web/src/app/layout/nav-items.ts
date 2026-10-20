import type { ModuleKey } from '@finanzas/contracts';
import {
  ArrowLeftRight,
  CirclePlus,
  DollarSign,
  Ellipsis,
  HandCoins,
  House,
  PiggyBank,
  Repeat,
  Settings,
  Tags,
  Target,
  User,
  Wallet,
  type LucideIcon,
} from 'lucide-react';

export type NavSection = 'plan' | 'organize' | 'account';

export interface NavItem {
  key: string;
  path: string;
  moduleKey: ModuleKey;
  icon: LucideIcon;
  end?: boolean;
}

/** The five tabs of the bottom bar; "more" exists only in this format (RF-M2-02). */
export const TAB_ITEMS: NavItem[] = [
  { key: 'home', path: '/', moduleKey: 'M8', icon: House, end: true },
  { key: 'movements', path: '/movimientos', moduleKey: 'M6', icon: ArrowLeftRight },
  { key: 'register', path: '/registrar', moduleKey: 'M7', icon: CirclePlus },
  { key: 'accounts', path: '/cuentas', moduleKey: 'M4', icon: Wallet },
  { key: 'more', path: '/mas', moduleKey: 'M2', icon: Ellipsis },
];

/** Sidebar order of spec §2.2.1: the main modules, then the sections. */
export const MAIN_ITEMS: NavItem[] = TAB_ITEMS.filter((item) => item.key !== 'more');

export const SECTION_ITEMS: Record<NavSection, NavItem[]> = {
  plan: [
    { key: 'budgets', path: '/presupuestos', moduleKey: 'M11', icon: PiggyBank },
    { key: 'goals', path: '/metas', moduleKey: 'M12', icon: Target },
    { key: 'debts', path: '/deudas', moduleKey: 'M13', icon: HandCoins },
    { key: 'recurring', path: '/recurrentes', moduleKey: 'M14', icon: Repeat },
  ],
  organize: [
    { key: 'categories', path: '/categorias', moduleKey: 'M5', icon: Tags },
    { key: 'exchangeRate', path: '/tipo-de-cambio', moduleKey: 'M3', icon: DollarSign },
  ],
  account: [
    { key: 'profile', path: '/perfil', moduleKey: 'M1', icon: User },
    { key: 'settings', path: '/ajustes', moduleKey: 'M9', icon: Settings },
  ],
};

export const SECTION_ORDER: NavSection[] = ['plan', 'organize', 'account'];

export const ALL_ITEMS: NavItem[] = [
  ...TAB_ITEMS,
  ...SECTION_ITEMS.plan,
  ...SECTION_ITEMS.organize,
  ...SECTION_ITEMS.account,
];
