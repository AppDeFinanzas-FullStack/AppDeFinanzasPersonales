import type { RequestHandler } from 'express';
import type { ZodType } from 'zod';

import { AppError } from '../../application/errors.js';

export const validate =
  (schema: ZodType): RequestHandler =>
  (req, _res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      const issues = result.error.issues.map((issue) => ({
        path: issue.path.map(String).join('.'),
        code: issue.code,
      }));
      next(new AppError('VALIDATION_ERROR', { issues }));
      return;
    }
    req.body = result.data;
    next();
  };
