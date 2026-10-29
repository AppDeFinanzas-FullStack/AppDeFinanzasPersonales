import type { MeDto } from '@finanzas/contracts';

/**
 * What the last successful `/api/me` of this device said that is enough to start asking for the
 * data of the Inicio before the session answers: the time zone (to know the month) and whether
 * the Onboarding is done. Never the email, the name or the id (RF-M1-04).
 */
export interface LastSessionHint {
  timezone: string;
  onboardingCompleted: boolean;
}

const HINT_KEY = 'session:lastHint';

function isTimeZone(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** Keeps the hint of the session just confirmed. A blocked or full storage is ignored. */
export function saveLastSessionHint(me: Pick<MeDto, 'timezone' | 'onboarding'>): void {
  try {
    const hint: LastSessionHint = {
      timezone: me.timezone,
      onboardingCompleted: me.onboarding.completed,
    };
    localStorage.setItem(HINT_KEY, JSON.stringify(hint));
  } catch {
    // The hint only speeds up the start: without it the start is the one without a hint.
  }
}

/** The hint of the last session, or `null` when there is none, it is malformed or unreadable. */
export function readLastSessionHint(): LastSessionHint | null {
  try {
    const raw = localStorage.getItem(HINT_KEY);
    if (raw === null) return null;
    const value: unknown = JSON.parse(raw);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
    const { timezone, onboardingCompleted } = value as Record<string, unknown>;
    if (!isTimeZone(timezone) || typeof onboardingCompleted !== 'boolean') return null;
    return { timezone, onboardingCompleted };
  } catch {
    return null;
  }
}

/** Forgets the hint: the session was closed or the server no longer recognizes it. */
export function clearLastSessionHint(): void {
  try {
    localStorage.removeItem(HINT_KEY);
  } catch {
    // Nothing to forget if the storage cannot be reached.
  }
}
