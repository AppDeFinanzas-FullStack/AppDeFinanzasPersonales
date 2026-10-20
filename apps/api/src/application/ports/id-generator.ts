export interface IdGenerator {
  /** Returns a new UUID v7. */
  next(): string;
}
