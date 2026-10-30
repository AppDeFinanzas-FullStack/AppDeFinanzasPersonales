import type { Repositories } from './repositories.js';

export interface UnitOfWorkOptions {
  /**
   * User the run is scoped to: the repositories only see that user's rows (RNF-14). A run that
   * writes also takes that user's exclusive advisory lock, so two writes of one user queue (RNF-10).
   */
  userLock?: string;
  /**
   * Read-only run. It runs in `REPEATABLE READ` and `READ ONLY`: all its statements see a single
   * snapshot of the database (RNF-29) and none can write. It never takes the advisory lock, with or
   * without `userLock`, so it does not wait for a write of the same user nor makes one wait.
   */
  readOnly?: boolean;
}

export interface UnitOfWork {
  run<T>(fn: (repos: Repositories) => Promise<T>, opts?: UnitOfWorkOptions): Promise<T>;
}
