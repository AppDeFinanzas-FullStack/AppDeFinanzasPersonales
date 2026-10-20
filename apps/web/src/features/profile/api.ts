import { ChangePwdInput, MeDto, UpdateMeInput } from '@finanzas/contracts';
import { z } from 'zod';

import type { Endpoint } from '@/lib/api-client';

export const updateMeEndpoint: Endpoint<UpdateMeInput, MeDto> = {
  method: 'PATCH',
  path: '/api/me',
  input: UpdateMeInput,
  output: MeDto,
};

export const changePasswordEndpoint: Endpoint<ChangePwdInput, void> = {
  method: 'POST',
  path: '/api/auth/password/change',
  input: ChangePwdInput,
  output: z.void(),
};

export const signOutEndpoint: Endpoint<undefined, void> = {
  method: 'POST',
  path: '/api/auth/sign-out',
  input: z.undefined(),
  output: z.void(),
};

export const signOutAllEndpoint: Endpoint<undefined, void> = {
  method: 'POST',
  path: '/api/auth/sign-out-all',
  input: z.undefined(),
  output: z.void(),
};
