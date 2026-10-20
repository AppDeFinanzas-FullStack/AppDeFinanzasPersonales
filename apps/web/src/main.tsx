import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App';
import { applyStoredTheme } from './app/providers/theme';
import './index.css';

const container = document.getElementById('root');
if (!container) {
  throw new Error('Root element #root not found');
}

// Plan §4.9.3: the stored theme is applied before the first render.
applyStoredTheme();

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
