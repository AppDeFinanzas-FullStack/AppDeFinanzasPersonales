import { useEffect, useRef } from 'react';

import { confirmationStatusEndpoint } from '../api';

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

/** Plan §4.1.4: every 3 s while visible, every 10 s after 5 minutes, and never after 24 h. */
const FAST_INTERVAL_MS = 3 * SECOND;
const SLOW_INTERVAL_MS = 10 * SECOND;
const SLOW_AFTER_MS = 5 * MINUTE;
const GIVE_UP_AFTER_MS = 24 * HOUR;

export interface WatchedDocument extends EventTarget {
  readonly visibilityState: DocumentVisibilityState;
}

export interface CreateConfirmationWatchOptions {
  onConfirmed: () => void;
  fetch: typeof fetch;
  window: EventTarget;
  document: WatchedDocument;
  now?: () => number;
}

export interface ConfirmationWatch {
  dispose: () => void;
}

/**
 * RF-M1-18: asks `POST /api/auth/confirmation/status` while the tab is visible, right away when it
 * gets the focus back or becomes visible, and stops on `confirmed`, on dispose and after 24 h.
 * Network errors are ignored: the next tick asks again.
 */
export function createConfirmationWatch({
  onConfirmed,
  fetch: send,
  window: win,
  document: doc,
  now = () => Date.now(),
}: CreateConfirmationWatchOptions): ConfirmationWatch {
  const startedAt = now();
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  function clearTimer(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function stop(): void {
    if (stopped) return;
    stopped = true;
    clearTimer();
    win.removeEventListener('focus', onFocus);
    doc.removeEventListener('visibilitychange', onVisibilityChange);
  }

  function expired(): boolean {
    return now() - startedAt >= GIVE_UP_AFTER_MS;
  }

  // A plain request, not the app client: a network failure must not block the app as offline.
  async function isConfirmed(): Promise<boolean> {
    const response = await send(confirmationStatusEndpoint.path, {
      method: confirmationStatusEndpoint.method,
      headers: { accept: 'application/json', 'X-Background': '1' },
      credentials: 'include',
    });
    if (!response.ok) return false;
    const result = confirmationStatusEndpoint.output.safeParse(await response.json());
    return result.success && result.data.status === 'confirmed';
  }

  function ask(): void {
    isConfirmed().then(
      (confirmed) => {
        if (stopped || !confirmed) return;
        stop();
        onConfirmed();
      },
      () => {
        // Network errors are ignored: the next tick asks again.
      },
    );
  }

  function tick(): void {
    clearTimer();
    if (stopped) return;
    if (expired()) {
      stop();
      return;
    }
    if (doc.visibilityState !== 'visible') return;
    ask();
    const interval = now() - startedAt < SLOW_AFTER_MS ? FAST_INTERVAL_MS : SLOW_INTERVAL_MS;
    timer = setTimeout(tick, interval);
  }

  function onFocus(): void {
    tick();
  }

  function onVisibilityChange(): void {
    if (doc.visibilityState === 'visible') {
      tick();
    } else {
      clearTimer();
    }
  }

  win.addEventListener('focus', onFocus);
  doc.addEventListener('visibilitychange', onVisibilityChange);
  if (doc.visibilityState === 'visible') {
    timer = setTimeout(tick, FAST_INTERVAL_MS);
  }

  return { dispose: stop };
}

export interface UseConfirmationWatchOptions {
  onConfirmed: () => void;
}

/** RF-M1-18: the tab on "Revisa tu correo" notices the confirmation and continues by itself. */
export function useConfirmationWatch({ onConfirmed }: UseConfirmationWatchOptions): void {
  const latest = useRef(onConfirmed);

  useEffect(() => {
    latest.current = onConfirmed;
  }, [onConfirmed]);

  useEffect(() => {
    const watch = createConfirmationWatch({
      onConfirmed: () => {
        latest.current();
      },
      fetch: (input, init) => fetch(input, init),
      window,
      document,
    });
    return () => {
      watch.dispose();
    };
  }, []);
}
