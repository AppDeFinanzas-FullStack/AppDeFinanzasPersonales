import {
  ConfirmDto,
  ConfirmInput,
  ConfirmationStatusDto,
  MeDto,
  ResendInput,
  SignUpInput,
} from '@finanzas/contracts';
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

/** RF-M1-18: the link only confirms the account; it does not open a session. */
export const confirmEndpoint: Endpoint<ConfirmInput, ConfirmDto> = {
  method: 'POST',
  path: '/api/auth/confirm',
  input: ConfirmInput,
  output: ConfirmDto,
};

/** RF-M1-18: the app waiting on "Revisa tu correo" asks whether the account was confirmed. */
export const confirmationStatusEndpoint: Endpoint<void, ConfirmationStatusDto> = {
  method: 'POST',
  path: '/api/auth/confirmation/status',
  input: z.void(),
  output: ConfirmationStatusDto,
};

export const meEndpoint: Endpoint<void, MeDto> = {
  method: 'GET',
  path: '/api/me',
  input: z.void(),
  output: MeDto,
};
