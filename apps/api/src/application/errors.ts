import { ErrorCode, type ErrorCodeName } from '@finanzas/contracts';

export class AppError extends Error {
  readonly code: ErrorCodeName;
  readonly status: number;
  readonly data?: Record<string, unknown>;

  constructor(code: ErrorCodeName, data?: Record<string, unknown>) {
    super(code);
    this.name = 'AppError';
    this.code = code;
    this.status = ErrorCode[code];
    if (data !== undefined) {
      this.data = data;
    }
  }
}
