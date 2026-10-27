import type { ComponentType } from 'react';
import { useTranslation } from 'react-i18next';
import { createBrowserRouter, Navigate, Outlet, type RouteObject } from 'react-router';

import { useMe } from '@/features/auth/hooks/use-me';
import { preferencesReleased } from '@/features/settings/hooks/use-notification-preferences';

import { ReleaseGate, RequireOnboardingDone, RequireSession, warmUpSession } from './guards';
import { AppShell } from './layout/app-shell';
import { MoreMenu } from './layout/more-menu';
import { queryClient } from './providers/query-client';

function RootLayout() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <Outlet />
    </div>
  );
}

function PublicLayout() {
  return (
    <main>
      <Outlet />
    </main>
  );
}

export function NotFoundPage() {
  const { t } = useTranslation('errors');
  return (
    <section className="flex min-h-screen items-center justify-center p-6">
      <h1 className="text-lg font-semibold">{t('NOT_FOUND')}</h1>
    </section>
  );
}

/**
 * The screen of a route, downloaded only when the user enters it (RNF-01, RNF-03). The chunk of a
 * feature also carries its i18n namespace, which its module registers on load.
 */
function screen<Name extends string>(
  load: () => Promise<Record<Name, ComponentType>>,
  name: Name,
): Pick<RouteObject, 'lazy'> {
  return {
    lazy: async () => {
      const module = await load();
      return { Component: module[name] };
    },
  };
}

const auth = () => import('@/features/auth/routes');
const onboarding = () => import('@/features/onboarding/routes');
const dashboard = () => import('@/features/dashboard/routes');
const transactions = () => import('@/features/transactions/routes');
const register = () => import('@/features/register/routes');
const accounts = () => import('@/features/accounts/routes');
const categories = () => import('@/features/categories/routes');
const fx = () => import('@/features/fx/routes');
const profile = () => import('@/features/profile/routes');
const settings = () => import('@/features/settings/routes');
const goals = () => import('@/features/goals/routes');
const recurring = () => import('@/features/recurring/routes');
const debts = () => import('@/features/debts/routes');
const budgets = () => import('@/features/budgets/routes');

/** Public routes of M1 (plan §4.1.4). */
const authRoutes: RouteObject[] = [
  { path: 'registro', ...screen(auth, 'SignUpForm') },
  { path: 'entrar', ...screen(auth, 'SignInForm') },
  { path: 'revisa-tu-correo', ...screen(auth, 'CheckEmail') },
  { path: 'confirmar', ...screen(auth, 'ConfirmLink') },
  { path: 'olvide-mi-contrasena', ...screen(auth, 'ForgotPasswordForm') },
  { path: 'restablecer', ...screen(auth, 'ResetPasswordForm') },
];

/**
 * The private route of the Onboarding, outside the app shell (plan §4.10.4). Signing in sends a
 * user with the Onboarding pending to `/onboarding`, which leads to the page (RF-M10-01).
 */
const onboardingRoutes: RouteObject[] = [
  { path: 'bienvenida', ...screen(onboarding, 'OnboardingPage') },
  { path: 'onboarding', element: <Navigate to="/bienvenida" replace /> },
];

/** The private route of the Inicio (plan §4.8.4). */
const dashboardRoutes: RouteObject[] = [{ index: true, ...screen(dashboard, 'DashboardPage') }];

const transactionsRoutes: RouteObject[] = [
  { path: 'movimientos', ...screen(transactions, 'TransactionsPage') },
  { path: 'movimientos/:id', ...screen(transactions, 'TransactionDetailPage') },
];

/** Private routes of Registrar (plan §4.7.4). */
const registerRoutes: RouteObject[] = [{ path: 'registrar', ...screen(register, 'RegisterPage') }];

/** Private routes of the accounts (plan §4.4.4). */
const accountsRoutes: RouteObject[] = [
  { path: 'cuentas', ...screen(accounts, 'AccountsPage') },
  { path: 'cuentas/nueva', ...screen(accounts, 'NewAccountPage') },
  { path: 'cuentas/:id', ...screen(accounts, 'AccountDetailPage') },
  { path: 'cuentas/:id/editar', ...screen(accounts, 'EditAccountPage') },
];

