import type { Request, RequestHandler } from 'express';

import { sendProblem } from './error-handler.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** A declared length of zero, or an empty one, announces no body. */
const ZERO_LENGTH = /^\s*0*\s*$/;

/**
 * A request carries a body when it declares a chunked transfer or a length other than zero
 * (RFC 9112 §6.3). A `POST` without a body, such as a currency deactivation, sends
 * `Content-Length: 0`.
 */
const hasBody = (req: Request): boolean => {
  if (req.headers['transfer-encoding'] !== undefined) {
    return true;
  }
  const length = req.headers['content-length'];
  return length !== undefined && !ZERO_LENGTH.test(length);
};

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
