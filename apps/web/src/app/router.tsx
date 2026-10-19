import { useTranslation } from 'react-i18next';
import { createBrowserRouter, Outlet } from 'react-router';

function RootLayout() {
  return (
    <main className="min-h-screen bg-background text-foreground">
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
    children: [{ path: '*', element: <NotFoundPage /> }],
  },
]);
