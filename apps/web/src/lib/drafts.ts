import { useCallback, useEffect, useRef, useState } from 'react';
import type { FieldValues, Path, PathValue, UseFormReturn } from 'react-hook-form';
import type { ZodType } from 'zod';

export type DraftIssues<V> = Partial<Record<keyof V, 'reselect'>>;

export interface LoadDraftOptions<V> {
  schema: ZodType<V>;
  validateRefs?: (value: V) => DraftIssues<V>;
}

export interface RestoredDraft<V> {
  value: Partial<V>;
  issues: DraftIssues<V>;
}

export interface Drafts {
  save: (userId: string, formKey: string, value: unknown) => void;
  load: <V extends object>(userId: string, formKey: string, opts: LoadDraftOptions<V>) => RestoredDraft<V> | null;
  clear: (userId: string, formKey: string) => void;
  clearAll: (userId: string) => void;
}

export interface CreateDraftsOptions {
  storage: Storage;
}

const DRAFT_PREFIX = 'draft:';
const SAVE_DELAY_MS = 300;

function userPrefix(userId: string): string {
  return `${DRAFT_PREFIX}${userId}:`;
}

function draftKey(userId: string, formKey: string): string {
  return `${userPrefix(userId)}${formKey}`;
}

function parse(raw: string): { ok: true; data: unknown } | { ok: false } {
  try {
    return { ok: true, data: JSON.parse(raw) as unknown };
  } catch {
    return { ok: false };
  }
}

// ADR-17, plan §4.2.3: drafts live in a Storage under draft:{userId}:{formKey}.
export function createDrafts({ storage }: CreateDraftsOptions): Drafts {
  function save(userId: string, formKey: string, value: unknown): void {
    storage.setItem(draftKey(userId, formKey), JSON.stringify(value));
  }

  function clear(userId: string, formKey: string): void {
    storage.removeItem(draftKey(userId, formKey));
  }

  // RF-M2-10, RF-M2-11: an invalid draft is discarded; inactive references are emptied and flagged.
  function load<V extends object>(
    userId: string,
    formKey: string,
    { schema, validateRefs }: LoadDraftOptions<V>,
  ): RestoredDraft<V> | null {
    const raw = storage.getItem(draftKey(userId, formKey));
    if (raw === null) return null;

    const parsed = parse(raw);
    const result = parsed.ok ? schema.safeParse(parsed.data) : null;
    if (result === null || !result.success) {
      clear(userId, formKey);
      return null;
    }

    const value: Partial<V> = { ...result.data };
    const issues: DraftIssues<V> = {};
    const refs: DraftIssues<V> = validateRefs ? validateRefs(result.data) : {};
    for (const field of Object.keys(refs) as (keyof V)[]) {
      if (refs[field] === 'reselect') {
        Reflect.deleteProperty(value, field);
        issues[field] = 'reselect';
      }
    }
    return { value, issues };
  }

  // EC-M2-01, RF-M7-08: only the given user's drafts are removed.
  function clearAll(userId: string): void {
    const prefix = userPrefix(userId);
    const keys: string[] = [];
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key?.startsWith(prefix)) keys.push(key);
    }
    for (const key of keys) storage.removeItem(key);
  }

  return { save, load, clear, clearAll };
}

function sessionDrafts(): Drafts {
  return createDrafts({ storage: globalThis.sessionStorage });
}

export function saveDraft(userId: string, formKey: string, value: unknown): void {
  sessionDrafts().save(userId, formKey, value);
}

export function loadDraft<V extends object>(
  userId: string,
  formKey: string,
  opts: LoadDraftOptions<V>,
): RestoredDraft<V> | null {
  return sessionDrafts().load(userId, formKey, opts);
}

export function clearDraft(userId: string, formKey: string): void {
  sessionDrafts().clear(userId, formKey);
}

export function clearAllDrafts(userId: string): void {
  sessionDrafts().clearAll(userId);
}

export interface UseDraftOptions<T extends FieldValues> {
  userId: string;
  schema: ZodType<Partial<T>>;
  validateRefs?: (value: Partial<T>) => DraftIssues<T>;
}

export interface UseDraft {
  clear: () => void;
  restoredWithIssues: boolean;
}

// Plan §4.2.3: restores the draft on mount and saves it 300 ms after the last change.
export function useDraft<T extends FieldValues>(
  formKey: string,
  form: UseFormReturn<T>,
  opts: UseDraftOptions<T>,
): UseDraft {
  const { userId } = opts;
  const [restoredWithIssues, setRestoredWithIssues] = useState(false);
  const optsRef = useRef(opts);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    optsRef.current = opts;
  });

  useEffect(() => {
    const { schema, validateRefs } = optsRef.current;
    const restored = loadDraft<Partial<T>>(userId, formKey, { schema, validateRefs });
    if (restored === null) return;
    for (const [field, fieldValue] of Object.entries(restored.value)) {
      form.setValue(field as Path<T>, fieldValue as PathValue<T, Path<T>>, { shouldDirty: true });
    }
    setRestoredWithIssues(Object.keys(restored.issues).length > 0);
  }, [userId, formKey, form]);

  useEffect(() => {
    const subscription = form.watch((values) => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        saveDraft(userId, formKey, values);
      }, SAVE_DELAY_MS);
    });
    return () => {
      subscription.unsubscribe();
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [userId, formKey, form]);

  const clear = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    clearDraft(userId, formKey);
    setRestoredWithIssues(false);
  }, [userId, formKey]);

  return { clear, restoredWithIssues };
}
