import { RatesCurrentDto } from '@finanzas/contracts';
import { z } from 'zod';

import type { Endpoint } from '@/lib/api-client';

export const getCurrentRatesEndpoint: Endpoint<undefined, RatesCurrentDto> = {
  method: 'GET',
  path: '/api/rates/current',
  input: z.undefined(),
  output: RatesCurrentDto,
};
