import { RouterProvider } from 'react-router/dom';

import { AppProviders } from './app/providers';
import { ServiceDownBanner } from './app/layout/service-down-banner';
import { router } from './app/router';

export function App() {
  return (
    <AppProviders>
      <ServiceDownBanner />
      <RouterProvider router={router} />
    </AppProviders>
  );
}
