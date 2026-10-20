import { UndoInput } from '@finanzas/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation } from 'react-router';
import { z } from 'zod';

import { Button } from '@/components/ui/button';
import { AFFECTED_KEYS, UNDO_MS } from '@/features/transactions/hooks/use-delete-transaction';
import { ApiError, call, type Endpoint } from '@/lib/api-client';
import { messageForError } from '@/lib/i18n-errors';
import { uiStore, useUiStore } from '@/lib/ui-store';

const undoEndpoint: Endpoint<UndoInput, undefined> = {
  method: 'POST',
  path: '/api/transactions/undo',
  input: UndoInput,
  output: z.undefined(),
};

const MOVEMENTS_ROOT = '/movimientos';

const inMovements = (pathname: string): boolean =>
  pathname === MOVEMENTS_ROOT || pathname.startsWith(`${MOVEMENTS_ROOT}/`);

/** The undo of the toast and where it was shown. */
interface Shown {
  token: string;
  fromMovements: boolean;
}

/**
 * `<UndoToast>`: "Deshacer" for 10 s with a countdown, living in `ui-store` (plan §4.6.4). One shown
 * in Movimientos hides once the user leaves it, so the deletion stays (EC-M6-06); one shown
 * elsewhere, like Registrar, stays across tabs until it expires (RF-M7-07).
 */
export function UndoToast() {
  const { t } = useTranslation('transactions');
  const queryClient = useQueryClient();
  const undo = useUiStore((state) => state.undo);
  const { pathname } = useLocation();
  const [now, setNow] = useState(() => Date.now());
  const [shown, setShown] = useState<Shown | null>(null);
  const [error, setError] = useState<string | null>(null);

  // A new undo: remember where it appeared and forget the previous error.
  if (undo !== null && shown?.token !== undo.token) {
    setShown({ token: undo.token, fromMovements: inMovements(pathname) });
    setError(null);
  }

  useEffect(() => {
    if (undo === null) return undefined;
    const tick = setInterval(() => {
      setNow(Date.now());
    }, 1000);
    const expire = setTimeout(
      () => {
        uiStore.clearUndo();
      },
      Math.max(0, undo.expiresAt - Date.now()),
    );
    return () => {
      clearInterval(tick);
      clearTimeout(expire);
    };
  }, [undo]);

  useEffect(() => {
    if (undo !== null && shown?.token === undo.token && shown.fromMovements && !inMovements(pathname)) {
      uiStore.clearUndo();
    }
  }, [pathname, undo, shown]);

  const revert = useMutation({
    mutationFn: (undoToken: string) => call(undoEndpoint, { undoToken }),
    onSuccess: async () => {
      uiStore.clearUndo();
      await Promise.all(AFFECTED_KEYS.map((queryKey) => queryClient.invalidateQueries({ queryKey })));
    },
    onError: (failure) => {
      setError(messageForError(failure instanceof ApiError ? failure : { code: '' }));
    },
  });

  if (undo === null) return null;
  const seconds = Math.min(
    UNDO_MS / 1000,
    Math.max(0, Math.ceil((undo.expiresAt - now) / 1000)),
  );

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed bottom-20 left-1/2 z-50 flex w-[calc(100%-2rem)] max-w-md -translate-x-1/2 flex-col gap-2 rounded-md border border-border bg-background p-3 shadow-lg lg:bottom-4"
    >
      <div className="flex items-center justify-between gap-3">
        <p className="text-base">{undo.label}</p>
        <div className="flex items-center gap-2">
          <span
            className="text-sm tabular-nums text-muted-foreground"
            aria-label={t('undo.remainingLabel', { count: seconds })}
          >
            {t('undo.remaining', { count: seconds })}
          </span>
          <Button
            type="button"
            variant="ghost"
            className="h-11 font-medium text-primary"
            disabled={revert.isPending}
            onClick={() => {
              revert.mutate(undo.token);
            }}
          >
            {revert.isPending ? t('undo.undoing') : t('undo.action')}
          </Button>
        </div>
      </div>
      {error !== null && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
