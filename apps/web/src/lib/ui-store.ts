import type { ModuleKey } from '@finanzas/contracts';
import { useSyncExternalStore } from 'react';

export interface TabMemoryEntry {
  url: string;
  scrollY: number;
}

export type TabMemory = Partial<Record<ModuleKey, TabMemoryEntry>>;

export interface UndoState {
  token: string;
  label: string;
  expiresAt: number;
}

export interface UiState {
  offline: boolean;
  sessionExpired: boolean;
  tabMemory: TabMemory;
  undo: UndoState | null;
}

export interface UiStore {
  getState: () => UiState;
  subscribe: (listener: () => void) => () => void;
  setTabMemory: (moduleKey: ModuleKey, entry: TabMemoryEntry) => void;
  setOffline: (value: boolean) => void;
  openSessionExpired: () => void;
  closeSessionExpired: () => void;
  showUndo: (undo: UndoState) => void;
  clearUndo: () => void;
}

const TAB_MEMORY_KEY = 'ui:tabMemory';

// RF-M2-05: the root of each module; modules without a defined root use '/'.
const MODULE_ROOTS: Record<ModuleKey, string> = {
  M1: '/',
  M2: '/',
  M3: '/tipo-de-cambio',
  M4: '/cuentas',
  M5: '/categorias',
  M6: '/movimientos',
  M7: '/registrar',
  M8: '/',
  M9: '/',
  M10: '/',
  M11: '/presupuestos',
  M12: '/metas',
  M13: '/deudas',
  M14: '/recurrentes',
  M15: '/',
};

export function rootFor(moduleKey: ModuleKey): string {
  return MODULE_ROOTS[moduleKey];
}

function isModuleKey(value: string): value is ModuleKey {
  return Object.hasOwn(MODULE_ROOTS, value);
}

function isTabMemoryEntry(value: unknown): value is TabMemoryEntry {
  if (typeof value !== 'object' || value === null) return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.url === 'string' && typeof entry.scrollY === 'number';
}

function readTabMemory(storage: Storage): TabMemory {
  const raw = storage.getItem(TAB_MEMORY_KEY);
  if (raw === null) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof parsed !== 'object' || parsed === null) return {};
  const memory: TabMemory = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (isModuleKey(key) && isTabMemoryEntry(value)) {
      memory[key] = { url: value.url, scrollY: value.scrollY };
    }
  }
  return memory;
}

// ADR-17, RF-M2-04: minimal client store; tabMemory lives in the injected storage.
export function createUiStore({ storage }: { storage: Storage }): UiStore {
  let state: UiState = {
    offline: false,
    sessionExpired: false,
    tabMemory: readTabMemory(storage),
    undo: null,
  };
  const listeners = new Set<() => void>();

  function setState(next: Partial<UiState>): void {
    state = { ...state, ...next };
    for (const listener of listeners) listener();
  }

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setTabMemory(moduleKey, entry) {
      const tabMemory: TabMemory = {
        ...state.tabMemory,
        [moduleKey]: { url: entry.url, scrollY: entry.scrollY },
      };
      storage.setItem(TAB_MEMORY_KEY, JSON.stringify(tabMemory));
      setState({ tabMemory });
    },
    setOffline(value) {
      setState({ offline: value });
    },
    openSessionExpired() {
      setState({ sessionExpired: true });
    },
    closeSessionExpired() {
      setState({ sessionExpired: false });
    },
    showUndo(undo) {
      setState({ undo: { token: undo.token, label: undo.label, expiresAt: undo.expiresAt } });
    },
    clearUndo() {
      setState({ undo: null });
    },
  };
}

export const uiStore: UiStore = createUiStore({ storage: sessionStorage });

export function useUiStore<T>(selector: (state: UiState) => T): T {
  return useSyncExternalStore(
    uiStore.subscribe,
    () => selector(uiStore.getState()),
    () => selector(uiStore.getState()),
  );
}
