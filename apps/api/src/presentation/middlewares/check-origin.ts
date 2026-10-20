import type { RequestHandler } from 'express';

import { sendProblem } from './error-handler.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export const checkOrigin =
  (webOrigin: string): RequestHandler =>
  (req, res, next) => {
    const origin = req.get('Origin');
    if (SAFE_METHODS.has(req.method) || origin === undefined || origin === webOrigin) {
      next();
      return;
    }
    sendProblem(res, 403, 'ORIGIN_NOT_ALLOWED');
  };
