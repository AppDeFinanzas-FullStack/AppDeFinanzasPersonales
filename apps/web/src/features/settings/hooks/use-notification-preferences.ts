import type { PreferenceInput, PreferencesInput, Release } from '@finanzas/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { call } from '@/lib/api-client';

import { listPreferencesEndpoint, updatePreferencesEndpoint } from '../api';

export const PREFERENCES_KEY = ['notification-preferences'] as const;

const SAVE_KEY = [...PREFERENCES_KEY, 'save'] as const;

/** The configuration of the notices exists only from the V1.2 on (RF-M15-07). */
export function preferencesReleased(release: Release): boolean {
  return release === '1.2';
}

export function useNotificationPreferences() {
  return useQuery({
    queryKey: PREFERENCES_KEY,
    queryFn: ({ signal }) => call(listPreferencesEndpoint, undefined, { signal }),
  });
}

function applyChange(preferences: PreferencesInput, change: PreferenceInput): PreferencesInput {
  return preferences.map((preference) =>
    preference.type === change.type ? { ...preference, ...change } : preference,
  );
}

/**
 * Saves each change at once (plan §4.15.4): it shows before the answer (optimistic) and rolls back
 * if the save fails. The list is read again only after the last change in flight, so an earlier
 * answer does not undo a later change on the screen.
 */
export function useUpdatePreference() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: SAVE_KEY,
    mutationFn: (change: PreferenceInput) => call(updatePreferencesEndpoint, [change]),
    onMutate: async (change) => {
      await queryClient.cancelQueries({ queryKey: PREFERENCES_KEY });
      const previous = queryClient.getQueryData<PreferencesInput>(PREFERENCES_KEY);
      if (previous !== undefined) {
        queryClient.setQueryData(PREFERENCES_KEY, applyChange(previous, change));
      }
      return { previous };
    },
    onError: (_error, _change, context) => {
      if (context?.previous !== undefined) {
        queryClient.setQueryData(PREFERENCES_KEY, context.previous);
      }
    },
    onSettled: () => {
      if (queryClient.isMutating({ mutationKey: SAVE_KEY }) === 1) {
        return queryClient.invalidateQueries({ queryKey: PREFERENCES_KEY });
      }
      return undefined;
    },
  });
}
