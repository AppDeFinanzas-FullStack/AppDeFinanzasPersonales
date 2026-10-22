import type { MeDto, OnboardingDto } from '@finanzas/contracts';

import type { OnboardingProgress } from '../../application/ports/repositories.js';
import type { OnboardingState } from '../../application/services/onboarding.service.js';
import { CategoriesPresenter } from './categories.presenter.js';

/** Where the Onboarding is after a step, the same shape as `MeDto['onboarding']`. */
export type OnboardingProgressDto = MeDto['onboarding'];

/** Builds the answers of `/api/onboarding` (plan §4.10.1); rates travel as decimal text (ADR-03). */
export const OnboardingPresenter = {
  toDto(state: OnboardingState): OnboardingDto {
    return {
      step: state.step,
      completed: state.completed,
      presets: {
        accounts: state.presets.accounts.map((preset) => ({ ...preset })),
        categories: CategoriesPresenter.tree(state.presets.categories),
      },
      rate: state.rate,
    };
  },

  progress(progress: OnboardingProgress): OnboardingProgressDto {
    return { step: progress.step, completed: progress.completed };
  },
};
