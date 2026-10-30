import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { build } from 'vite';

// TASK-248: the test builds the web (in memory, nothing is written to disk) and measures the
// JavaScript each route downloads: the entry chunk plus every chunk it imports statically.

/** Budget of the `/registrar` route: 305 KB gzip, with Vite's convention of 1 KB = 1000 bytes. */
const REGISTER_BUDGET_BYTES = 305 * 1000;
/** The `icons` object of lucide-react has ~1,700 icons; the IconKey catalog is far smaller. */
const MAX_LUCIDE_ICON_MODULES = 250;
const BUILD_TIMEOUT_MS = 300_000;

interface BuiltChunk {
  type: 'chunk';
  fileName: string;
  code: string;
  isEntry: boolean;
  imports: string[];
  dynamicImports: string[];
  facadeModuleId: string | null;
  modules: Record<string, { renderedLength: number }>;
}

interface BuiltOutput {
  output: ({ type: 'asset' | 'chunk'; fileName: string } | BuiltChunk)[];
}

function isChunk(item: { type: string }): item is BuiltChunk {
  return item.type === 'chunk';
}

function normalize(id: string): string {
  return id.replaceAll('\\', '/');
}

function isBuiltOutput(value: unknown): value is BuiltOutput {
  return typeof value === 'object' && value !== null && 'output' in value;
}

const webRoot = fileURLToPath(new URL('..', import.meta.url));

let chunks = new Map<string, BuiltChunk>();
let entryClosure = new Set<string>();
let registerChunks: BuiltChunk[] = [];
let registerClosure = new Set<string>();
const previousNodeEnv = process.env['NODE_ENV'];

/** `start` plus every chunk reachable through static `imports` only. */
function staticClosure(start: string[]): Set<string> {
  const seen = new Set<string>();
  const pending = [...start];
  for (let name = pending.pop(); name !== undefined; name = pending.pop()) {
    if (seen.has(name)) continue;
    seen.add(name);
    const chunk = chunks.get(name);
    if (chunk) pending.push(...chunk.imports);
  }
  return seen;
}

function closureGzipBytes(closure: Set<string>): number {
  let total = 0;
  for (const name of closure) {
    const chunk = chunks.get(name);
    if (chunk) total += gzipSync(chunk.code, { level: 9 }).length;
  }
  return total;
}

/** Ids of the modules that actually put code in the chunks of the closure. */
function renderedModuleIds(closure: Set<string>): string[] {
  const ids: string[] = [];
  for (const name of closure) {
    const chunk = chunks.get(name);
    if (!chunk) continue;
    for (const [id, info] of Object.entries(chunk.modules)) {
      if (info.renderedLength > 0) ids.push(normalize(id));
    }
  }
  return ids;
}

function chunksWithModule(pattern: RegExp): BuiltChunk[] {
  return [...chunks.values()].filter((chunk) =>
    Object.entries(chunk.modules).some(
      ([id, info]) => info.renderedLength > 0 && pattern.test(normalize(id)),
    ),
  );
}

beforeAll(async () => {
  process.env['NODE_ENV'] = 'production';
  const result: unknown = await build({
    root: webRoot,
    configFile: fileURLToPath(new URL('../vite.config.ts', import.meta.url)),
    mode: 'production',
    logLevel: 'silent',
    build: { write: false, reportCompressedSize: false },
  });
  const outputs: unknown[] = Array.isArray(result) ? (result as unknown[]) : [result];
  chunks = new Map<string, BuiltChunk>();
  for (const out of outputs) {
    if (!isBuiltOutput(out)) continue;
    for (const item of out.output) {
      if (isChunk(item)) chunks.set(item.fileName, item);
    }
  }
  const entries = [...chunks.values()].filter((chunk) => chunk.isEntry);
  const first = entries[0];
  if (!first) throw new Error('The build produced no entry chunk');
  entryClosure = staticClosure(entries.map((chunk) => chunk.fileName));

  // The chunks of the `/registrar` screen: loaded with `import()` from the entry package and
  // whose entry module lives in the Register feature.
  const dynamicTargets = [...entryClosure].flatMap(
    (name) => chunks.get(name)?.dynamicImports ?? [],
  );
  const targets = dynamicTargets
    .map((name) => chunks.get(name))
    .filter(
      (chunk): chunk is BuiltChunk => chunk !== undefined && !entryClosure.has(chunk.fileName),
    );
  const byFacade = targets.filter((chunk) =>
    normalize(chunk.facadeModuleId ?? '').includes('/src/features/register/'),
  );
  registerChunks = byFacade.length
    ? byFacade
    : targets.filter((chunk) =>
        Object.keys(chunk.modules).some((id) => normalize(id).includes('/src/features/register/')),
      );
  registerClosure = staticClosure(registerChunks.map((chunk) => chunk.fileName));
}, BUILD_TIMEOUT_MS);

