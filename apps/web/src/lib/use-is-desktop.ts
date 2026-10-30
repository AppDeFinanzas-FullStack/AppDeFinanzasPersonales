import { useSyncExternalStore } from 'react';

const DESKTOP_QUERY = '(min-width: 1024px)';

function subscribe(listener: () => void): () => void {
  const media = window.matchMedia(DESKTOP_QUERY);
  media.addEventListener('change', listener);
  return () => media.removeEventListener('change', listener);
}

/** True from 1024 px up, where the sidebar replaces the bottom bar. */
export function useIsDesktop(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(DESKTOP_QUERY).matches,
    () => false,
  );
}
