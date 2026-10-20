import { useEffect, useState, type ReactNode } from 'react';

import { useSettings } from '@/features/settings/hooks/use-settings';

export type ThemeMode = 'system' | 'light' | 'dark';

const THEME_STORAGE_KEY = 'ui:theme';
const DARK_QUERY = '(prefers-color-scheme: dark)';
const THEME_MODES: readonly ThemeMode[] = ['system', 'light', 'dark'];

function isThemeMode(value: string | null): value is ThemeMode {
  return value !== null && (THEME_MODES as readonly string[]).includes(value);
}

export function readStoredTheme(): ThemeMode {
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    return isThemeMode(stored) ? stored : 'system';
  } catch {
    return 'system';
  }
}

export function applyTheme(mode: ThemeMode): void {
  const dark = mode === 'dark' || (mode === 'system' && window.matchMedia(DARK_QUERY).matches);
  document.documentElement.classList.toggle('dark', dark);
}

export function storeTheme(mode: ThemeMode): void {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, mode);
  } catch {
    // The localStorage copy is only a first-paint hint; ignore storage failures.
  }
}

// Plan §4.9.3: the first paint uses the localStorage copy to avoid a flash;
// the server value takes over once settings load (TASK-070).
export function applyStoredTheme(): ThemeMode {
  const mode = readStoredTheme();
  applyTheme(mode);
  return mode;
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [storedMode] = useState<ThemeMode>(applyStoredTheme);
  const { data } = useSettings();
  const serverMode = data?.theme;
  const mode = serverMode ?? storedMode;

  // RF-M9-01: the server value replaces the localStorage copy once loaded.
  useEffect(() => {
    if (serverMode === undefined) return;
    storeTheme(serverMode);
    applyTheme(serverMode);
  }, [serverMode]);

  useEffect(() => {
    if (mode !== 'system') return;
    const media = window.matchMedia(DARK_QUERY);
    const follow = (): void => {
      applyTheme('system');
    };
    media.addEventListener('change', follow);
    return () => {
      media.removeEventListener('change', follow);
    };
  }, [mode]);

  return <>{children}</>;
}
