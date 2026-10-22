import type { DashboardBlock, DashboardBlockKey, SettingsDto } from '@finanzas/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { call } from '@/lib/api-client';

import { updateSettingsEndpoint } from '../api';
import { SETTINGS_KEY, useSettings } from '../hooks/use-settings';
import { AUTOSAVE_DELAY_MS } from '../hooks/use-update-settings';

import { ResetSectionButton } from './reset-section-button';

/** Blocks 3 to 8 that exist today; the ones of V1.1 stay saved but are not shown (RF-M8-10). */
const RELEASED_KEYS: readonly DashboardBlockKey[] = ['byCategory', 'pace', 'balances', 'recent'];

interface SaveVariables {
  blocks: DashboardBlock[];
  previous: SettingsDto | undefined;
}

function isReleased(block: DashboardBlock): boolean {
  return RELEASED_KEYS.includes(block.key);
}

/** Sets the visibility of one block and leaves every other block as it was. */
function withVisibility(
  blocks: DashboardBlock[],
  key: DashboardBlockKey,
  visible: boolean,
): DashboardBlock[] {
  return blocks.map((block) => (block.key === key ? { ...block, visible } : block));
}

/**
 * Swaps a block with the previous or next released one. Only those two slots change, so the
 * blocks that are not released keep their place in the saved list.
 */
function withMove(
  blocks: DashboardBlock[],
  key: DashboardBlockKey,
  offset: -1 | 1,
): DashboardBlock[] {
  const slots = blocks.flatMap((block, index) => (isReleased(block) ? [index] : []));
  const from = blocks.findIndex((block) => block.key === key);
  const position = slots.indexOf(from);
  const to = slots[position + offset];
  const moved = blocks[from];
  const other = to === undefined ? undefined : blocks[to];
  if (to === undefined || moved === undefined || other === undefined) return blocks;
  const next = [...blocks];
  next[from] = other;
  next[to] = moved;
  return next;
}

/**
 * Autosave of this section (RF-M9-01, plan §4.9.3): each change shows at once, is saved 300 ms
 * after the last one and rolls back if the save fails.
 */
function useBlocksAutosave() {
  const queryClient = useQueryClient();
  const pending = useRef<DashboardBlock[] | undefined>(undefined);
  const previous = useRef<SettingsDto | undefined>(undefined);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // Shown in the same render as the click, before the cache notifies its observers.
  const [draft, setDraft] = useState<DashboardBlock[] | undefined>(undefined);

  const save = useMutation({
    mutationFn: ({ blocks }: SaveVariables) => call(updateSettingsEndpoint, { dashboardBlocks: blocks }),
    onError: (_error, { previous: before }) => {
      if (before !== undefined) queryClient.setQueryData(SETTINGS_KEY, before);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: SETTINGS_KEY }),
  });
  const { mutate } = save;

  const flush = useCallback(() => {
    if (timer.current !== undefined) clearTimeout(timer.current);
    timer.current = undefined;
    const blocks = pending.current;
    if (blocks === undefined) return;
    const before = previous.current;
    pending.current = undefined;
    previous.current = undefined;
    setDraft(undefined);
    mutate({ blocks, previous: before });
  }, [mutate]);

  const change = useCallback(
    (update: (blocks: DashboardBlock[]) => DashboardBlock[]) => {
      void queryClient.cancelQueries({ queryKey: SETTINGS_KEY });
      const current = queryClient.getQueryData<SettingsDto>(SETTINGS_KEY);
      if (current === undefined) return;
      if (pending.current === undefined) previous.current = current;
      const next = update(pending.current ?? current.dashboardBlocks);
      pending.current = next;
      setDraft(next);
      queryClient.setQueryData<SettingsDto>(SETTINGS_KEY, { ...current, dashboardBlocks: next });
      if (timer.current !== undefined) clearTimeout(timer.current);
      timer.current = setTimeout(flush, AUTOSAVE_DELAY_MS);
    },
    [queryClient, flush],
  );

  // A change still waiting when the screen closes is saved right away.
  useEffect(() => flush, [flush]);

  return { change, draft, isError: save.isError };
}

/**
 * `/ajustes/inicio`: shows or hides the blocks of the Inicio and reorders them with "Subir" and
 * "Bajar" (RF-M8-10, RNF-06, plan §4.9.4).
 */
export function BlocksOrderList() {
  const { t } = useTranslation('settings');
  const settings = useSettings();
  const { change, draft, isError } = useBlocksAutosave();

  if (settings.isError && settings.data === undefined) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {t('general.loadError')}
      </p>
    );
  }
  if (settings.data === undefined) return null;
  const released = (draft ?? settings.data.dashboardBlocks).filter(isReleased);

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">{t('sections.dashboard.title')}</h1>
        <p className="text-sm text-muted-foreground">{t('general.autosave')}</p>
        <p className="text-sm text-muted-foreground">{t('dashboard.description')}</p>
      </div>
      {isError && (
        <p role="alert" className="text-sm text-destructive">
          {t('general.saveError')}
        </p>
      )}

      <ul aria-label={t('dashboard.listLabel')} className="divide-y divide-border border-y border-border">
        {released.map((block, index) => {
          const name = t(`dashboard.blocks.${block.key}`);
          return (
            <li key={block.key} className="flex items-center gap-1 py-1">
              <label className="flex min-h-11 min-w-0 flex-1 items-center gap-3">
                <input
                  type="checkbox"
                  checked={block.visible}
                  className="h-4 w-4 accent-[hsl(var(--primary))]"
                  onChange={(event) => {
                    change((blocks) => withVisibility(blocks, block.key, event.target.checked));
                  }}
                />
                <span className="truncate text-base">{name}</span>
              </label>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-11 w-11"
                disabled={index === 0}
                aria-label={t('dashboard.up', { name })}
                onClick={() => {
                  change((blocks) => withMove(blocks, block.key, -1));
                }}
              >
                <ArrowUp className="h-4 w-4" aria-hidden />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-11 w-11"
                disabled={index === released.length - 1}
                aria-label={t('dashboard.down', { name })}
                onClick={() => {
                  change((blocks) => withMove(blocks, block.key, 1));
                }}
              >
                <ArrowDown className="h-4 w-4" aria-hidden />
              </Button>
            </li>
          );
        })}
      </ul>

      <ResetSectionButton section="dashboard" />
    </div>
  );
}
