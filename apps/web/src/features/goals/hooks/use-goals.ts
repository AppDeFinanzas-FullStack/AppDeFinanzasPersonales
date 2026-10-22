import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { call } from '@/lib/api-client';

import { celebratedEndpoint, goalEndpoint, listGoalsEndpoint } from '../api';

export const GOALS_KEY = ['goals'] as const;

// Plan §4.12.4: `['goals']`.
export function useGoals() {
  return useQuery({
    queryKey: GOALS_KEY,
    queryFn: ({ signal }) => call(listGoalsEndpoint, undefined, { signal }),
  });
}

// Plan §4.12.4: `['goal', id]`.
export function useGoal(id: string) {
  return useQuery({
    queryKey: ['goal', id],
    queryFn: ({ signal }) => call(goalEndpoint(id), undefined, { signal }),
    retry: false,
  });
}

/** Marks the celebration as shown, so it appears only once. */
export function useMarkCelebrated(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => call(celebratedEndpoint(id), undefined),
    onSettled: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['goal', id] }),
        queryClient.invalidateQueries({ queryKey: GOALS_KEY }),
      ]);
    },
  });
}
