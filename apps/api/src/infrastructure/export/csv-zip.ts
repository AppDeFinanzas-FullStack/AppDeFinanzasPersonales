import type { Readable } from 'node:stream';

import { ZipArchive } from 'archiver';

export interface CsvFile {
  name: string;
  rows: readonly (readonly string[])[];
}

const BOM = '﻿';
const LINE_END = '\r\n';
const FORMULA_PREFIX = /^[=+\-@]/;
const NEEDS_QUOTES = /[",\r\n]/;

/** Neutralizes formula-like cells (RF-M1-14) and quotes them per RFC 4180 when needed. */
function formatCell(value: string): string {
  const safe = FORMULA_PREFIX.test(value) ? `'${value}` : value;
  return NEEDS_QUOTES.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

/** UTF-8 CSV with comma separator; the BOM lets spreadsheets detect the encoding. */
export function toCsv(rows: CsvFile['rows']): Buffer {
  const body = rows.map((row) => row.map(formatCell).join(',')).join(LINE_END);
  return Buffer.from(`${BOM}${body}${LINE_END}`, 'utf8');
}

/** Streams a ZIP archive with one CSV entry per file, as files are produced. */
export function createZipStream(files: AsyncIterable<CsvFile>): Readable {
  const archive = new ZipArchive({ zlib: { level: 9 } });

  const fill = async (): Promise<void> => {
    for await (const file of files) {
      archive.append(toCsv(file.rows), { name: file.name });
    }
    await archive.finalize();
  };

  fill().catch((error: unknown) => {
    archive.destroy(error instanceof Error ? error : new Error(String(error)));
  });

  return archive;
}