afterAll(() => {
  if (previousNodeEnv === undefined) delete process.env['NODE_ENV'];
  else process.env['NODE_ENV'] = previousNodeEnv;
});

/** Everything `/registrar` downloads: the entry package plus the chunks of that route. */
function registerRouteChunks(): Set<string> {
  return new Set([...entryClosure, ...registerClosure]);
}

describe('TASK-248 bundle budget', () => {
  it('RNF-01 la pantalla de /registrar es un bloque diferido, fuera del paquete de entrada', () => {
    expect(registerChunks.length).toBeGreaterThan(0);
    const entryModules = renderedModuleIds(entryClosure);
    expect(
      entryModules.some((id) => id.includes('/src/features/register/components/register-form')),
    ).toBe(false);
  });

  it('RNF-01 el JavaScript que descarga /registrar pesa 305 KB gzip o menos', () => {
    expect(registerChunks.length).toBeGreaterThan(0);
    const bytes = closureGzipBytes(registerRouteChunks());
    expect(bytes).toBeGreaterThan(0);
    expect(bytes).toBeLessThanOrEqual(REGISTER_BUDGET_BYTES);
  });

  it('RNF-01 el paquete de entrada no incluye el objeto icons de lucide-react', () => {
    const ids = renderedModuleIds(registerRouteChunks());
    expect(ids.some((id) => /lucide-react\/dist\/esm\/icons\/index\.mjs$/.test(id))).toBe(false);
    const iconModules = ids.filter((id) =>
      /lucide-react\/dist\/esm\/icons\/(?!index\.mjs)/.test(id),
    );
    expect(iconModules.length).toBeLessThanOrEqual(MAX_LUCIDE_ICON_MODULES);
  });

  it('RNF-01 la pantalla de detalle de un movimiento no entra en el paquete de entrada ni en /registrar', () => {
    const ids = renderedModuleIds(registerRouteChunks());
    expect(
      ids.some((id) => id.includes('/src/features/transactions/components/transaction-detail')),
    ).toBe(false);
  });

  it('RNF-01 el calendario del selector de fecha (react-day-picker) se carga solo al abrirlo', () => {
    const closure = registerRouteChunks();
    const ids = renderedModuleIds(closure);
    expect(ids.some((id) => /node_modules\/(react-day-picker|date-fns)\//.test(id))).toBe(false);
    // The calendar still ships, in a chunk that the route does not import statically.
    const calendarChunks = chunksWithModule(/node_modules\/react-day-picker\//);
    expect(calendarChunks.length).toBeGreaterThan(0);
    for (const chunk of calendarChunks) expect(closure.has(chunk.fileName)).toBe(false);
  });

  it('RNF-03 los gráficos del Inicio (recharts) no están en el paquete de entrada ni en /registrar', () => {
    const ids = renderedModuleIds(registerRouteChunks());
    expect(ids.some((id) => /node_modules\/recharts\//.test(id))).toBe(false);
    expect(ids.some((id) => id.includes('/src/features/dashboard/components/pace-chart'))).toBe(
      false,
    );
    // Still shipped, in lazy chunks.
    const chartChunks = chunksWithModule(/node_modules\/recharts\//);
    expect(chartChunks.length).toBeGreaterThan(0);
    for (const chunk of chartChunks) expect(registerRouteChunks().has(chunk.fileName)).toBe(false);
  });

  it('RNF-03 el arrastrar y soltar de Categorías (dnd-kit) no está en el paquete de entrada ni en /registrar', () => {
    const ids = renderedModuleIds(registerRouteChunks());
    expect(ids.some((id) => /node_modules\/@dnd-kit\//.test(id))).toBe(false);
    expect(ids.some((id) => id.includes('/src/features/categories/components/category-tree'))).toBe(
      false,
    );
    const dndChunks = chunksWithModule(/node_modules\/@dnd-kit\//);
    expect(dndChunks.length).toBeGreaterThan(0);
    for (const chunk of dndChunks) expect(registerRouteChunks().has(chunk.fileName)).toBe(false);
  });
});
