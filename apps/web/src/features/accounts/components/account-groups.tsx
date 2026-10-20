import { AccountType, type AccountDto } from '@finanzas/contracts';
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
import { ArrowDown, ArrowUp, GripVertical } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import { Button } from '@/components/ui/button';
import { useFormatters } from '@/features/settings/hooks/use-settings';

import { useCurrencySymbol } from '../hooks/use-accounts';

interface Group {
  type: AccountType;
  accounts: AccountDto[];
}

/** Accounts grouped by type in the catalog order, each group by `sortOrder` (RF-M4-11). */
export function groupAccounts(accounts: readonly AccountDto[]): Group[] {
  return AccountType.options
    .map((type) => ({
      type,
      accounts: accounts
        .filter((account) => account.type === type)
        .sort((a, b) => a.sortOrder - b.sortOrder),
    }))
    .filter((group) => group.accounts.length > 0);
}

/** The balance as text; a card shows "Debes X" or "A favor X" (RF-M4-08). */
function useBalanceText(): (account: AccountDto) => string {
  const { t } = useTranslation('accounts');
  const formatters = useFormatters();
  const symbolOf = useCurrencySymbol();
  return (account) => {
    const symbol = symbolOf(account.currencyCode);
    if (account.type !== 'credit_card') return formatters.money(account.balance, symbol);
    const debt = account.balance.startsWith('-');
    const amount = formatters.money(debt ? account.balance.slice(1) : account.balance, symbol);
    return debt ? t('card.debt', { amount }) : t('card.credit', { amount });
  };
}

interface RowProps {
  account: AccountDto;
  base: string;
  reorderable: boolean;
  first: boolean;
  last: boolean;
  onMove: (offset: -1 | 1) => void;
}

function AccountRow({ account, base, reorderable, first, last, onMove }: RowProps) {
  const { t } = useTranslation('accounts');
  const formatters = useFormatters();
  const symbolOf = useCurrencySymbol();
  const balanceText = useBalanceText();
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({
    id: account.id,
    disabled: !reorderable,
  });
  const style =
    transform === null
      ? undefined
      : { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)`, transition };

  return (
    <li
      ref={setNodeRef}
      style={style}
      data-testid={`account-${account.id}`}
      className="flex items-center gap-2 bg-background px-4 py-3"
    >
      {reorderable && (
        <span
          {...attributes}
          {...listeners}
          aria-label={t('reorder.drag', { name: account.name })}
          className="flex h-11 w-6 shrink-0 cursor-grab touch-none items-center justify-center text-muted-foreground"
        >
          <GripVertical className="h-4 w-4" aria-hidden />
        </span>
      )}
      <div className="flex min-w-0 flex-1 items-baseline justify-between gap-4">
        <Link
          to={`/cuentas/${account.id}`}
          className="min-w-0 truncate font-medium underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {account.name}
        </Link>
        <span className="flex flex-col items-end text-right tabular-nums">
          <span className="font-semibold">{balanceText(account)}</span>
          {account.currencyCode !== base && (
            <span className="text-sm text-muted-foreground">
              {account.balanceInBase === null
                ? t('noRate')
                : formatters.money(account.balanceInBase, symbolOf(base))}
            </span>
          )}
        </span>
      </div>
      {reorderable && (
        <div className="flex shrink-0">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-11 w-11"
            disabled={first}
            aria-label={t('reorder.up', { name: account.name })}
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
            aria-label={t('reorder.down', { name: account.name })}
            onClick={() => {
              onMove(1);
            }}
          >
            <ArrowDown className="h-4 w-4" aria-hidden />
          </Button>
        </div>
      )}
    </li>
  );
}

/**
 * The accounts grouped by type (RF-M4-11). When reorderable, each account moves within its group
 * by dragging or with the "Subir" and "Bajar" buttons (RNF-06); `onReorder` gets every id in the
 * new order.
 */
export function AccountGroups({
  accounts,
  base,
  onReorder,
}: {
  accounts: readonly AccountDto[];
  base: string;
  onReorder?: (ids: string[]) => void;
}) {
  const { t } = useTranslation('accounts');
  const groups = groupAccounts(accounts);
  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const save = (type: AccountType, ordered: AccountDto[]) => {
    if (onReorder === undefined) return;
    const next = groups.map((group) => (group.type === type ? ordered : group.accounts));
    onReorder(next.flat().map((account) => account.id));
  };

  const move = (group: Group, index: number, offset: -1 | 1) => {
    save(group.type, arrayMove(group.accounts, index, index + offset));
  };

  const dragEnd = (group: Group) => (event: DragEndEvent) => {
    const { active, over } = event;
    if (over === null || active.id === over.id) return;
    const from = group.accounts.findIndex((account) => account.id === active.id);
    const to = group.accounts.findIndex((account) => account.id === over.id);
    if (from < 0 || to < 0) return;
    save(group.type, arrayMove(group.accounts, from, to));
  };

  return (
    <div className="flex flex-col gap-6">
      {groups.map((group) => (
        <section
          key={group.type}
          aria-labelledby={`group-${group.type}`}
          className="flex flex-col gap-2"
        >
          <h2 id={`group-${group.type}`} className="text-lg font-semibold">
            {t(`types.${group.type}`)}
          </h2>
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={dragEnd(group)}
          >
            <SortableContext
              items={group.accounts.map((account) => account.id)}
              strategy={verticalListSortingStrategy}
            >
              <ul className="flex flex-col divide-y divide-border overflow-hidden rounded-lg border border-border">
                {group.accounts.map((account, index) => (
                  <AccountRow
                    key={account.id}
                    account={account}
                    base={base}
                    reorderable={onReorder !== undefined && group.accounts.length > 1}
                    first={index === 0}
                    last={index === group.accounts.length - 1}
                    onMove={(offset) => {
                      move(group, index, offset);
                    }}
                  />
                ))}
              </ul>
            </SortableContext>
          </DndContext>
        </section>
      ))}
    </div>
  );
}
