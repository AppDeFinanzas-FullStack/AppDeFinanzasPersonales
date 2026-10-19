import { ErrorCode, type ErrorCodeName } from '@finanzas/contracts';

import { i18n } from '@/app/providers/i18n';

export interface ApiErrorLike {
  code: string;
  data?: Record<string, unknown>;
}

function isKnownCode(code: string): code is ErrorCodeName {
  return Object.hasOwn(ErrorCode, code);
}

// RNF-07/RNF-17: the text comes from errors.json with `data` as parameters;
// an unknown code shows the generic text, never the code, data or traceId.
export function messageForError(error: ApiErrorLike): string {
  if (!isKnownCode(error.code)) return i18n.t('genericError', { ns: 'common' });
  return i18n.t(error.code, { ns: 'errors', replace: error.data ?? {} });
}
