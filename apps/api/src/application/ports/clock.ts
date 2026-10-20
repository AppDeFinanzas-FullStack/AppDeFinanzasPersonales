export type Instant = Date;

/** Calendar date in the user's timezone, formatted as YYYY-MM-DD. */
export type LocalDate = string;

export interface Clock {
  now(): Instant;
  todayFor(timezone: string): LocalDate;
}
