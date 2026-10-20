import type { AccountDto } from '@finanzas/contracts';
import { startOfDayInstant, todayFor, type LocalDate } from '@finanzas/domain';

import { AppError } from '../errors.js';
import type {
  CategoryTreeNode,
  ShortcutRow,
  UserSettingsData,
} from '../ports/repositories.js';
import type { UnitOfWork } from '../ports/unit-of-work.js';
import type { AccountsService } from './accounts.service.js';
import type { RatesContext } from './rates.service.js';
import type { ShortcutsService } from './shortcuts.service.js';
import type { DescribedTransactionDetail, TransactionsService } from './transactions.service.js';

/** Chips of one kind in the grid of Registrar (RF-M7-04). */
const GRID_SIZE = 8;
/** Movements created today shown under the form (RF-M7-07). */
const TODAY_RECENT = 3;

/** What the composite query of Registrar reads from the user's history (plan §4.7.2). */
export interface RegisterUsage {
  /** Uses of each category in the last 60 days, by exact category: a child adds nothing to its parent. */
  categoryUses: { categoryId: string; uses: number; lastUsedAt: Date }[];
  /** The active preloaded categories, by `seed_order`. */
  seeded: string[];
  /** The account of the last expense and the last income created (RF-M7-03). */
  lastAccount: { expense: string | null; income: string | null };
  /** The accounts of the last transfer created (RF-M7-03). */
  lastTransfer: { from: string; to: string } | null;
}

/** The reads of Registrar, each one a single query bound to the user (RN-09). */
export interface RegisterUsageReader {
  /** The usage behind the grid and the preselected accounts, as of `today`. */
  read(userId: string, today: LocalDate): Promise<RegisterUsage>;
  /** The ids of the last movements created since `since`, without fees, most recent first. */
  createdSince(userId: string, since: Date, limit: number): Promise<string[]>;
}

/** A category of the grid, parent or subcategory alike (RF-M7-04). */
export interface GridCategory {
  id: string;
  name: string;
  color: string;
  icon: string;
  parentId: string | null;
}

/** Everything Registrar opens with (`RegisterContextDto`, plan §4.7.2). */
export interface RegisterContext {
  defaultAccountId: string | null;
  lastUsed: {
    expense: string | null;
    income: string | null;
    transferPair: { from: string; to: string } | null;
  };
  grid: { expense: GridCategory[]; income: GridCategory[] };
  /** The visible shortcuts, in their order (RF-M7-09). */
  shortcuts: ShortcutRow[];
  /** The last movements created today, whatever their date (RF-M7-07). */
  todayRecent: DescribedTransactionDetail[];
  /** The active accounts with their free balance and card data (RF-M7-11). */
  accounts: AccountDto[];
}

export interface RegisterService {
  /** `GET /api/register/context` (plan §4.7.2). */
  context(ctx: RatesContext): Promise<RegisterContext>;
  /** The last 3 movements created today, whatever their date (RF-M7-07). */
  todayRecent(ctx: RatesContext): Promise<DescribedTransactionDetail[]>;
}

export interface RegisterServiceDeps {
  uow: UnitOfWork;
  usage: RegisterUsageReader;
  accounts: AccountsService;
  shortcuts: ShortcutsService;
  transactions: TransactionsService;
}

/** The active categories of a tree, parents and subcategories, by id. */
function chipsOf(tree: CategoryTreeNode[]): Map<string, GridCategory> {
  const chips = new Map<string, GridCategory>();
  const add = (node: CategoryTreeNode, parentId: string | null) => {
    if (node.status !== 'active') return;
    chips.set(node.id, {
      id: node.id,
      name: node.name,
      color: node.color,
      icon: node.icon,
      parentId,
    });
  };
  for (const root of tree) {
    add(root, null);
    for (const child of root.children) add(child, root.id);
  }
  return chips;
}

