import type { RequestHandler } from 'express';

import { sendProblem } from './error-handler.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export const requireJson: RequestHandler = (req, res, next) => {
  if (SAFE_METHODS.has(req.method) || req.is('application/json')) {
    next();
    return;
  }
  sendProblem(res, 415, 'UNSUPPORTED_MEDIA_TYPE');
};
