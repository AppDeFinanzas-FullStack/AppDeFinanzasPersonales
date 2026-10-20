import type { Request, RequestHandler } from 'express';

import { sendProblem } from './error-handler.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** A request carries a body when it declares a length or a chunked transfer (RFC 9112 §6.3). */
const hasBody = (req: Request): boolean =>
  req.headers['transfer-encoding'] !== undefined || req.headers['content-length'] !== undefined;

/**
 * Mutations with a body must send JSON (plan §4.0, CSRF). A mutation without a body, such as a
 * `DELETE` from the web client, has nothing to parse and goes through.
 */
export const requireJson: RequestHandler = (req, res, next) => {
  if (SAFE_METHODS.has(req.method) || !hasBody(req) || req.is('application/json')) {
    next();
    return;
  }
  sendProblem(res, 415, 'UNSUPPORTED_MEDIA_TYPE');
};
