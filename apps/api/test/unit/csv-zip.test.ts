import { inflateRawSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

const BOM = String.fromCharCode(0xfeff);

type Row = string[];
interface CsvFile {
  name: string;
  rows: Row[];
}

async function* asFiles(files: CsvFile[]): AsyncIterable<CsvFile> {
  for (const file of files) {
    await Promise.resolve();
    yield file;
  }
}

async function collect(stream: AsyncIterable<unknown>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
  }
  return Buffer.concat(chunks);
}

/** Minimal ZIP reader based on the central directory (stored or deflate entries). */
function unzip(zip: Buffer): Map<string, Buffer> {
  let eocd = -1;
  for (let i = zip.length - 22; i >= 0; i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('not a zip archive');
  const count = zip.readUInt16LE(eocd + 10);
  let offset = zip.readUInt32LE(eocd + 16);
  const entries = new Map<string, Buffer>();
  for (let n = 0; n < count; n++) {
    if (zip.readUInt32LE(offset) !== 0x02014b50) throw new Error('bad central directory');
    const method = zip.readUInt16LE(offset + 10);
    const compressedSize = zip.readUInt32LE(offset + 20);
    const nameLength = zip.readUInt16LE(offset + 28);
    const extraLength = zip.readUInt16LE(offset + 30);
    const commentLength = zip.readUInt16LE(offset + 32);
    const localOffset = zip.readUInt32LE(offset + 42);
    const name = zip.toString('utf8', offset + 46, offset + 46 + nameLength);
    const localNameLength = zip.readUInt16LE(localOffset + 26);
    const localExtraLength = zip.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    const data = zip.subarray(start, start + compressedSize);
    entries.set(name, method === 8 ? inflateRawSync(data) : Buffer.from(data));
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** RFC 4180 parser: comma separator, double quotes, CRLF or LF line endings. */
function parseCsv(text: string): string[][] {
  const source = text.startsWith(BOM) ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (quoted) {
      if (ch === '"') {
        if (source[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && source[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += ch;
    }
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

function findEntry(entries: Map<string, Buffer>, base: string): Buffer {
  for (const [name, data] of entries) {
    if (name.startsWith(base)) return data;
  }
  throw new Error(`entry ${base} not found in ${[...entries.keys()].join(', ')}`);
}

interface CsvZipModule {
  createZipStream: (files: AsyncIterable<CsvFile>) => AsyncIterable<unknown>;
}

async function exportFiles(files: CsvFile[]): Promise<Map<string, Buffer>> {
  const { createZipStream } = (await import(
    '../../src/infrastructure/export/csv-zip.js'
  )) as CsvZipModule;
  const stream = createZipStream(asFiles(files));
  return unzip(await collect(stream));
}

const HEADER: Row = ['date', 'amount', 'note'];

describe('createZipStream', () => {
  it('RF-M1-14 genera un ZIP con un CSV por archivo y todas sus filas', async () => {
    const entries = await exportFiles([
      { name: 'accounts.csv', rows: [['name'], ['Efectivo'], ['Banco']] },
      { name: 'transactions.csv', rows: [HEADER, ['2026-10-01', '10.00', 'Pan']] },
    ]);
    expect(entries.size).toBe(2);
    expect(parseCsv(findEntry(entries, 'accounts').toString('utf8'))).toEqual([
      ['name'],
      ['Efectivo'],
      ['Banco'],
    ]);
    expect(parseCsv(findEntry(entries, 'transactions').toString('utf8'))).toEqual([
      HEADER,
      ['2026-10-01', '10.00', 'Pan'],
    ]);
  });

  it('RF-M1-14 usa la coma como separador', async () => {
    const entries = await exportFiles([{ name: 'transactions.csv', rows: [HEADER] }]);
    const text = findEntry(entries, 'transactions').toString('utf8');
    const lines = (text.startsWith(BOM) ? text.slice(1) : text).split(/\r?\n/);
    expect(lines[0]).toBe('date,amount,note');
  });

  it('RF-M1-14 una nota "=SUM(A1)" queda neutralizada con un apostrofo', async () => {
    const entries = await exportFiles([
      { name: 'transactions.csv', rows: [HEADER, ['2026-10-01', '5.00', '=SUM(A1)']] },
    ]);
    const rows = parseCsv(findEntry(entries, 'transactions').toString('utf8'));
    expect(rows[1]?.[2]).toBe("'=SUM(A1)");
  });

  it.each(['+1+1', '-2+3', '@cmd', '=HYPERLINK("x")'])(
    'RF-M1-14 una celda que empieza con %s se neutraliza',
    async (value) => {
      const entries = await exportFiles([
        { name: 'transactions.csv', rows: [HEADER, ['2026-10-01', '5.00', value]] },
      ]);
      const rows = parseCsv(findEntry(entries, 'transactions').toString('utf8'));
      expect(rows[1]?.[2]).toBe(`'${value}`);
    },
  );

  it('RF-M1-14 una celda que no empieza con =, +, - ni @ queda igual', async () => {
    const entries = await exportFiles([
      { name: 'transactions.csv', rows: [HEADER, ['2026-10-01', '5.00', 'Total = 5']] },
    ]);
    const rows = parseCsv(findEntry(entries, 'transactions').toString('utf8'));
    expect(rows[1]).toEqual(['2026-10-01', '5.00', 'Total = 5']);
  });

  it('RF-M1-14 un monto se escribe como "1234.56", sin separador de miles ni comillas', async () => {
    const entries = await exportFiles([
      { name: 'transactions.csv', rows: [HEADER, ['2026-10-01', '1234.56', 'Alquiler']] },
    ]);
    const text = findEntry(entries, 'transactions').toString('utf8');
    expect(text).toContain('2026-10-01,1234.56,Alquiler');
    expect(parseCsv(text)[1]?.[1]).toBe('1234.56');
  });

  it('RF-M1-14 una nota con comas y tildes se lee igual (UTF-8 y comillas)', async () => {
    const note = 'Café, pan y té para la niña';
    const entries = await exportFiles([
      { name: 'transactions.csv', rows: [HEADER, ['2026-10-01', '12.50', note]] },
    ]);
    const data = findEntry(entries, 'transactions');
    const text = new TextDecoder('utf-8', { fatal: true }).decode(data);
    expect(text).toContain('Café');
    expect(parseCsv(text)[1]).toEqual(['2026-10-01', '12.50', note]);
  });

  it('RF-M1-14 una nota con comillas y saltos de línea se lee igual', async () => {
    const note = 'Dijo "hola"\ny se fue';
    const entries = await exportFiles([
      { name: 'transactions.csv', rows: [HEADER, ['2026-10-01', '3.00', note]] },
    ]);
    const rows = parseCsv(findEntry(entries, 'transactions').toString('utf8'));
    expect(rows).toHaveLength(2);
    expect(rows[1]?.[2]).toBe(note);
  });
});
