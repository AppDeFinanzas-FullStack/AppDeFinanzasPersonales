import type { CategoryNode } from '@finanzas/contracts';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, type RouteObject } from 'react-router';

import { i18n, LANGUAGE } from '@/app/providers/i18n';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import categories from '@/locales/es-BO/categories.json';

import { CategoryTree } from './components/category-tree';
import {
  useArchiveCategory,
  useCategories,
  useReorderCategories,
} from './hooks/use-categories';

// The feature registers its own namespace (RNF-07).
i18n.addResourceBundle(LANGUAGE, 'categories', categories, true, true);

type Kind = 'expense' | 'income';

/** While a new order is being saved, the tree already shows it. */
function inOrder(
  roots: readonly CategoryNode[],
  pending: { parentId: string | null; ids: string[] } | undefined,
): CategoryNode[] {
  if (pending === undefined) return [...roots];
  const sort = (items: readonly CategoryNode[]): CategoryNode[] =>
    [...items].sort((a, b) => pending.ids.indexOf(a.id) - pending.ids.indexOf(b.id));
  if (pending.parentId === null) return sort(roots);
  return roots.map((root) =>
    root.id === pending.parentId ? { ...root, children: sort(root.children) } : root,
  );
}

function KindTree({ kind }: { kind: Kind }) {
  const { t } = useTranslation('categories');
  const tree = useCategories({ kind, status: 'active' });
  const reorder = useReorderCategories();
  const archive = useArchiveCategory();

  if (tree.isError && tree.data === undefined) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {t('loadError')}
      </p>
    );
  }
  if (tree.data === undefined) return null;
  if (tree.data.length === 0) {
    return <p className="text-sm text-muted-foreground">{t('empty')}</p>;
  }

  return (
    <CategoryTree
      roots={inOrder(tree.data, reorder.isPending ? reorder.variables : undefined)}
      onReorder={(parentId, ids) => {
        reorder.mutate({ kind, parentId, ids });
      }}
      onArchive={(category) => {
        archive.mutate(category.id);
      }}
    />
  );
}

function CategoriesPage() {
  const { t } = useTranslation('categories');
  const [kind, setKind] = useState<Kind>('expense');

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-4 py-6">
      <h1 className="text-2xl font-semibold">{t('title')}</h1>
      <Tabs
        value={kind}
        onValueChange={(value) => {
          setKind(value === 'income' ? 'income' : 'expense');
        }}
      >
        <TabsList>
          <TabsTrigger value="expense">{t('tabs.expense')}</TabsTrigger>
          <TabsTrigger value="income">{t('tabs.income')}</TabsTrigger>
        </TabsList>
        <TabsContent value="expense">
          <KindTree kind="expense" />
        </TabsContent>
        <TabsContent value="income">
          <KindTree kind="income" />
        </TabsContent>
      </Tabs>
      <Link
        to="/categorias/archivadas"
        className="text-sm text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {t('archived')}
      </Link>
    </div>
  );
}

function ArchivedList({ kind }: { kind: Kind }) {
  const { t } = useTranslation('categories');
  const tree = useCategories({ kind, status: 'archived' });
  if (tree.data === undefined) return null;
  const items = tree.data.flatMap((root) => [root, ...root.children]);
  if (items.length === 0) {
    return <p className="text-sm text-muted-foreground">{t('empty')}</p>;
  }
  return (
    <ul className="divide-y divide-border rounded-md border border-border">
      {items.map((category) => (
        <li key={category.id} className="px-4 py-3">
          {category.name}
        </li>
      ))}
    </ul>
  );
}

function ArchivedCategoriesPage() {
  const { t } = useTranslation('categories');
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-4 py-6">
      <h1 className="text-2xl font-semibold">{t('archivedTitle')}</h1>
      <section className="flex flex-col gap-2">
        <h2 className="text-lg font-semibold">{t('tabs.expense')}</h2>
        <ArchivedList kind="expense" />
      </section>
      <section className="flex flex-col gap-2">
        <h2 className="text-lg font-semibold">{t('tabs.income')}</h2>
        <ArchivedList kind="income" />
      </section>
      <Link
        to="/categorias"
        className="text-sm text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {t('back')}
      </Link>
    </div>
  );
}

export const categoriesRoutes: RouteObject[] = [
  { path: 'categorias', element: <CategoriesPage /> },
  { path: 'categorias/archivadas', element: <ArchivedCategoriesPage /> },
];