/**
 * The grid of one kind (RF-M7-04): the favorites in their order, then the most used of the last
 * 60 days by exact category with ties to the most recent use, then the preloaded ones by
 * `seed_order`. Only active categories of the kind take part, so an archived one never shows
 * (RF-M5-06).
 */
function gridOf(
  tree: CategoryTreeNode[],
  favorites: readonly string[],
  usage: RegisterUsage,
): GridCategory[] {
  const chips = chipsOf(tree);
  const mostUsed = [...usage.categoryUses]
    .sort((a, b) => b.uses - a.uses || b.lastUsedAt.getTime() - a.lastUsedAt.getTime())
    .map((use) => use.categoryId);
  const grid: GridCategory[] = [];
  const taken = new Set<string>();
  for (const id of [...favorites.slice(0, GRID_SIZE), ...mostUsed, ...usage.seeded]) {
    if (grid.length === GRID_SIZE) break;
    const chip = chips.get(id);
    if (chip === undefined || taken.has(id)) continue;
    taken.add(id);
    grid.push(chip);
  }
  return grid;
}

export function createRegisterService({
  uow,
  usage: usageReader,
  accounts: accountsService,
  shortcuts: shortcutsService,
  transactions: transactionsService,
}: RegisterServiceDeps): RegisterService {
  async function todayRecent(ctx: RatesContext): Promise<DescribedTransactionDetail[]> {
    const today = todayFor(ctx.timezone, ctx.now);
    const ids = await usageReader.createdSince(
      ctx.userId,
      startOfDayInstant(today, ctx.timezone),
      TODAY_RECENT,
    );
    const recent: DescribedTransactionDetail[] = [];
    for (const id of ids) {
      try {
        recent.push(await transactionsService.get(ctx, id));
      } catch (error) {
        // Deleted between both reads: it is no longer recent.
        if (!(error instanceof AppError && error.code === 'NOT_FOUND')) throw error;
      }
    }
    return recent;
  }

  return {
    async context(ctx) {
      const today = todayFor(ctx.timezone, ctx.now);
      const usage = await usageReader.read(ctx.userId, today);
      const { settings, expenseTree, incomeTree } = await uow.run(
        async (repos) => ({
          settings: await repos.userSettings.find(ctx.userId),
          expenseTree: await repos.categories.tree('expense', 'active'),
          incomeTree: await repos.categories.tree('income', 'active'),
        }),
        { userLock: ctx.userId, readOnly: true },
      );
      const accounts = await accountsService.list(ctx, 'active');
      const shortcuts = await shortcutsService.listVisible(ctx.userId);

      // RF-M7-03, RF-M4-12, EC-M7-05: the last account used if it is still active, else the first
      // active one in the user's order.
      const activeIds = new Set(accounts.map((account) => account.id));
      const firstActive =
        [...accounts].sort((a, b) => a.sortOrder - b.sortOrder).at(0)?.id ?? null;
      const stillActive = (id: string | null): string | null =>
        id !== null && activeIds.has(id) ? id : firstActive;
      const pair = usage.lastTransfer;
      const favorites: UserSettingsData['favorites'] = settings?.favorites ?? {
        expense: [],
        income: [],
      };
      const defaultAccountId = settings?.defaultAccountId ?? null;

      return {
        defaultAccountId:
          defaultAccountId !== null && activeIds.has(defaultAccountId) ? defaultAccountId : null,
        lastUsed: {
          expense: stillActive(usage.lastAccount.expense),
          income: stillActive(usage.lastAccount.income),
          transferPair:
            pair !== null && activeIds.has(pair.from) && activeIds.has(pair.to) ? pair : null,
        },
        grid: {
          expense: gridOf(expenseTree, favorites.expense, usage),
          income: gridOf(incomeTree, favorites.income, usage),
        },
        shortcuts,
        todayRecent: await todayRecent(ctx),
        accounts,
      };
    },

    todayRecent,
  };
}
