import type { CategoryNode, IconKey, PaletteKey } from '@finanzas/contracts';

import type { CategoryRow, CategoryTreeNode } from '../../application/ports/repositories.js';

const node = (category: CategoryTreeNode): CategoryNode => ({
  id: category.id,
  kind: category.kind,
  name: category.name,
  color: category.color as PaletteKey,
  icon: category.icon as IconKey,
  isSystem: category.isSystem,
  status: category.status,
  children: category.children.map(node),
});

/** Category responses of `/api/categories` (plan §4.5.1). */
export const CategoriesPresenter = {
  tree: (roots: CategoryTreeNode[]): CategoryNode[] => roots.map(node),

  category: (row: CategoryRow) => ({
    id: row.id,
    kind: row.kind,
    parentId: row.parentId,
    name: row.name,
    color: row.color as PaletteKey,
    icon: row.icon as IconKey,
    isSystem: row.isSystem,
    status: row.status,
    sortOrder: row.sortOrder,
  }),
};
