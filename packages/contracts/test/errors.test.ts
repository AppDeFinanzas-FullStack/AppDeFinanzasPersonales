import { describe, expect, it } from 'vitest';

import { ErrorCode, ProblemSchema } from '../src/index.js';

const TABLE: ReadonlyArray<readonly [string, number]> = [
  ['ACCOUNT_ALREADY_DEDICATED', 409],
  ['ACCOUNT_ARCHIVED', 409],
  ['ACCOUNT_DEDICATED', 409],
  ['ACCOUNT_HAS_EARMARKS', 409],
  ['ACCOUNT_HAS_MOVEMENTS', 409],
  ['ACCOUNT_HAS_OTHER_EARMARKS', 409],
  ['ACCOUNT_NOT_DEDICABLE', 422],
  ['ALREADY_DECIDED', 409],
  ['AMOUNT_OUT_OF_RANGE', 422],
  ['AMOUNT_REQUIRED_FOR_AUTO', 422],
  ['ARCHIVE_CONFIRMATION_REQUIRED', 409],
  ['BASE_CURRENCY', 422],
  ['BUDGET_EXISTS', 409],
  ['CATEGORY_ARCHIVED', 409],
  ['CATEGORY_HAS_MOVEMENTS', 409],
  ['CATEGORY_IN_USE', 409],
  ['CATEGORY_KIND_MISMATCH', 422],
  ['CATEGORY_NOT_BUDGETABLE', 422],
  ['CATEGORY_NOT_FOUND', 404],
  ['CONFIRMATION_MISMATCH', 422],
  ['CURRENCY_CODE_TAKEN', 409],
  ['CURRENCY_IMMUTABLE', 422],
  ['CURRENCY_IN_USE', 409],
  ['CURRENCY_INACTIVE', 422],
  ['CURRENCY_LOCKED', 409],
  ['DATE_NOT_SKIPPED', 422],
  ['DEBT_CLOSED', 409],
  ['DEBT_FORGIVEN', 409],
  ['DECISION_ALREADY_MADE', 409],
  ['EARMARK_CONFIRMATION_REQUIRED', 409],
  ['EARMARK_EXCEEDS_FREE', 422],
  ['EMAIL_NOT_CONFIRMED', 403],
  ['FEE_CATEGORY_REQUIRED', 422],
  ['FIELD_LOCKED', 422],
  ['FUTURE_DATE', 422],
  ['GOAL_NOT_AVAILABLE', 409],
  ['GOAL_NOT_EMPTY', 409],
  ['HIERARCHY_INVALID', 422],
  ['IDEMPOTENCY_CONFLICT', 409],
  ['IMMUTABLE_FIELD', 422],
  ['INTERNAL_ERROR', 500],
  ['INVALID_CREDENTIALS', 401],
  ['INVALID_CURRENT_PASSWORD', 401],
  ['INVALID_PASSWORD', 401],
  ['INVALID_STATE', 409],
  ['LIMIT_REACHED', 409],
  ['LINK_ALREADY_USED', 409],
  ['LINK_INVALID', 410],
  ['LINKED_DELETE_FORBIDDEN', 422],
  ['LINKED_FIELD_LOCKED', 422],
  ['LOGIN_LOCKED', 429],
  ['MERGE_INVALID', 422],
  ['MERGE_PENDING_CLOSE', 409],
  ['MIXED_KINDS', 422],
  ['MOVEMENTS_CHOICE_REQUIRED', 409],
  ['NAME_TAKEN', 409],
  ['NEGATIVE_BALANCE', 422],
  ['NOT_FOUND', 404],
  ['NOT_LAST_PAYMENT', 409],
  ['ONBOARDING_DONE', 409],
  ['ORIGIN_NOT_ALLOWED', 403],
  ['PARENT_ARCHIVED', 409],
  ['PAYMENT_EXCEEDS_BALANCE', 422],
  ['PRINCIPAL_BELOW_PAID', 422],
  ['RATE_BELOW_MINIMUM', 422],
  ['RATE_REQUIRED', 409],
  ['RELEASE_EXCEEDS_EARMARK', 422],
  ['RELEASE_NOT_AVAILABLE', 404],
  ['SESSION_EXPIRED', 401],
  ['SPLIT_INVALID', 422],
  ['SPLIT_MISMATCH', 422],
  ['START_DATE_IN_PAST', 422],
  ['STEP_MISMATCH', 409],
  ['SYSTEM_CATEGORY', 422],
  ['SYSTEM_CURRENCY', 422],
  ['TARGET_DATE_IN_PAST', 422],
  ['TO_GOAL_NOT_ALLOWED', 422],
  ['TYPE_CHANGE_INVALID', 422],
  ['UNDO_EXPIRED', 410],
  ['UNSUPPORTED_MEDIA_TYPE', 415],
  ['VALIDATION_ERROR', 400],
];

const codes = ErrorCode as Record<string, number>;

const problem = (code: string, status: number, extra: Record<string, unknown> = {}) => ({
  type: `https://errors.app/${code}`,
  title: code,
  status,
  code,
  traceId: 'trace-1',
  ...extra,
});

describe('ErrorCode (plan 4.0, ADR-09)', () => {
  it.each(TABLE)('TASK-022 %s tiene estado HTTP %i', (code, status) => {
    expect(codes[code]).toBe(status);
  });

  it('TASK-034 la tabla tiene los 81 códigos del plan', () => {
    expect(TABLE).toHaveLength(81);
  });

  it('TASK-034 UNSUPPORTED_MEDIA_TYPE es 415 y ORIGIN_NOT_ALLOWED es 403', () => {
    expect(codes.UNSUPPORTED_MEDIA_TYPE).toBe(415);
    expect(codes.ORIGIN_NOT_ALLOWED).toBe(403);
  });

  it('TASK-022 el catálogo no tiene códigos fuera de la tabla', () => {
    expect(Object.keys(ErrorCode).sort()).toEqual(TABLE.map(([c]) => c).sort());
  });
});

describe('ProblemSchema (ADR-09)', () => {
  it('TASK-022 acepta un problema con data', () => {
    const p = problem('NEGATIVE_BALANCE', 422, {
      data: { accountId: 'a', resultingBalance: '-5.00' },
    });
    expect(ProblemSchema.safeParse(p).success).toBe(true);
  });

  it('TASK-022 acepta un problema sin data', () => {
    expect(ProblemSchema.safeParse(problem('NOT_FOUND', 404)).success).toBe(true);
  });

  it('TASK-022 rechaza un code desconocido', () => {
    expect(ProblemSchema.safeParse(problem('NOPE_CODE', 400)).success).toBe(false);
  });

  it('TASK-022 rechaza un problema sin traceId', () => {
    const p: Record<string, unknown> = problem('NOT_FOUND', 404);
    delete p.traceId;
    expect(ProblemSchema.safeParse(p).success).toBe(false);
  });

  it('RNF-17 INTERNAL_ERROR no admite data', () => {
    const withData = problem('INTERNAL_ERROR', 500, { data: { stack: 'secret' } });
    expect(ProblemSchema.safeParse(withData).success).toBe(false);
    expect(ProblemSchema.safeParse(problem('INTERNAL_ERROR', 500)).success).toBe(true);
  });
});
