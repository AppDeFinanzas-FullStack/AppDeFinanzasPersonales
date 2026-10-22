import type { AccountPreset, RatesCurrentDto, SkipInput, Step1Input } from '@finanzas/contracts';

import { AppError } from '../errors.js';
import type {
  CategoryTreeNode,
  OnboardingProgress,
  OnboardingStep,
  OnboardingTransition,
  Repositories,
} from '../ports/repositories.js';
import type { UnitOfWork } from '../ports/unit-of-work.js';
import type { RatesContext, RatesService } from './rates.service.js';

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
