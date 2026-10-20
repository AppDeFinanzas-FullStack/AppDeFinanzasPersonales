import type {
  CreateShortcutInput,
  ReorderShortcutsInput,
  UpdateShortcutInput,
} from '@finanzas/contracts';
import { Decimal } from 'decimal.js';

import { AppError } from '../errors.js';
import type {
  Repositories,
  ShortcutKind,
  ShortcutPatch,
  ShortcutRow,
} from '../ports/repositories.js';
import type { UnitOfWork } from '../ports/unit-of-work.js';
import { assertLimit } from '../shared/limits.js';

export interface ShortcutsService {
  /** Every shortcut of the user, hidden ones included, in their order (RF-M7-10). */
  list(userId: string): Promise<ShortcutRow[]>;
  /** The shortcuts whose account, and destination or category, are active (plan §4.7.3). */
  listVisible(userId: string): Promise<ShortcutRow[]>;
  /**
   * Creates a shortcut, idempotent by `input.id` (ADR-11). The user has at most 12, hidden ones
   * included (RF-M7-09, EC-M7-06).
   */
  create(
    userId: string,
    input: CreateShortcutInput,
  ): Promise<{ created: boolean; shortcut: ShortcutRow }>;
  /** Changes the fields sent; a transfer drops its category and the others their destination. */
  update(userId: string, id: string, input: UpdateShortcutInput): Promise<ShortcutRow>;
  /** Gives the shortcuts the order of `ids`, which must be exactly all of them (RF-M7-10). */
  reorder(userId: string, input: ReorderShortcutsInput): Promise<void>;
  remove(userId: string, id: string): Promise<void>;
}

function invalidField(path: string, code: string): AppError {
  return new AppError('VALIDATION_ERROR', { issues: [{ path, code }] });
}

/** The account of a shortcut must be one of the user's active accounts. */
async function assertActiveAccount(repos: Repositories, id: string, path: string): Promise<void> {
  const account = await repos.accounts.get(id);
  if (account?.status !== 'active') {
    throw invalidField(path, 'not_found');
  }
}

/** The category of an expense or income shortcut is active and of that kind. */
async function assertCategory(repos: Repositories, id: string, kind: ShortcutKind): Promise<void> {
  const category = await repos.categories.get(id);
  if (category?.status !== 'active' || category.kind !== kind) {
    throw invalidField('categoryId', 'not_found');
  }
}

/** RF-M7-09: a transfer goes to another account and has no category; the rest has a category. */
async function assertShape(repos: Repositories, shortcut: ShortcutRow): Promise<void> {
  if (shortcut.kind === 'transfer') {
    if (shortcut.destAccountId === null) {
      throw invalidField('destAccountId', 'required');
    }
    if (shortcut.destAccountId === shortcut.accountId) {
      throw invalidField('destAccountId', 'SAME_ACCOUNT');
    }
    return;
  }
  if (shortcut.categoryId === null) {
    throw invalidField('categoryId', 'required');
  }
  await assertCategory(repos, shortcut.categoryId, shortcut.kind);
}

function sameShortcut(row: ShortcutRow, input: CreateShortcutInput): boolean {
  const amount = input.amount === undefined ? null : new Decimal(input.amount);
  return (
    row.name === input.name &&
    row.kind === input.kind &&
    (row.amount === null || amount === null ? row.amount === amount : row.amount.equals(amount)) &&
    row.accountId === input.accountId &&
    row.destAccountId === (input.destAccountId ?? null) &&
    row.categoryId === (input.categoryId ?? null) &&
    row.note === (input.note ?? null)
  );
}

async function readBack(repos: Repositories, id: string): Promise<ShortcutRow> {
  const shortcut = await repos.shortcuts.get(id);
  if (shortcut === null) {
    throw new AppError('INTERNAL_ERROR');
  }
  return shortcut;
}

