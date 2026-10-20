import type { ShortcutDto } from '@finanzas/contracts';

import type { ShortcutRow } from '../../application/ports/repositories.js';

/** Builds the answers of `/api/shortcuts` (plan §4.7.2); amounts travel as decimal text (ADR-03). */
export const ShortcutsPresenter = {
  toDto(shortcut: ShortcutRow): ShortcutDto {
    return {
      id: shortcut.id,
      name: shortcut.name,
      kind: shortcut.kind,
      amount: shortcut.amount === null ? null : shortcut.amount.toFixed(2),
      accountId: shortcut.accountId,
      destAccountId: shortcut.destAccountId,
      categoryId: shortcut.categoryId,
      note: shortcut.note,
      sortOrder: shortcut.sortOrder,
    };
  },

  list(shortcuts: readonly ShortcutRow[]): { items: ShortcutDto[] } {
    return { items: shortcuts.map((shortcut) => ShortcutsPresenter.toDto(shortcut)) };
  },
};
