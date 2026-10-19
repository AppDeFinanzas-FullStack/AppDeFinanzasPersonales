import { onlineManager, type QueryClient } from '@tanstack/react-query';

import { uiStore, type UiStore } from './ui-store';

export interface CreateOnlineOptions {
  queryClient?: QueryClient;
  store: UiStore;
  fetch: typeof fetch;
  events: EventTarget;
  healthIntervalMs?: number;
}

export interface Online {
  setOffline: () => void;
  trackInFlight: <T>(id: string, send: () => Promise<T>) => Promise<T>;
  attach: (queryClient: QueryClient) => void;
  dispose: () => void;
}

interface InFlight {
  interrupted: boolean;
  resend: () => void;
}

const HEALTH_PATH = '/api/health';
const DEFAULT_HEALTH_INTERVAL_MS = 5000;

function invoke<T>(send: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve) => {
    resolve(send());
  });
}

// Plan §4.2.3, RF-M2-07: offline blocks the app and polls health until reconnecting.
// EC-M2-02: a mutation interrupted by the outage is resent exactly once with the same id.
export function createOnline({
  queryClient,
  store,
  fetch: fetchHealth,
  events,
  healthIntervalMs = DEFAULT_HEALTH_INTERVAL_MS,
}: CreateOnlineOptions): Online {
  let client = queryClient;
  let offline = false;
  let disposed = false;
  let healthTimer: ReturnType<typeof setInterval> | null = null;
  const inFlight = new Map<string, InFlight>();

  function stopHealth(): void {
    if (healthTimer !== null) {
      clearInterval(healthTimer);
      healthTimer = null;
    }
  }

  function reconnect(): void {
    if (disposed || !offline) return;
    offline = false;
    stopHealth();
    onlineManager.setOnline(true);
    store.setOffline(false);
    if (client !== undefined) void client.invalidateQueries();
    for (const [id, entry] of [...inFlight]) {
      if (!entry.interrupted) continue;
      inFlight.delete(id);
      entry.resend();
    }
  }

  function checkHealth(): void {
    fetchHealth(HEALTH_PATH, { method: 'GET' }).then(
      (response) => {
        if (response.status === 204) reconnect();
      },
      () => undefined,
    );
  }

  function handleOnlineEvent(): void {
    reconnect();
  }

  events.addEventListener('online', handleOnlineEvent);

  return {
    setOffline() {
      if (disposed) return;
      for (const entry of inFlight.values()) entry.interrupted = true;
      if (offline) return;
      offline = true;
      onlineManager.setOnline(false);
      store.setOffline(true);
      healthTimer = setInterval(checkHealth, healthIntervalMs);
    },
    trackInFlight<T>(id: string, send: () => Promise<T>): Promise<T> {
      return new Promise<T>((resolve) => {
        const entry: InFlight = {
          interrupted: false,
          resend() {
            resolve(invoke(send));
          },
        };
        inFlight.set(id, entry);
        const attempt = invoke(send);
        const settleAttempt = (): void => {
          if (entry.interrupted) return;
          inFlight.delete(id);
          resolve(attempt);
        };
        attempt.then(settleAttempt, settleAttempt);
      });
    },
    attach(next) {
      client = next;
    },
    dispose() {
      disposed = true;
      stopHealth();
      events.removeEventListener('online', handleOnlineEvent);
    },
  };
}

export const online: Online = createOnline({
  store: uiStore,
  fetch: (input, init) => fetch(input, init),
  events: window,
});
