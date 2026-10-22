import type { SettingsDto, UpdateSettingsInput } from '@finanzas/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';

import { call } from '@/lib/api-client';

import { updateSettingsEndpoint } from '../api';

import { SETTINGS_KEY } from './use-settings';

/** Plan §4.9.3: the web saves 300 ms after the last change. */
export const AUTOSAVE_DELAY_MS = 300;

/** The settings of the General section (plan §4.9.4). */
export type GeneralSettingsPatch = Pick<
  UpdateSettingsInput,
  'numberFormat' | 'dateFormat' | 'weekStart' | 'theme'
>;

interface SaveVariables {
  patch: GeneralSettingsPatch;
  previous: SettingsDto | undefined;
}

/**
 * Autosave without a "Guardar" button (RF-M9-01, plan §4.9.3): each change shows at once
 * (optimistic), is saved 300 ms after the last one and rolls back if the save fails.
 */
export function useAutosaveSettings() {
  const queryClient = useQueryClient();
  const pending = useRef<GeneralSettingsPatch>({});
  const previous = useRef<SettingsDto | undefined>(undefined);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // Shown in the same render as the click, before the cache notifies its observers.
  const [unsaved, setUnsaved] = useState<GeneralSettingsPatch>({});

  const save = useMutation({
    mutationFn: ({ patch }: SaveVariables) => call(updateSettingsEndpoint, patch),
    onError: (_error, { previous: before }) => {
      if (before !== undefined) queryClient.setQueryData(SETTINGS_KEY, before);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: SETTINGS_KEY }),
  });
  const { mutate } = save;

  const flush = useCallback(() => {
    if (timer.current !== undefined) clearTimeout(timer.current);
    timer.current = undefined;
    const patch = pending.current;
    if (Object.keys(patch).length === 0) return;
    const before = previous.current;
    pending.current = {};
    previous.current = undefined;
    setUnsaved({});
    mutate({ patch, previous: before });
  }, [mutate]);

  const change = useCallback(
    (patch: GeneralSettingsPatch) => {
      void queryClient.cancelQueries({ queryKey: SETTINGS_KEY });
      const current = queryClient.getQueryData<SettingsDto>(SETTINGS_KEY);
      if (current === undefined) return;
      if (Object.keys(pending.current).length === 0) previous.current = current;
      pending.current = { ...pending.current, ...patch };
      setUnsaved(pending.current);
      queryClient.setQueryData<SettingsDto>(SETTINGS_KEY, { ...current, ...patch });
      if (timer.current !== undefined) clearTimeout(timer.current);
      timer.current = setTimeout(flush, AUTOSAVE_DELAY_MS);
    },
    [queryClient, flush],
  );

  // A change still waiting when the screen closes is saved right away.
  useEffect(() => flush, [flush]);

  return { change, unsaved, isError: save.isError };
}
