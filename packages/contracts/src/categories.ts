import { z } from 'zod';

import { IconKey, PaletteKey } from './catalogs.js';

export const CategoryKind = z.enum(['expense', 'income']);
export type CategoryKind = z.infer<typeof CategoryKind>;

export const CategoryStatus = z.enum(['active', 'archived']);
export type CategoryStatus = z.infer<typeof CategoryStatus>;

const CategoryName = z.string().trim().min(1).max(30);

export const CreateCategoryInput = z.object({
  id: z.string().uuid(),
  kind: CategoryKind,
  parentId: z.string().uuid().nullable(),
  name: CategoryName,
  color: PaletteKey.optional(),
  icon: IconKey,
});
export type CreateCategoryInput = z.infer<typeof CreateCategoryInput>;

export const UpdateCategoryInput = z
  .object({
    name: CategoryName,
    color: PaletteKey,
    icon: IconKey,
    parentId: z.string().uuid().nullable(),
  })
  .partial()
  .strict();
export type UpdateCategoryInput = z.infer<typeof UpdateCategoryInput>;

export const ReorderCategoriesInput = z.object({
  kind: CategoryKind,
  parentId: z.string().uuid().nullable(),
  ids: z.array(z.string().uuid()),
});
export type ReorderCategoriesInput = z.infer<typeof ReorderCategoriesInput>;

export const RestoreCategoryInput = z.object({
  childIds: z.array(z.string().uuid()).default([]),
  newName: CategoryName.optional(),
});
export type RestoreCategoryInput = z.infer<typeof RestoreCategoryInput>;

export const MergeInput = z.object({
  fromId: z.string().uuid(),
  toId: z.string().uuid(),
});
export type MergeInput = z.infer<typeof MergeInput>;

export interface CategoryNode {
  id: string;
  kind: CategoryKind;
  name: string;
  color: PaletteKey;
  icon: IconKey;
  isSystem: boolean;
  status: CategoryStatus;
  children: CategoryNode[];
}

export const CategoryNode: z.ZodType<CategoryNode> = z.lazy(() =>
  z.object({
    id: z.string().uuid(),
    kind: CategoryKind,
    name: z.string(),
    color: PaletteKey,
    icon: IconKey,
    isSystem: z.boolean(),
    status: CategoryStatus,
    children: z.array(CategoryNode),
  }),
);

export const ArchiveImpactDto = z.object({
  children: z.array(z.object({ id: z.string().uuid(), name: z.string() })),
  budgets: z.array(z.object({ id: z.string().uuid() })),
  recurring: z.array(z.object({ id: z.string().uuid(), name: z.string() })),
  shortcuts: z.array(z.object({ id: z.string().uuid(), name: z.string() })),
});
export type ArchiveImpactDto = z.infer<typeof ArchiveImpactDto>;

export const MergePreviewDto = z.object({
  movements: z.number().int().nonnegative(),
  budgetEffect: z.enum(['moved', 'kept_target', 'none']),
});
export type MergePreviewDto = z.infer<typeof MergePreviewDto>;
