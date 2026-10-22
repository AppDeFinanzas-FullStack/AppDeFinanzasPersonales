import type {
  AccountPreset,
  AccountType,
  IconKey,
  PaletteKey,
  RatesCurrentDto,
  SkipInput,
  Step1Input,
  Step2Input,
} from '@finanzas/contracts';
import { todayFor } from '@finanzas/domain';

import { AppError } from '../errors.js';
import type {
  CategoryTreeNode,
  OnboardingProgress,
  OnboardingStep,
  OnboardingTransition,
  Repositories,
} from '../ports/repositories.js';
import type { UnitOfWork, UnitOfWorkOptions } from '../ports/unit-of-work.js';
import { createLedgerHooks } from '../shared/ledger-hooks.js';
import { createAccountsService, type AccountsService } from './accounts.service.js';
import { createRatesService, type RatesContext, type RatesService } from './rates.service.js';

/** Request context built from the session (plan §1.4). */
export type OnboardingContext = RatesContext;

/** What the Onboarding opens with (`OnboardingDto`, plan §4.10.1). */
export interface OnboardingState {
  step: OnboardingStep;
  completed: boolean;
  presets: {
    /** The suggested accounts of step 2 (spec §2.10.1). */
    accounts: AccountPreset[];
    /** The active categories of the user, expense and income, as two-level trees. */
    categories: CategoryTreeNode[];
  };
  /** The USD rate in use, or `null` when there is no rate yet (spec §2.10.1). */
  rate: RatesCurrentDto['inUse'] | null;
}

export interface OnboardingService {
  /** The pending step with what it shows; `ONBOARDING_DONE` once finished (plan §4.10.3). */
  get(ctx: OnboardingContext): Promise<OnboardingState>;
  /** Stores the chosen base currency and moves to step 2 (RF-M10-01). */
  step1(ctx: OnboardingContext, input: Step1Input): Promise<OnboardingProgress>;
  /**
   * Creates the accounts of step 2, idempotent by their ids (ADR-11), with the balance dated the
   * user's today (RF-M10-04), and moves to step 3 in the same transaction: an account rejected by
   * RF-M4-01 or RF-M4-02 leaves none of them and the Onboarding in step 2 (EC-M10-01, EC-M10-02).
   */
  step2(ctx: OnboardingContext, input: Step2Input): Promise<OnboardingProgress>;
  /**
   * Skips the pending step: step 1 leaves BOB as the base (RF-M10-02), step 2 creates no account
   * (RF-M10-03) and step 3 keeps every category (RF-M10-06) and finishes the Onboarding.
   */
  skip(ctx: OnboardingContext, input: SkipInput): Promise<OnboardingProgress>;
  /** Finishes the Onboarding from the pending step; from step 1 it leaves BOB (RF-M10-02). */
  skipAll(ctx: OnboardingContext): Promise<OnboardingProgress>;
}

/** Suggested accounts of step 2, checked or not by default (spec §2.10.1). */
const ACCOUNT_PRESETS: readonly AccountPreset[] = [
  { name: 'Efectivo (Bs)', type: 'cash', currencyCode: 'BOB', checked: true },
  { name: 'Banco (Bs)', type: 'bank', currencyCode: 'BOB', checked: true },
  { name: 'Dólares en efectivo ($)', type: 'cash', currencyCode: 'USD', checked: false },
];

/** Color of the accounts of step 2, the one a new account starts with in the account form. */
const ACCOUNT_COLOR: PaletteKey = 'teal';

/** Icon of the accounts of step 2 by type, the one a new account starts with in the form. */
const ACCOUNT_ICON: Record<AccountType, IconKey> = {
  cash: 'banknote',
  bank: 'landmark',
  ewallet: 'smartphone',
  credit_card: 'credit-card',
  savings: 'piggy-bank',
  other: 'wallet',
};

/** Base currency left when step 1 is skipped (RF-M10-02). */
const DEFAULT_BASE = 'BOB';

/** Where each step leads; step 3 is the last one, so leaving it finishes (spec §2.10.2). */
const NEXT: Record<OnboardingStep, OnboardingTransition['to']> = { 1: 2, 2: 3, 3: 'done' };

/** The progress of an Onboarding not finished yet; `ONBOARDING_DONE` once it is (plan §4.10.3). */
async function requireOpen(repos: Repositories, userId: string): Promise<OnboardingProgress> {
  const progress = await repos.userSettings.onboarding(userId);
  if (progress === null) {
    throw new AppError('SESSION_EXPIRED');
  }
  if (progress.completed) {
    throw new AppError('ONBOARDING_DONE');
  }
  return progress;
}

/**
 * Applies the transition, which only happens from its step and before the end (plan §4.10.3).
 * Otherwise `ONBOARDING_DONE`, or `STEP_MISMATCH` with the pending step.
 */
