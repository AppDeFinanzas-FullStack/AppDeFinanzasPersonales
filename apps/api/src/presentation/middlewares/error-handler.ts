import { randomUUID } from 'node:crypto';

import type { ErrorRequestHandler, Response } from 'express';

import { AppError } from '../../application/errors.js';

const traceIdOf = (res: Response): string => {
  const existing: unknown = res.locals['traceId'];
  return typeof existing === 'string' && existing.length > 0 ? existing : randomUUID();
};

export const sendProblem = (
  res: Response,
  status: number,
  code: string,
  data?: Record<string, unknown>,
): void => {
  const body: Record<string, unknown> = {
    type: `/problems/${code}`,
    title: code,
    status,
    code,
    traceId: traceIdOf(res),
  };
  if (data !== undefined) {
    body['data'] = data;
  }
  res.status(status).type('application/problem+json').send(JSON.stringify(body));
};

const BODY_PARSER_ERROR_PREFIXES = ['entity.', 'charset.', 'encoding.', 'request.', 'stream.'];

const isMalformedBody = (err: unknown): boolean => {
  if (typeof err !== 'object' || err === null) {
    return false;
  }
  const type: unknown = (err as { type?: unknown }).type;
  return (
    typeof type === 'string' && BODY_PARSER_ERROR_PREFIXES.some((prefix) => type.startsWith(prefix))
  );
};

export const errorHandler: ErrorRequestHandler = (err: unknown, _req, res, next) => {
  if (res.headersSent) {
    next(err);
    return;
  }
  if (err instanceof AppError) {
    sendProblem(res, err.status, err.code, err.data);
    return;
  }
  if (isMalformedBody(err)) {
    sendProblem(res, 400, 'VALIDATION_ERROR');
    return;
  }
  const traceId = traceIdOf(res);
  res.locals['traceId'] = traceId;
  console.error(JSON.stringify({ traceId, code: 'INTERNAL_ERROR' }));
  sendProblem(res, 500, 'INTERNAL_ERROR');
};
