import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test } from '@playwright/test';

/**
 * TASK-243: spec -> tests traceability (plan §5.2 and §5.4, points 1 and 3).
 *
 * Reads the Gherkin scenario titles and the RF / EC ids of `spec.md`, collects the names of every
 * test in the repository (Playwright, Vitest) and lists whatever has no test.
 */

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const SPEC_PATH = join(ROOT, '001-appFinanzas-mvp', 'spec.md');
const THIS_FILE = 'e2e/gherkin-coverage.spec.ts';

const TEST_ROOTS = ['e2e', 'apps', 'packages'] as const;
const TEST_FILE = /\.(?:spec|test)\.tsx?$/;
const SKIPPED_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage']);

/** Scenarios the spec declares (the spec fixes the number at 53). */
const EXPECTED_SCENARIOS = 53;

/** A call to it, test or their variants (skip, only, describe) with the name as first argument. */
const TEST_CALL = /\b(?:it|test)(?:\.[a-zA-Z]+)*\s*\(\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1/g;

function listTestFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || SKIPPED_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...listTestFiles(full));
    } else if (TEST_FILE.test(entry.name)) {
      found.push(full);
    }
  }
  return found;
}

/** Every test name in the repository, except this file's own. */
function collectTestNames(): string[] {
  const names: string[] = [];
  for (const base of TEST_ROOTS) {
    for (const file of listTestFiles(join(ROOT, base))) {
      if (relative(ROOT, file).split('\\').join('/') === THIS_FILE) continue;
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(TEST_CALL)) {
        if (match[2] !== undefined) names.push(match[2]);
      }
    }
  }
  return names;
}

/** Case, accents, quotes, escapes and spacing do not decide whether a title is in a test name. */
function normalize(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/\\(.)/g, '$1')
    .replace(/["'`«»“”‘’]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function readSpec(): string {
  return readFileSync(SPEC_PATH, 'utf8');
}

function scenarioTitles(spec: string): string[] {
  return [...spec.matchAll(/^\s*Escenario:\s*(.+?)\s*$/gm)].flatMap((m) => (m[1] ? [m[1]] : []));
}

/** RF-Mx-nn and EC-Mx-nn declared as list items (`- **RF-M1-01:** ...`). */
function requirementIds(spec: string): string[] {
  const ids = [...spec.matchAll(/^\s*[-*]\s+\*\*((?:RF|EC)-M\d+-\d+)\b/gm)].flatMap((m) =>
    m[1] ? [m[1]] : [],
  );
  return [...new Set(ids)];
}

function describeMissing(kind: string, missing: string[], total: number): string {
  return missing.length === 0
    ? `${kind}: todos cubiertos (${total})`
    : `${kind} sin test (${missing.length} de ${total}):\n${missing.map((m) => `  - ${m}`).join('\n')}`;
}

test.describe('TASK-243 cobertura de la especificación', () => {
  test('TASK-243 los 53 escenarios Gherkin tienen su test, y la prueba lista los que falten', () => {
    const titles = scenarioTitles(readSpec());
    expect(titles, 'la spec declara 53 escenarios Gherkin').toHaveLength(EXPECTED_SCENARIOS);
    expect(new Set(titles.map(normalize)).size, 'los títulos de escenario son únicos').toBe(
      titles.length,
    );

    const testNames = collectTestNames().map(normalize);
    expect(testNames.length, 'se encontraron tests en el repositorio').toBeGreaterThan(0);

    const missing = titles.filter((title) => {
      const wanted = normalize(title);
      return !testNames.some((name) => name.includes(wanted));
    });

    expect(missing, describeMissing('Escenarios', missing, titles.length)).toEqual([]);
  });

  test('TASK-243 cada RF y EC de spec.md aparece en el nombre de algún test', () => {
    const ids = requirementIds(readSpec());
    expect(ids.length, 'la spec declara RF y EC').toBeGreaterThan(0);

    const testNames = collectTestNames();
    const missing = ids.filter((id) => {
      const pattern = new RegExp(`(?<![A-Za-z0-9-])${id}(?![0-9])`);
      return !testNames.some((name) => pattern.test(name));
    });

    expect(missing, describeMissing('RF y EC', missing, ids.length)).toEqual([]);
  });
});