export function createShortcutsService({ uow }: { uow: UnitOfWork }): ShortcutsService {
  return {
    async list(userId) {
      return uow.run((repos) => repos.shortcuts.list(), { userLock: userId, readOnly: true });
    },

    async listVisible(userId) {
      return uow.run((repos) => repos.shortcuts.listVisible(), {
        userLock: userId,
        readOnly: true,
      });
    },

    async create(userId, input) {
      return uow.run(
        async (repos) => {
          const existing = await repos.shortcuts.get(input.id);
          if (existing !== null) {
            if (!sameShortcut(existing, input)) {
              throw new AppError('IDEMPOTENCY_CONFLICT');
            }
            return { created: false, shortcut: existing };
          }

          const count = await repos.shortcuts.count();
          assertLimit(count, 'shortcuts');

          const shortcut: ShortcutRow = {
            id: input.id,
            name: input.name,
            kind: input.kind,
            amount: input.amount === undefined ? null : new Decimal(input.amount),
            accountId: input.accountId,
            destAccountId: input.kind === 'transfer' ? (input.destAccountId ?? null) : null,
            categoryId: input.kind === 'transfer' ? null : (input.categoryId ?? null),
            note: input.note === undefined || input.note === '' ? null : input.note,
            sortOrder: count,
          };
          await assertActiveAccount(repos, shortcut.accountId, 'accountId');
          if (shortcut.destAccountId !== null) {
            await assertActiveAccount(repos, shortcut.destAccountId, 'destAccountId');
          }
          await assertShape(repos, shortcut);

          await repos.shortcuts.insert(shortcut);
          return { created: true, shortcut: await readBack(repos, input.id) };
        },
        { userLock: userId },
      );
    },

    async update(userId, id, input) {
      return uow.run(
        async (repos) => {
          const current = await repos.shortcuts.get(id);
          if (current === null) {
            throw new AppError('NOT_FOUND');
          }
          const kind = input.kind ?? current.kind;
          const next: ShortcutRow = {
            ...current,
            name: input.name ?? current.name,
            kind,
            amount: input.amount === undefined ? current.amount : new Decimal(input.amount),
            accountId: input.accountId ?? current.accountId,
            destAccountId:
              kind === 'transfer' ? (input.destAccountId ?? current.destAccountId) : null,
            categoryId: kind === 'transfer' ? null : (input.categoryId ?? current.categoryId),
            note: input.note === undefined ? current.note : input.note === '' ? null : input.note,
          };

          if (next.accountId !== current.accountId) {
            await assertActiveAccount(repos, next.accountId, 'accountId');
          }
          if (next.destAccountId !== null && next.destAccountId !== current.destAccountId) {
            await assertActiveAccount(repos, next.destAccountId, 'destAccountId');
          }
          await assertShape(repos, next);

          const patch: ShortcutPatch = {
            name: next.name,
            kind: next.kind,
            amount: next.amount,
            accountId: next.accountId,
            destAccountId: next.destAccountId,
            categoryId: next.categoryId,
            note: next.note,
          };
          await repos.shortcuts.update(id, patch);
          return readBack(repos, id);
        },
        { userLock: userId },
      );
    },

    async reorder(userId, input) {
      await uow.run(
        async (repos) => {
          const owned = (await repos.shortcuts.list()).map((shortcut) => shortcut.id);
          const wanted = new Set(input.ids);
          const exact =
            wanted.size === input.ids.length &&
            wanted.size === owned.length &&
            owned.every((shortcutId) => wanted.has(shortcutId));
          if (!exact) {
            throw invalidField('ids', 'invalid_value');
          }
          await repos.shortcuts.setOrder(input.ids);
        },
        { userLock: userId },
      );
    },

    async remove(userId, id) {
      await uow.run(
        async (repos) => {
          if (!(await repos.shortcuts.remove(id))) {
            throw new AppError('NOT_FOUND');
          }
        },
        { userLock: userId },
      );
    },
  };
}