const categoriesRoutes: RouteObject[] = [
  { path: 'categorias', ...screen(categories, 'CategoriesPage') },
  { path: 'categorias/nueva', ...screen(categories, 'CategoryFormPage') },
  { path: 'categorias/archivadas', ...screen(categories, 'ArchivedCategoriesPage') },
  { path: 'categorias/:id/editar', ...screen(categories, 'CategoryFormPage') },
];

/** Private routes of the budgets (plan §4.11.4), only from the release that includes M11. */
const budgetsRoutes: RouteObject[] = [
  {
    element: <ReleaseGate module="M11" notFound={<NotFoundPage />} />,
    children: [
      { path: 'presupuestos', ...screen(budgets, 'BudgetsPage') },
      { path: 'presupuestos/:id', ...screen(budgets, 'BudgetDetailPage') },
    ],
  },
];

/** Private routes of the goals (plan §4.12.4). */
const goalsRoutes: RouteObject[] = [
  { path: 'metas', ...screen(goals, 'GoalsPage') },
  { path: 'metas/:id', ...screen(goals, 'GoalDetailPage') },
];

/** Private route of the recurring rules (plan §4.14.4). */
const recurringRoutes: RouteObject[] = [
  { path: 'recurrentes', ...screen(recurring, 'RecurringPage') },
];

/** Private routes of the debts and loans (plan §4.13.4). */
const debtsRoutes: RouteObject[] = [
  { path: 'deudas', ...screen(debts, 'DebtsPage') },
  { path: 'deudas/:id', ...screen(debts, 'DebtDetailPage') },
];

/** Private routes of the exchange rate (plan §4.3.4). */
const fxRoutes: RouteObject[] = [{ path: 'tipo-de-cambio', ...screen(fx, 'ExchangeRatePage') }];

const profileRoutes: RouteObject[] = [
  { path: 'perfil', ...screen(profile, 'ProfilePage') },
  { path: 'perfil/eliminar', ...screen(profile, 'DeleteAccountPage') },
];

/** `/ajustes/recordatorios` exists only from the V1.2 on (RF-M15-07, plan §4.15.4). */
function PreferencesGate() {
  const me = useMe();
  if (!me.data) return null;
  return preferencesReleased(me.data.release) ? <Outlet /> : <NotFoundPage />;
}

/** Private routes of Ajustes (plan §4.9.4). */
const settingsRoutes: RouteObject[] = [
  { path: 'ajustes', ...screen(settings, 'SettingsHub') },
  { path: 'ajustes/general', ...screen(settings, 'GeneralSettings') },
  { path: 'ajustes/monedas', ...screen(settings, 'CurrencySettings') },
  { path: 'ajustes/registrar', ...screen(settings, 'RegisterSettings') },
  { path: 'ajustes/inicio', ...screen(settings, 'BlocksOrderList') },
  {
    element: <PreferencesGate />,
    children: [{ path: 'ajustes/recordatorios', ...screen(settings, 'PreferencesList') }],
  },
];

export const router = createBrowserRouter([
  {
    path: '/',
    element: <RootLayout />,
    // The first screen is downloaded after the entry package: nothing to show meanwhile.
    HydrateFallback: () => null,
    children: [
      {
        element: <PublicLayout />,
        children: authRoutes,
      },
      {
        element: <RequireSession />,
        // Starts the session request while the screen of the route downloads (RNF-01, RNF-03).
        loader: () => warmUpSession(queryClient),
        shouldRevalidate: () => false,
        children: [
          ...onboardingRoutes,
          {
            element: <RequireOnboardingDone />,
            children: [
              {
                element: <AppShell />,
                children: [
                  ...dashboardRoutes,
                  ...transactionsRoutes,
                  ...registerRoutes,
                  ...accountsRoutes,
                  { path: 'mas', element: <MoreMenu /> },
                  ...categoriesRoutes,
                  ...fxRoutes,
                  ...budgetsRoutes,
                  ...goalsRoutes,
                  ...recurringRoutes,
                  ...debtsRoutes,
                  ...profileRoutes,
                  ...settingsRoutes,
                ],
              },
            ],
          },
        ],
      },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
]);
