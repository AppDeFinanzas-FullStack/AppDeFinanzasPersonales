import type { Repositories } from './repositories.js';

export interface UnitOfWorkOptions {
  userLock?: string;
  readOnly?: boolean;
}

export interface UnitOfWork {
  run<T>(fn: (repos: Repositories) => Promise<T>, opts?: UnitOfWorkOptions): Promise<T>;
}
