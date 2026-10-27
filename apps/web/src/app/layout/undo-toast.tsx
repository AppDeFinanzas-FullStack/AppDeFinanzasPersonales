import { UndoInput, type EarmarkWithdrawals } from '@finanzas/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation } from 'react-router';
import { z } from 'zod';

import { Button } from '@/components/ui/button';
import { useCurrencySymbol } from '@/features/accounts/hooks/use-accounts';
import { EarmarkConfirmDialog } from '@/features/goals/components/earmark-confirm-dialog';
import {
  AFFECTED_KEYS,
  UNDO_MS,
  undoAccountOf,
} from '@/features/transactions/hooks/use-delete-transaction';
import { ApiError, call, type Endpoint } from '@/lib/api-client';
import { messageForError } from '@/lib/i18n-errors';
import { uiStore, useUiStore } from '@/lib/ui-store';

const undoEndpoint: Endpoint<UndoInput, undefined> = {
  method: 'POST',
  path: '/api/transactions/undo',
  input: UndoInput,
  output: z.undefined(),
};

const EarmarkProposal = z.array(z.object({ goalId: z.string(), amount: z.string() }));

/** What the API asked to confirm before reverting (RF-M12-05). */
interface PendingEarmark {
  accountId: string;
  currencyCode: string;
  shortfall: string;
  proposal: z.infer<typeof EarmarkProposal>;
}

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
  const [pendingEarmark, setPendingEarmark] = useState<PendingEarmark | null>(null);
  const symbolOf = useCurrencySymbol();

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
    if (
      undo !== null &&
      shown?.token === undo.token &&
      shown.fromMovements &&
      !inMovements(pathname)
    ) {
      uiStore.clearUndo();
    }
  }, [pathname, undo, shown]);

  const revert = useMutation({
    mutationFn: (input: UndoInput) => call(undoEndpoint, input),
    onSuccess: async () => {
      setPendingEarmark(null);
      uiStore.clearUndo();
      await Promise.all(
        AFFECTED_KEYS.map((queryKey) => queryClient.invalidateQueries({ queryKey })),
      );
    },
    onError: (failure, input) => {
      if (failure instanceof ApiError && failure.code === 'EARMARK_CONFIRMATION_REQUIRED') {
        const shortfall = failure.data?.['shortfall'];
        const proposal = EarmarkProposal.safeParse(failure.data?.['proposal']);
        // The API does not name the account; the deletion remembered it for this token.
        const account = undoAccountOf(input.undoToken);
        if (typeof shortfall === 'string' && account !== undefined && proposal.success) {
          setPendingEarmark({
            accountId: account.id,
            currencyCode: account.currencyCode,
            shortfall,
            proposal: proposal.data,
          });
          return;
        }
      }
      setPendingEarmark(null);
      setError(messageForError(failure instanceof ApiError ? failure : { code: '' }));
    },
  });

  if (undo === null) return null;
  const seconds = Math.min(UNDO_MS / 1000, Math.max(0, Math.ceil((undo.expiresAt - now) / 1000)));

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
              revert.mutate({ undoToken: undo.token });
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
      <EarmarkConfirmDialog
        open={pendingEarmark !== null}
        shortfall={pendingEarmark?.shortfall ?? '0.00'}
        accountId={pendingEarmark?.accountId ?? ''}
        proposal={pendingEarmark?.proposal ?? []}
        symbol={symbolOf(pendingEarmark?.currencyCode ?? 'BOB')}
        pending={revert.isPending}
        onConfirm={(earmarkWithdrawals: EarmarkWithdrawals) => {
          revert.mutate({ undoToken: undo.token, earmarkWithdrawals });
        }}
        onCancel={() => {
          setPendingEarmark(null);
        }}
      />
    </div>
  );
}
