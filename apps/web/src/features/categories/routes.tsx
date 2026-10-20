import type { CategoryNode } from '@finanzas/contracts';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams, useSearchParams, type RouteObject } from 'react-router';

import { i18n, LANGUAGE } from '@/app/providers/i18n';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import categories from '@/locales/es-BO/categories.json';

import { ArchiveCategoryDialog } from './components/archive-category-dialog';
import { CategoryForm } from './components/category-form';
import { CategoryTree } from './components/category-tree';
import { MergeDialog, mergeableSources } from './components/merge-dialog';
import { RestoreCategoryDialog } from './components/restore-category-dialog';
import { useCategories, useReorderCategories } from './hooks/use-categories';

// The feature registers its own namespace (RNF-07).
i18n.addResourceBundle(LANGUAGE, 'categories', categories, true, true);

type Kind = 'expense' | 'income';

const kindOf = (value: string | null): Kind => (value === 'income' ? 'income' : 'expense');

const selectClass =
  'flex h-11 w-full rounded-md border border-input bg-background px-3 py-2 text-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:text-sm';

const linkClass =
  'text-sm text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

/** Every category of the tree, main ones followed by their subcategories. */
const flatten = (roots: readonly CategoryNode[]) =>
  roots.flatMap((root) => [
    { ...root, parentId: null },
    ...root.children.map((child) => ({ ...child, parentId: root.id })),
  ]);

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
  const navigate = useNavigate();
  const tree = useCategories({ kind, status: 'active' });
  const reorder = useReorderCategories();
  const [archiving, setArchiving] = useState<CategoryNode | null>(null);
  const [merging, setMerging] = useState<CategoryNode | null>(null);

  if (tree.isError && tree.data === undefined) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {t('loadError')}
      </p>
    );
  }
  if (tree.data === undefined) return null;
  const roots = tree.data;
  const all = flatten(roots);
  const editable = all.filter((category) => !category.isSystem);
  const sources = mergeableSources(roots);

  return (
    <div className="flex flex-col gap-6">
      <Link to={`/categorias/nueva?kind=${kind}`} className={linkClass}>
        {t('new')}
      </Link>
      {roots.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('empty')}</p>
      ) : (
        <CategoryTree
          roots={inOrder(roots, reorder.isPending ? reorder.variables : undefined)}
          onReorder={(parentId, ids) => {
            reorder.mutate({ kind, parentId, ids });
          }}
          onArchive={setArchiving}
        />
      )}
      {editable.length > 0 && (
        <div className="flex flex-col gap-2">
          <Label htmlFor={`edit-${kind}`}>{t('edit')}</Label>
          <select
            id={`edit-${kind}`}
            className={selectClass}
            value=""
            onChange={(event) => {
              if (event.target.value !== '') {
                void navigate(`/categorias/${event.target.value}/editar?kind=${kind}`);
              }
            }}
          >
            <option value="">{t('pick')}</option>
            {editable.map((category) => (
              <option key={category.id} value={category.id}>
                {category.name}
              </option>
            ))}
          </select>
        </div>
      )}
      {sources.length > 0 && (
        <div className="flex flex-col gap-2">
          <Label htmlFor={`merge-${kind}`}>{t('mergeFrom')}</Label>
          <select
            id={`merge-${kind}`}
            className={selectClass}
            value=""
            onChange={(event) => {
              setMerging(sources.find((category) => category.id === event.target.value) ?? null);
            }}
          >
            <option value="">{t('pick')}</option>
            {sources.map((category) => (
              <option key={category.id} value={category.id}>
                {category.name}
              </option>
            ))}
          </select>
        </div>
      )}
      {archiving !== null && (
        <ArchiveCategoryDialog
          category={archiving}
          onClose={() => {
            setArchiving(null);
          }}
        />
      )}
      {merging !== null && (
        <MergeDialog
          source={merging}
          roots={roots}
          onClose={() => {
            setMerging(null);
          }}
        />
      )}
    </div>
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
          setKind(kindOf(value));
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
      <Link to="/categorias/archivadas" className={linkClass}>
        {t('archived')}
      </Link>
    </div>
  );
}

function CategoryFormPage() {
  const { t } = useTranslation('categories');
  const navigate = useNavigate();
  const { id } = useParams();
  const [params] = useSearchParams();
  const kind = kindOf(params.get('kind'));
  const tree = useCategories({ kind, status: 'active' });
  const category =
    id === undefined ? undefined : flatten(tree.data ?? []).find((item) => item.id === id);
  if (id !== undefined && category === undefined) return null;

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-4 py-6">
      <h1 className="text-2xl font-semibold">{t(category === undefined ? 'new' : 'editTitle')}</h1>
      <CategoryForm
        kind={kind}
        category={category}
        onDone={() => {
          void navigate('/categorias');
        }}
      />
    </div>
  );
}

function ArchivedList({ kind }: { kind: Kind }) {
  const { t } = useTranslation('categories');
  const tree = useCategories({ kind, status: 'archived' });
  const [restoring, setRestoring] = useState<CategoryNode | null>(null);
  if (tree.data === undefined) return null;
  const items = tree.data.flatMap((root) => [root, ...root.children]);
  if (items.length === 0) {
    return <p className="text-sm text-muted-foreground">{t('empty')}</p>;
  }
  return (
    <>
      <ul className="divide-y divide-border rounded-md border border-border">
        {items.map((category) => (
          <li key={category.id} className="flex items-center justify-between gap-4 px-4 py-2">
            <span>{category.name}</span>
            <Button
              type="button"
              variant="ghost"
              className="h-11"
              onClick={() => {
                setRestoring(category);
              }}
            >
              {t('restore')}
            </Button>
          </li>
        ))}
      </ul>
      {restoring !== null && (
        <RestoreCategoryDialog
          category={restoring}
          onClose={() => {
            setRestoring(null);
          }}
        />
      )}
    </>
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
      <Link to="/categorias" className={linkClass}>
        {t('back')}
      </Link>
    </div>
  );
}

export const categoriesRoutes: RouteObject[] = [
  { path: 'categorias', element: <CategoriesPage /> },
  { path: 'categorias/nueva', element: <CategoryFormPage /> },
  { path: 'categorias/archivadas', element: <ArchivedCategoriesPage /> },
  { path: 'categorias/:id/editar', element: <CategoryFormPage /> },
];
