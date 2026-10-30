import type { ReorderCategoriesInput } from '@finanzas/contracts';
import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { call } from '@/lib/api-client';

import {
  archiveCategoryEndpoint,
  listCategoriesEndpoint,
  reorderCategoriesEndpoint,
  type CategoryListQuery,
} from '../api';

export const CATEGORIES_KEY = ['categories'] as const;

// Plan §4.5.4: `['categories', kind, status]`.
export function categoriesQuery({ kind, status }: CategoryListQuery) {
  return queryOptions({
    queryKey: [...CATEGORIES_KEY, kind, status],
    queryFn: ({ signal }) => call(listCategoriesEndpoint, { kind, status }, { signal }),
  });
}

export function useCategories(query: CategoryListQuery) {
  return useQuery(categoriesQuery(query));
}

/** Saves the order of the categories of one kind and parent. */
export function useReorderCategories() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: ReorderCategoriesInput) => call(reorderCategoriesEndpoint, input),
    onSettled: () => queryClient.invalidateQueries({ queryKey: CATEGORIES_KEY }),
  });
}

export function useArchiveCategory() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => call(archiveCategoryEndpoint(id), undefined),
    onSettled: () => queryClient.invalidateQueries({ queryKey: CATEGORIES_KEY }),
  });
}