async function advance(
  repos: Repositories,
  userId: string,
  transition: OnboardingTransition,
): Promise<OnboardingProgress> {
  const progress = await repos.userSettings.advanceOnboarding(userId, transition);
  if (progress !== null) {
    return progress;
  }
  const current = await requireOpen(repos, userId);
  throw new AppError('STEP_MISMATCH', { currentStep: current.step });
}

/**
 * The Onboarding must wait in `step`; otherwise `ONBOARDING_DONE`, or `STEP_MISMATCH` with the
 * pending step (plan §4.10.3). Checked before any write, so a resent or early step creates nothing.
 */
async function requireStep(
  repos: Repositories,
  userId: string,
  step: OnboardingStep,
): Promise<void> {
  const current = await requireOpen(repos, userId);
  if (current.step !== step) {
    throw new AppError('STEP_MISMATCH', { currentStep: current.step });
  }
}

/**
 * A unit of work that joins the transaction already open instead of opening another one: its runs
 * reuse those repositories, bound to the user whose lock the transaction holds (plan §1.4).
 */
function joinedTo(repos: Repositories, userId: string): UnitOfWork {
  return {
    run<T>(fn: (joined: Repositories) => Promise<T>, opts: UnitOfWorkOptions = {}): Promise<T> {
      // The repositories are scoped to `userId`: a run for anyone else cannot reuse them.
      if (opts.userLock !== userId) {
        return Promise.reject(new AppError('INTERNAL_ERROR'));
      }
      return fn(repos);
    },
  };
}

/**
 * The `AccountsService` of an open transaction. `create` opens its own run, so over this unit of
 * work the accounts of step 2 commit or roll back with the move to step 3. Creating an account
 * moves no ledger entry, so no ledger hook runs.
 */
function accountsWithin(repos: Repositories, userId: string): AccountsService {
  const joined = joinedTo(repos, userId);
  return createAccountsService({
    uow: joined,
    rates: createRatesService({ uow: joined }),
    ledgerHooks: createLedgerHooks(),
  });
}

/** The transition that skips step `from`: skipping step 1 leaves BOB as the base (RF-M10-02). */
function skipping(from: OnboardingStep, to: OnboardingTransition['to']): OnboardingTransition {
  return from === 1 ? { from, to, baseCurrency: DEFAULT_BASE } : { from, to };
}

/**
 * The Onboarding of a user (plan §4.10). Its progress lives in `user_settings`, so it resumes
 * on any device (RF-M10-01); every transition runs under the user's lock.
 */
export function createOnboardingService({
  uow,
  rates,
}: {
  uow: UnitOfWork;
  rates: RatesService;
}): OnboardingService {
  return {
    async get(ctx) {
      const { progress, expense, income } = await uow.run(
        async (repos) => {
          const open = await requireOpen(repos, ctx.userId);
          return {
            progress: open,
            expense: await repos.categories.tree('expense', 'active'),
            income: await repos.categories.tree('income', 'active'),
          };
        },
        { userLock: ctx.userId, readOnly: true },
      );
      const { inUse } = await rates.current(ctx);
      return {
        step: progress.step,
        completed: progress.completed,
        presets: { accounts: [...ACCOUNT_PRESETS], categories: [...expense, ...income] },
        rate: inUse.value === null ? null : inUse,
      };
    },

    async step1(ctx, input) {
      return uow.run(
        (repos) => advance(repos, ctx.userId, { from: 1, to: 2, baseCurrency: input.baseCurrency }),
        { userLock: ctx.userId },
      );
    },

    async step2(ctx, input) {
      // The balances are dated the user's local day (RN-07).
      const today = todayFor(ctx.timezone, ctx.now);
      return uow.run(
        async (repos) => {
          await requireStep(repos, ctx.userId, 2);
          const accounts = accountsWithin(repos, ctx.userId);
          for (const account of input.accounts) {
            await accounts.create(ctx, {
              id: account.id,
              type: account.type,
              name: account.name,
              currencyCode: account.currencyCode,
              initialBalance: account.balance,
              initialBalanceDate: today,
              color: ACCOUNT_COLOR,
              icon: ACCOUNT_ICON[account.type],
            });
          }
          return advance(repos, ctx.userId, { from: 2, to: 3 });
        },
        { userLock: ctx.userId },
      );
    },

    async skip(ctx, input) {
      return uow.run(
        (repos) => advance(repos, ctx.userId, skipping(input.step, NEXT[input.step])),
        { userLock: ctx.userId },
      );
    },

    async skipAll(ctx) {
      return uow.run(
        async (repos) => {
          const { step } = await requireOpen(repos, ctx.userId);
          return advance(repos, ctx.userId, skipping(step, 'done'));
        },
        { userLock: ctx.userId },
      );
    },
  };
}
