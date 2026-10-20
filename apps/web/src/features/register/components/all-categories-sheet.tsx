import type { CategoryChip, CategoryNode } from '@finanzas/contracts';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { useCategories } from '@/features/categories/hooks/use-categories';

import { CategoryMark } from './category-grid';

type ChipKind = 'expense' | 'income';

const chipOf = (node: CategoryNode, parentId: string | null): CategoryChip => ({
  id: node.id,
  name: node.name,
  color: node.color,
  icon: node.icon,
  parentId,
});

function CategoryButton({
  node,
  parentId,
  selected,
  onSelect,
}: {
  node: CategoryNode;
  parentId: string | null;
  selected: boolean;
  onSelect: (category: CategoryChip) => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      className="flex min-h-11 flex-1 items-center gap-3 rounded-md px-2 text-left text-base aria-pressed:font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      onClick={() => {
        onSelect(chipOf(node, parentId));
      }}
    >
      <CategoryMark category={node} />
      <span className="min-w-0 truncate">{node.name}</span>
    </button>
  );
}

function ParentRow({
  node,
  selectedId,
  onSelect,
}: {
  node: CategoryNode;
  selectedId: string;
  onSelect: (category: CategoryChip) => void;
}) {
  const { t } = useTranslation('register');
  const children = node.children.filter((child) => child.status === 'active');
  const [open, setOpen] = useState(children.some((child) => child.id === selectedId));
  return (
    <li className="flex flex-col">
      <div className="flex items-center gap-1">
        <CategoryButton
          node={node}
          parentId={null}
          selected={node.id === selectedId}
          onSelect={onSelect}
        />
        {children.length > 0 && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-11 w-11"
            aria-expanded={open}
            aria-label={t(open ? 'category.collapse' : 'category.expand', { name: node.name })}
            onClick={() => {
              setOpen(!open);
            }}
          >
            {open ? <ChevronDown aria-hidden /> : <ChevronRight aria-hidden />}
          </Button>
        )}
      </div>
      {open && children.length > 0 && (
        <ul className="ml-6 flex flex-col border-l border-border pl-2">
          {children.map((child) => (
            <li key={child.id}>
              <CategoryButton
                node={child}
                parentId={node.id}
                selected={child.id === selectedId}
                onSelect={onSelect}
              />
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

/** The active categories of the kind; it loads only once the sheet is open. */
function CategoryList({
  kind,
  selectedId,
  onSelect,
}: {
  kind: ChipKind;
  selectedId: string;
  onSelect: (category: CategoryChip) => void;
}) {
  const { t } = useTranslation('register');
  const categories = useCategories({ kind, status: 'active' });
  if (categories.data === undefined) {
    return categories.isError ? (
      <p role="alert" className="text-sm text-destructive">
        {t('category.loadError')}
      </p>
    ) : null;
  }
  return (
    <ul className="flex flex-col gap-1 overflow-y-auto">
      {categories.data
        .filter((node) => node.status === 'active')
        .map((node) => (
          <ParentRow key={node.id} node={node} selectedId={selectedId} onSelect={onSelect} />
        ))}
    </ul>
  );
}

interface AllCategoriesSheetProps {
  open: boolean;
  kind: ChipKind;
  selectedId: string;
  onOpenChange: (open: boolean) => void;
  onSelect: (category: CategoryChip) => void;
}

/** `<AllCategoriesSheet>`: every active category of the kind, parents expandable (RF-M7-04). */
export function AllCategoriesSheet({
  open,
  kind,
  selectedId,
  onOpenChange,
  onSelect,
}: AllCategoriesSheetProps) {
  const { t } = useTranslation('register');
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="flex max-h-[85vh] flex-col gap-4">
        <SheetHeader>
          <SheetTitle>{t(`category.allTitle.${kind}`)}</SheetTitle>
          <SheetDescription>{t('category.allDescription')}</SheetDescription>
        </SheetHeader>
        <CategoryList
          kind={kind}
          selectedId={selectedId}
          onSelect={(category) => {
            onSelect(category);
            onOpenChange(false);
          }}
        />
      </SheetContent>
    </Sheet>
  );
}
