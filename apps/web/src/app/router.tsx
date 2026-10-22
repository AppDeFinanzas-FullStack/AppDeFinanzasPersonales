import { useTranslation } from 'react-i18next';
import { createBrowserRouter, Outlet } from 'react-router';

import { accountsRoutes } from '@/features/accounts/routes';
import { authRoutes } from '@/features/auth/routes';
import { categoriesRoutes } from '@/features/categories/routes';
import { dashboardRoutes } from '@/features/dashboard/routes';
import { fxRoutes } from '@/features/fx/routes';
import { onboardingRoutes } from '@/features/onboarding/routes';
import { profileRoutes } from '@/features/profile/routes';
import { registerRoutes } from '@/features/register/routes';
import { settingsRoutes } from '@/features/settings/routes';
import { transactionsRoutes } from '@/features/transactions/routes';

import { RequireOnboardingDone, RequireSession } from './guards';
import { AppShell } from './layout/app-shell';
import { MoreMenu } from './layout/more-menu';

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

export const router = createBrowserRouter([
  {
    path: '/',
    element: <RootLayout />,
    children: [
      {
        element: <PublicLayout />,
        children: authRoutes.filter((route) => route.path !== 'perfil'),
      },
      {
        element: <RequireSession />,
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
