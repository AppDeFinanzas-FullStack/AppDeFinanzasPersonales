import type { IconKey, PaletteKey, RegisterContextDto } from '@finanzas/contracts';

import type { RegisterContext } from '../../application/services/register.service.js';

import { ShortcutsPresenter } from './shortcuts.presenter.js';
import { TransactionsPresenter, type TransactionResponse } from './transactions.presenter.js';

/**
 * The answer of `GET /api/register/context` (plan §4.7.2). Without a rate to convert it, the
 * `amountInBase` of a recent movement is `null` (EC-M3-02).
 */
export type RegisterContextResponse = Omit<RegisterContextDto, 'todayRecent'> & {
  todayRecent: TransactionResponse[];
};

/** Builds the answers of `/api/register` (plan §4.7.2); amounts travel as decimal text (ADR-03). */
export const RegisterPresenter = {
  context(context: RegisterContext): RegisterContextResponse {
    const chip = (category: RegisterContext['grid']['expense'][number]) => ({
      id: category.id,
      name: category.name,
      color: category.color as PaletteKey,
      icon: category.icon as IconKey,
      parentId: category.parentId,
    });
    return {
      defaultAccountId: context.defaultAccountId,
      lastUsed: context.lastUsed,
      grid: {
        expense: context.grid.expense.map(chip),
        income: context.grid.income.map(chip),
      },
      shortcuts: context.shortcuts.map((shortcut) => ShortcutsPresenter.toDto(shortcut)),
      todayRecent: context.todayRecent.map((movement) =>
        TransactionsPresenter.transaction(movement),
      ),
      accounts: context.accounts.map((account) => ({
        id: account.id,
        name: account.name,
        type: account.type,
        currencyCode: account.currencyCode,
        free: account.free,
        card: account.card,
        dedicatedGoal: account.dedicatedGoal,
      })),
    };
  },
};
