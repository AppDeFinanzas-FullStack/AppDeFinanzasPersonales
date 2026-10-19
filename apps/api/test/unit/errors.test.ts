import { ErrorCode } from '@finanzas/contracts';
import { describe, expect, it } from 'vitest';

import { AppError } from '../../src/application/errors.js';

describe('AppError', () => {
  it('TASK-031 AppError expone code, status y data', () => {
    const data = { accountId: 'a1', resultingBalance: '-5.00' };
    const err = new AppError('NEGATIVE_BALANCE', data);
    expect(err.code).toBe('NEGATIVE_BALANCE');
    expect(err.status).toBe(422);
    expect(err.data).toEqual(data);
  });

  it('TASK-031 AppError es una instancia de Error', () => {
    const err = new AppError('NOT_FOUND');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(AppError);
  });

  it('TASK-031 AppError sin data no lanza y conserva code y status', () => {
    const err = new AppError('SESSION_EXPIRED');
    expect(err.code).toBe('SESSION_EXPIRED');
    expect(err.status).toBe(401);
    expect(err.data === undefined || Object.keys(err.data as object).length === 0).toBe(true);
  });

  it('TASK-031 el status sale del catálogo ErrorCode para cada código común', () => {
    const common = [
      'VALIDATION_ERROR',
      'SESSION_EXPIRED',
      'NOT_FOUND',
      'IDEMPOTENCY_CONFLICT',
      'LIMIT_REACHED',
      'RELEASE_NOT_AVAILABLE',
      'INTERNAL_ERROR',
    ] as const;
    for (const code of common) {
      expect(new AppError(code).status).toBe(ErrorCode[code]);
    }
    expect(new AppError('VALIDATION_ERROR').status).toBe(400);
    expect(new AppError('LIMIT_REACHED').status).toBe(409);
    expect(new AppError('INTERNAL_ERROR').status).toBe(500);
  });

  it('TASK-031 el status de cualquier ErrorCode coincide con el catálogo', () => {
    for (const [code, status] of Object.entries(ErrorCode)) {
      expect(new AppError(code as keyof typeof ErrorCode).status).toBe(status);
    }
  });
});
