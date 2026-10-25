import type { Readable } from 'node:stream';

import { isReleased, type ModuleKey, type Release } from '@finanzas/contracts';

import { AppError } from '../errors.js';
import type { ExportRepository, ExportTable } from '../ports/repositories.js';
import type { UnitOfWork } from '../ports/unit-of-work.js';

/** A CSV of the export: its file name and its rows, the header first. */
export interface ExportFile {
  name: string;
  rows: string[][];
}

/** Packs the files into a ZIP archive that is streamed as they are produced. */
export type ExportArchiver = (files: AsyncIterable<ExportFile>) => Readable;

/**
 * The tables of the V1.1 modules that the export repository also reads, always filtered by the
 * user of the transaction (RN-09): budgets (M11), goals (M12), debts (M13) and notifications (M15).
 */
export interface ReleaseExportRepository extends ExportRepository {
  budgets(): Promise<ExportTable>;
  budgetPeriods(): Promise<ExportTable>;
  /** Archived goals included (RF-M1-14). */
  goals(): Promise<ExportTable>;
  /** Earmarks (positive amounts) and withdrawals (negative amounts) of every goal. */
  goalAllocations(): Promise<ExportTable>;
  debts(): Promise<ExportTable>;
  debtPayments(): Promise<ExportTable>;
  notifications(): Promise<ExportTable>;
}

const isReleaseExportRepository = (repo: ExportRepository): repo is ReleaseExportRepository =>
  'budgets' in repo &&
  'budgetPeriods' in repo &&
  'goals' in repo &&
  'goalAllocations' in repo &&
  'debts' in repo &&
  'debtPayments' in repo &&
  'notifications' in repo;

/** The repository with the V1.1 tables; a wiring without them is an internal fault. */
function releaseTables(repo: ExportRepository): ReleaseExportRepository {
  if (!isReleaseExportRepository(repo)) throw new AppError('INTERNAL_ERROR');
  return repo;
}

/** The exporter of one type of data, owned by the module that releases it (ADR-18). */
interface Exporter {
  file: string;
  module: ModuleKey;
  read: (repo: ExportRepository) => Promise<ExportTable>;
}

/**
 * Registry of the exporters, one CSV per type of data. Each module of a later release adds its
 * own here; an exporter of a module that is not released does not run (RF-M1-14).
 */
const EXPORTERS: readonly Exporter[] = [
  { file: 'profile.csv', module: 'M1', read: (repo) => repo.profile() },
  { file: 'settings.csv', module: 'M9', read: (repo) => repo.settings() },
  { file: 'favorite_categories.csv', module: 'M9', read: (repo) => repo.favoriteCategories() },
  { file: 'currencies.csv', module: 'M3', read: (repo) => repo.currencies() },
  { file: 'exchange_rate_events.csv', module: 'M3', read: (repo) => repo.fxEvents() },
  { file: 'accounts.csv', module: 'M4', read: (repo) => repo.accounts() },
  { file: 'categories.csv', module: 'M5', read: (repo) => repo.categories() },
  { file: 'transactions.csv', module: 'M6', read: (repo) => repo.transactions() },
  { file: 'entries.csv', module: 'M6', read: (repo) => repo.entries() },
  { file: 'shortcuts.csv', module: 'M7', read: (repo) => repo.shortcuts() },
  { file: 'budgets.csv', module: 'M11', read: (repo) => releaseTables(repo).budgets() },
  {
    file: 'budget_periods.csv',
    module: 'M11',
    read: (repo) => releaseTables(repo).budgetPeriods(),
  },
  { file: 'goals.csv', module: 'M12', read: (repo) => releaseTables(repo).goals() },
  {
    file: 'goal_allocations.csv',
    module: 'M12',
    read: (repo) => releaseTables(repo).goalAllocations(),
  },
  { file: 'debts.csv', module: 'M13', read: (repo) => releaseTables(repo).debts() },
  { file: 'debt_payments.csv', module: 'M13', read: (repo) => releaseTables(repo).debtPayments() },
  {
    file: 'notifications.csv',
    module: 'M15',
    read: (repo) => releaseTables(repo).notifications(),
  },
];

export interface ExportService {
  /**
   * The ZIP with every datum of the user, archived ones included, generated now and streamed
   * (RNF-16, RF-M1-14). Only the user's own rows go in (RN-09).
   */
  export(userId: string): Readable;
}

export interface ExportServiceDeps {
  uow: UnitOfWork;
  release: Release;
  archive: ExportArchiver;
}

export function createExportService({ uow, release, archive }: ExportServiceDeps): ExportService {
  const exporters = EXPORTERS.filter((exporter) => isReleased(exporter.module, release));

  /** Reads one table at a time, so the archive receives each CSV as soon as it is ready. */
  async function* files(userId: string): AsyncGenerator<ExportFile> {
    for (const exporter of exporters) {
      const table = await uow.run((repos) => exporter.read(repos.exports), {
        userLock: userId,
        readOnly: true,
      });
      yield { name: exporter.file, rows: [table.columns, ...table.rows] };
    }
  }

  return {
    export(userId) {
      return archive(files(userId));
    },
  };
}
