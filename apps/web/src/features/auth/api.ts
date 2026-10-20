import { ConfirmInput, MeDto, ResendInput, SignUpInput } from '@finanzas/contracts';
import { z } from 'zod';

import type { Endpoint } from '@/lib/api-client';

export const signUpEndpoint: Endpoint<SignUpInput, { status: 'check_email' }> = {
  method: 'POST',
  path: '/api/auth/sign-up',
  input: SignUpInput,
  output: z.object({ status: z.literal('check_email') }),
};

export const resendConfirmationEndpoint: Endpoint<ResendInput, void> = {
  method: 'POST',
  path: '/api/auth/confirmation/resend',
  input: ResendInput,
  output: z.void(),
};

export const confirmEndpoint: Endpoint<ConfirmInput, { next: 'onboarding' }> = {
  method: 'POST',
  path: '/api/auth/confirm',
  input: ConfirmInput,
  output: z.object({ next: z.literal('onboarding') }),
};

export const meEndpoint: Endpoint<void, MeDto> = {
  method: 'GET',
  path: '/api/me',
  input: z.void(),
  output: MeDto,
};
