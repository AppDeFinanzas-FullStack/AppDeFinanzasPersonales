import type { CategoryNode } from '@finanzas/contracts';
import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, GripVertical } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

interface TreeActions {
  /** Saves the new order of the categories that share a parent (`null` for main ones). */
  onReorder: (parentId: string | null, ids: string[]) => void;
  onArchive: (category: CategoryNode) => void;
}

interface RowProps extends TreeActions {
  category: CategoryNode;
  first: boolean;
  last: boolean;
  onMove: (offset: -1 | 1) => void;
}

function CategoryRow({ category, first, last, onMove, onReorder, onArchive }: RowProps) {
  const { t } = useTranslation('categories');
  const [open, setOpen] = useState(false);
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({
    id: category.id,
  });
  const style =
    transform === null
      ? undefined
      : { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)`, transition };
  const hasChildren = category.children.length > 0;

  return (
    <li ref={setNodeRef} style={style} data-testid={`category-${category.id}`} className="bg-background">
      <div className="flex items-center gap-2 px-4 py-2">
        <span
          {...attributes}
          {...listeners}
          aria-label={t('reorder.drag', { name: category.name })}
          className="flex h-11 w-6 shrink-0 cursor-grab touch-none items-center justify-center text-muted-foreground"
        >
          <GripVertical className="h-4 w-4" aria-hidden />
        </span>
        {hasChildren ? (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-11 w-11"
            aria-expanded={open}
            aria-label={t(open ? 'collapse' : 'expand', { name: category.name })}
            onClick={() => {
              setOpen(!open);
            }}
          >
            {open ? (
              <ChevronDown className="h-4 w-4" aria-hidden />
            ) : (
              <ChevronRight className="h-4 w-4" aria-hidden />
            )}
          </Button>
        ) : (
          <span className="w-11" />
        )}
        <span className="flex min-w-0 flex-1 items-center gap-2">
          <span className="truncate font-medium">{category.name}</span>
          {category.isSystem && <Badge variant="secondary">{t('system')}</Badge>}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-11 w-11"
          disabled={first}
          aria-label={t('reorder.up', { name: category.name })}
          onClick={() => {
            onMove(-1);
          }}
        >
          <ArrowUp className="h-4 w-4" aria-hidden />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-11 w-11"
          disabled={last}
          aria-label={t('reorder.down', { name: category.name })}
          onClick={() => {
            onMove(1);
          }}
        >
          <ArrowDown className="h-4 w-4" aria-hidden />
        </Button>
        {!category.isSystem && (
          <Button
            type="button"
            variant="ghost"
            className="h-11"
            onClick={() => {
              onArchive(category);
            }}
          >
            {t('archive')}
          </Button>
        )}
      </div>
      {hasChildren && open && (
        <div className="pl-10">
          <SortableList
            parentId={category.id}
            items={category.children}
            onReorder={onReorder}
            onArchive={onArchive}
          />
        </div>
      )}
    </li>
  );
}

function SortableList({
  parentId,
  items,
  onReorder,
  onArchive,
}: TreeActions & { parentId: string | null; items: readonly CategoryNode[] }): ReactNode {
  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const save = (ordered: CategoryNode[]) => {
    onReorder(
      parentId,
      ordered.map((category) => category.id),
    );
  };
  const dragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (over === null || active.id === over.id) return;
    const from = items.findIndex((category) => category.id === active.id);
    const to = items.findIndex((category) => category.id === over.id);
    if (from < 0 || to < 0) return;
    save(arrayMove([...items], from, to));
  };

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={dragEnd}>
      <SortableContext items={items.map((category) => category.id)} strategy={verticalListSortingStrategy}>
        <ul className="divide-y divide-border">
          {items.map((category, index) => (
            <CategoryRow
              key={category.id}
              category={category}
              first={index === 0}
              last={index === items.length - 1}
              onMove={(offset) => {
                save(arrayMove([...items], index, index + offset));
              }}
              onReorder={onReorder}
              onArchive={onArchive}
            />
          ))}
        </ul>
      </SortableContext>
    </DndContext>
  );
}

/**
 * The categories of one kind as a two-level tree (plan §4.5.4): main ones that unfold their
 * subcategories, each level reorderable by dragging or with "Subir" and "Bajar" (RNF-06). System
 * categories carry a badge and do not offer "Archivar" (RF-M5-05).
 */
export function CategoryTree({
  roots,
  onReorder,
  onArchive,
}: TreeActions & { roots: readonly CategoryNode[] }) {
  return (
    <div className="rounded-md border border-border">
      <SortableList parentId={null} items={roots} onReorder={onReorder} onArchive={onArchive} />
    </div>
  );
}
