import type { SettingsDto, UpdateSettingsInput } from '@finanzas/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';

import { call } from '@/lib/api-client';
import { buildFormatters, type Formatters } from '@/lib/formatters';

import { getSettingsEndpoint, updateSettingsEndpoint } from '../api';

export const SETTINGS_KEY = ['settings'] as const;

const DEFAULT_FORMATS = {
  numberFormat: 'dot_comma',
  dateFormat: 'dmy',
  weekStart: 'monday',
} as const;

// Plan §4.9.3: other devices refresh when the window regains focus (EC-M9-01).
export function useSettings() {
  return useQuery({
    queryKey: SETTINGS_KEY,
    queryFn: ({ signal }) => call(getSettingsEndpoint, undefined, { signal }),
    refetchOnWindowFocus: true,
  });
}

// Optimistic update that rolls back on error (RF-M9-01, plan §4.9.3).
export function useUpdateSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (patch: UpdateSettingsInput) => call(updateSettingsEndpoint, patch),
    onMutate: async (patch) => {
      await queryClient.cancelQueries({ queryKey: SETTINGS_KEY });
      const previous = queryClient.getQueryData<SettingsDto>(SETTINGS_KEY);
      if (previous !== undefined) {
        const { favoriteCategories, ...rest } = patch;
        const next: SettingsDto = { ...previous, ...rest };
        if (favoriteCategories !== undefined) {
          next.favorites = { ...previous.favorites, [favoriteCategories.kind]: favoriteCategories.ids };
        }
        queryClient.setQueryData(SETTINGS_KEY, next);
      }
      return { previous };
    },
    onError: (_error, _patch, context) => {
      if (context?.previous !== undefined) queryClient.setQueryData(SETTINGS_KEY, context.previous);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: SETTINGS_KEY }),
  });
}

export function useFormatters(): Formatters {
  const { data } = useSettings();
  const numberFormat = data?.numberFormat ?? DEFAULT_FORMATS.numberFormat;
  const dateFormat = data?.dateFormat ?? DEFAULT_FORMATS.dateFormat;
  const weekStart = data?.weekStart ?? DEFAULT_FORMATS.weekStart;
  return useMemo(
    () => buildFormatters({ numberFormat, dateFormat, weekStart }),
    [numberFormat, dateFormat, weekStart],
  );
}
