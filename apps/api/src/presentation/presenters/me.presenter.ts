import type { MeDto } from '@finanzas/contracts';

/** The profile of the user behind a session, as the API reads it. */
export interface MeProfile {
  id: string;
  name: string;
  email: string;
  timezone: string;
  onboardingStep: number;
  onboardingCompleted: boolean;
}

export type Release = MeDto['release'];

/** Builds the `MeDto` of the contracts (plan §4.1.1). */
export const MePresenter = {
  toDto(profile: MeProfile, release: Release): MeDto {
    return {
      id: profile.id,
      name: profile.name,
      email: profile.email,
      timezone: profile.timezone,
      locale: 'es-BO',
      release,
      onboarding: { step: profile.onboardingStep, completed: profile.onboardingCompleted },
    };
  },
};
