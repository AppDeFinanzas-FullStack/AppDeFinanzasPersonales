import { useCallback, useMemo } from 'react';
import { useSearchParams, type NavigateOptions } from 'react-router';
import type { z } from 'zod';

export type SearchSchema = z.ZodObject<Record<string, z.ZodType>>;

export type SearchValue = string | number | boolean | null | undefined;

export type SetSearch<V> = (next: Partial<V>, options?: NavigateOptions) => void;

// ADR-16: each parameter is validated on its own, so an invalid one falls back to its
// default value while the valid ones are kept.
export function parseSearch<S extends SearchSchema>(schema: S, params: URLSearchParams): z.output<S> {
  const result: Record<string, unknown> = {};

  for (const [key, field] of Object.entries(schema.shape)) {
    const raw = params.get(key) ?? undefined;
    const parsed = field.safeParse(raw);
    if (parsed.success) {
      result[key] = parsed.data;
      continue;
    }
    const fallback = field.safeParse(undefined);
    if (fallback.success) {
      result[key] = fallback.data;
    }
  }

  return result as z.output<S>;
}

// RF-M2-06: keys are written in a stable order so parse and serialize round-trip.
export function serializeSearch(values: Readonly<Record<string, SearchValue>>): string {
  const params = new URLSearchParams();

  for (const [key, value] of Object.entries(values)) {
    if (value === undefined || value === null) {
      continue;
    }
    params.set(key, String(value));
  }

  return params.toString();
}

// RF-M2-04, RF-M2-06: the screen state lives in the URL, so the Back button restores it.
export function useValidatedSearch<S extends SearchSchema>(schema: S): [z.output<S>, SetSearch<z.output<S>>] {
  const [searchParams, setSearchParams] = useSearchParams();

  const values = useMemo(() => parseSearch(schema, searchParams), [schema, searchParams]);

  const setSearch = useCallback<SetSearch<z.output<S>>>(
    (next, options) => {
      setSearchParams(
        (prev) =>
          serializeSearch({
            ...(parseSearch(schema, prev) as Record<string, SearchValue>),
            ...(next as Record<string, SearchValue>),
          }),
        options,
      );
    },
    [schema, setSearchParams],
  );

  return [values, setSearch];
}
