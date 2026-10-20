import { CategoryNode, ReorderCategoriesInput } from '@finanzas/contracts';
import { z } from 'zod';

import type { Endpoint } from '@/lib/api-client';

const CategoryListQuery = z.object({
  kind: z.enum(['expense', 'income']),
  status: z.enum(['active', 'archived']),
});
export type CategoryListQuery = z.infer<typeof CategoryListQuery>;

export const listCategoriesEndpoint: Endpoint<CategoryListQuery, CategoryNode[]> = {
  method: 'GET',
  path: '/api/categories',
  input: CategoryListQuery,
  output: z.array(CategoryNode),
};

export const reorderCategoriesEndpoint: Endpoint<ReorderCategoriesInput, void> = {
  method: 'PUT',
  path: '/api/categories/order',
  input: ReorderCategoriesInput,
  output: z.void(),
};

export const archiveCategoryEndpoint = (id: string): Endpoint<undefined, void> => ({
  method: 'POST',
  path: `/api/categories/${id}/archive`,
  input: z.undefined(),
  output: z.void(),
});
