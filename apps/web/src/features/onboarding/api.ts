import {
  OnboardingDto,
  OnboardingStep,
  SkipInput,
  Step1Input,
  Step2Input,
  Step3Input,
} from '@finanzas/contracts';
import { z } from 'zod';

import type { Endpoint } from '@/lib/api-client';

/** Where the Onboarding is after a step, the same shape as `MeDto['onboarding']` (plan §4.10.2). */
export const OnboardingProgress = z.object({ step: OnboardingStep, completed: z.boolean() });
export type OnboardingProgress = z.infer<typeof OnboardingProgress>;

export const getOnboardingEndpoint: Endpoint<undefined, OnboardingDto> = {
  method: 'GET',
  path: '/api/onboarding',
  input: z.undefined(),
  output: OnboardingDto,
};

export const step1Endpoint: Endpoint<Step1Input, OnboardingProgress> = {
  method: 'POST',
  path: '/api/onboarding/step1',
  input: Step1Input,
  output: OnboardingProgress,
};

export const step2Endpoint: Endpoint<Step2Input, OnboardingProgress> = {
  method: 'POST',
  path: '/api/onboarding/step2',
  input: Step2Input,
  output: OnboardingProgress,
};

export const step3Endpoint: Endpoint<Step3Input, OnboardingProgress> = {
  method: 'POST',
  path: '/api/onboarding/step3',
  input: Step3Input,
  output: OnboardingProgress,
};

export const skipEndpoint: Endpoint<SkipInput, OnboardingProgress> = {
  method: 'POST',
  path: '/api/onboarding/skip',
  input: SkipInput,
  output: OnboardingProgress,
};

export const skipAllEndpoint: Endpoint<undefined, OnboardingProgress> = {
  method: 'POST',
  path: '/api/onboarding/skip-all',
  input: z.undefined(),
  output: OnboardingProgress,
};
