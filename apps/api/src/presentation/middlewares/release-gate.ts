import { isReleased, type ModuleKey, type Release } from '@finanzas/contracts';
import type { RequestHandler } from 'express';

import { AppError } from '../../application/errors.js';

const RELEASES: readonly string[] = ['1.0', '1.1', '1.2'];

export const releaseGate =
  (module: ModuleKey): RequestHandler =>
  (_req, _res, next) => {
    const current = process.env['RELEASE'];
    const released =
      current !== undefined && RELEASES.includes(current) && isReleased(module, current as Release);
    next(released ? undefined : new AppError('RELEASE_NOT_AVAILABLE'));
  };
