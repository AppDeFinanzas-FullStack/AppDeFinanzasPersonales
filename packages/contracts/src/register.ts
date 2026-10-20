import { z } from 'zod';

import { AccountDto } from './accounts.js';
import { IconKey, PaletteKey } from './catalogs.js';
import { Amount, Money, Note, Uuid } from './common.js';
import { TransactionDto } from './transactions.js';

/** Most chips of one kind in the grid of Registrar (RF-M7-04). */
const GRID_SIZE = 8;
/** Movements created today shown under the form (RF-M7-07). */
const TODAY_RECENT = 3;

export const ShortcutKind = z.enum(['expense', 'income', 'transfer']);
export type ShortcutKind = z.infer<typeof ShortcutKind>;

const ShortcutName = z.string().trim().min(1).max(30);

const ShortcutFields = z.object({
  id: Uuid,
  name: ShortcutName,
  kind: ShortcutKind,
  amount: Amount.optional(),
  accountId: Uuid,
  destAccountId: Uuid.optional(),
  categoryId: Uuid.optional(),
  note: Note.optional(),
});

type ShortcutShape = Partial<z.infer<typeof ShortcutFields>>;

/**
 * RF-M7-09: a transfer takes a destination other than its account and no category; an expense or
 * an income takes no destination. On a partial update only the fields sent are checked.
 */
function checkShortcutShape(
  shortcut: ShortcutShape,
  ctx: z.RefinementCtx,
  complete: boolean,
): void {
  if (shortcut.kind === 'transfer') {
    if (complete && shortcut.destAccountId === undefined) {
      ctx.addIssue({ code: 'custom', path: ['destAccountId'], message: 'DEST_REQUIRED' });
    }
    if (shortcut.categoryId !== undefined) {
      ctx.addIssue({ code: 'custom', path: ['categoryId'], message: 'CATEGORY_NOT_ALLOWED' });
    }
    if (shortcut.destAccountId !== undefined && shortcut.destAccountId === shortcut.accountId) {
      ctx.addIssue({ code: 'custom', path: ['destAccountId'], message: 'SAME_ACCOUNT' });
    }
  } else if (shortcut.kind !== undefined) {
    if (shortcut.destAccountId !== undefined) {
      ctx.addIssue({ code: 'custom', path: ['destAccountId'], message: 'DEST_NOT_ALLOWED' });
    }
    if (complete && shortcut.categoryId === undefined) {
      ctx.addIssue({ code: 'custom', path: ['categoryId'], message: 'CATEGORY_REQUIRED' });
    }
  }
}

export const CreateShortcutInput = ShortcutFields.superRefine((shortcut, ctx) => {
  checkShortcutShape(shortcut, ctx, true);
});
export type CreateShortcutInput = z.infer<typeof CreateShortcutInput>;

export const UpdateShortcutInput = ShortcutFields.omit({ id: true })
  .partial()
  .superRefine((shortcut, ctx) => {
    checkShortcutShape(shortcut, ctx, false);
  });
export type UpdateShortcutInput = z.infer<typeof UpdateShortcutInput>;

export const ReorderShortcutsInput = z.object({ ids: z.array(Uuid).min(1) });
export type ReorderShortcutsInput = z.infer<typeof ReorderShortcutsInput>;

export const ShortcutDto = z.object({
  id: Uuid,
  name: z.string(),
  kind: ShortcutKind,
  amount: Money.nullable(),
  accountId: Uuid,
  destAccountId: Uuid.nullable(),
  categoryId: Uuid.nullable(),
  note: z.string().nullable(),
  sortOrder: z.number().int(),
});
export type ShortcutDto = z.infer<typeof ShortcutDto>;

/** A category of the grid, parent or subcategory alike (RF-M7-04). */
export const CategoryChip = z.object({
  id: Uuid,
  name: z.string(),
  color: PaletteKey,
  icon: IconKey,
  parentId: Uuid.nullable(),
});
export type CategoryChip = z.infer<typeof CategoryChip>;

export const RegisterContextDto = z.object({
  defaultAccountId: Uuid.nullable(),
  lastUsed: z.object({
    expense: Uuid.nullable(),
    income: Uuid.nullable(),
    transferPair: z.object({ from: Uuid, to: Uuid }).nullable(),
  }),
  grid: z.object({
    expense: z.array(CategoryChip).max(GRID_SIZE),
    income: z.array(CategoryChip).max(GRID_SIZE),
  }),
  /** The visible shortcuts, in their order (RF-M7-09). */
  shortcuts: z.array(ShortcutDto),
  /** The last movements created today, whatever their date (RF-M7-07). */
  todayRecent: z.array(TransactionDto).max(TODAY_RECENT),
  accounts: z.array(
    AccountDto.pick({
      id: true,
      name: true,
      type: true,
      currencyCode: true,
      free: true,
      card: true,
      dedicatedGoal: true,
    }),
  ),
});
export type RegisterContextDto = z.infer<typeof RegisterContextDto>;
