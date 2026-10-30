import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ErrorCode } from '@finanzas/contracts';
import { describe, expect, it } from 'vitest';

import {
  EMAIL_KINDS,
  emailTemplates,
} from '../../src/infrastructure/integrations/email-templates.js';

/**
 * TASK-271 — the SDD documents (constitution, spec, plan, tasks) and the code say the same thing.
 * Each case lists every difference it finds, so a failure shows what is left to reconcile.
 */

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../..');
const FEATURE = '001-appFinanzas-mvp';

/** Reads a repository file with LF line endings, whatever the checkout uses. */
const read = (relative: string): string =>
  readFileSync(join(ROOT, relative), 'utf8').replace(/\r\n/g, '\n');

const spec = read(`${FEATURE}/spec.md`);
const plan = read(`${FEATURE}/plan.md`);
const tasks = read(`${FEATURE}/tasks.md`);
const constitution = read('docs/constitution.md');

/** Every difference between two sets, labelled with where each side comes from. */
const setDiff = (
  leftName: string,
  left: Iterable<string>,
  rightName: string,
  right: Iterable<string>,
): string[] => {
  const a = new Set(left);
  const b = new Set(right);
  return [
    ...[...a].filter((x) => !b.has(x)).map((x) => `${x}: in ${leftName}, missing in ${rightName}`),
    ...[...b].filter((x) => !a.has(x)).map((x) => `${x}: in ${rightName}, missing in ${leftName}`),
  ].sort();
};

const matchAll = (text: string, re: RegExp, group = 1): string[] =>
  [...text.matchAll(re)].map((m) => m[group] ?? '');

/** The text of a markdown section: from its heading to the next heading of the same or higher level. */
const section = (doc: string, heading: RegExp): string => {
  const lines = doc.split('\n');
  const start = lines.findIndex((l) => heading.test(l));
  if (start === -1) throw new Error(`section not found: ${heading.source}`);
  const level = /^#+/.exec(lines[start] ?? '')?.[0].length ?? 1;
  const end = lines.findIndex(
    (l, i) => i > start && /^#+ /.test(l) && (/^#+/.exec(l)?.[0].length ?? 99) <= level,
  );
  return lines.slice(start, end === -1 ? undefined : end).join('\n');
};

/** The cells of a markdown table row (without the outer pipes; `\|` stays inside a cell). */
const cells = (row: string): string[] =>
  row
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split(/(?<!\\)\|/)
    .map((c) => c.trim());

/** Body rows of every table in a text (header and separator rows excluded). */
const tableRows = (text: string): string[][] => {
  const rows: string[][] = [];
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    if (!line.trim().startsWith('|')) return;
    if (/^\|[\s|:-]+\|$/.test(line.trim())) return;
    const next = lines[i + 1]?.trim() ?? '';
    if (/^\|[\s|:-]+\|$/.test(next)) return; // header row
    rows.push(cells(line));
  });
  return rows;
};

// ---------------------------------------------------------------------------------------------
// Email kinds (RF-M1-16, RF-M1-08)
// ---------------------------------------------------------------------------------------------

/** The names RF-M1-16 uses for each email, with the `email_kind` value that implements it. */
const SPEC_EMAIL_NAMES: Record<string, string> = {
  confirmación: 'confirm',
  'intento de registro con un correo existente': 'register_attempt',
  recuperación: 'reset',
  'cambio de contraseña': 'password_changed',
  'eliminación de la cuenta': 'account_deleted',
};

const specRule = (id: string): string => {
  const line = spec.split('\n').find((l) => l.startsWith(`- **${id}:**`));
  if (line === undefined) throw new Error(`${id} not found in spec.md`);
  return line;
};

const specEmailNames = (): string[] => {
  const text = specRule('RF-M1-16');
  const list = /son:\s*(.+?)\.?$/.exec(text)?.[1] ?? '';
  return list
    .split(/,\s*|\s+y\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
};

const planEmailKinds = (): string[] => {
  const enumLine = /CREATE TYPE email_kind\s+AS ENUM \(([^)]*)\)/.exec(plan)?.[1] ?? '';
  return matchAll(enumLine, /'([^']+)'/g);
};

const typeEmailKinds = (): string[] => {
  const source = read('apps/api/src/application/ports/email-gateway.ts');
  const union = /export type EmailKind\s*=([^;]+);/.exec(source)?.[1] ?? '';
  return matchAll(union, /'([^']+)'/g);
};

const prismaEnumValues = (name: string): string[] => {
  const schema = read('packages/db/prisma/schema.prisma');
  for (const block of matchAll(schema, /^enum \w+ \{([\s\S]*?)^\}/gm)) {
    if (new RegExp(`@@map\\("${name}"\\)`).test(block)) {
      return block
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => /^\w+/.test(l))
        .map((l) => /@map\("([^"]+)"\)/.exec(l)?.[1] ?? l.split(/\s+/)[0] ?? '');
    }
  }
  return [];
};

describe('TASK-271 SDD coherence — email kinds', () => {
  it('RF-M1-16 the email kinds of the spec, the plan enum, EmailKind and the templates match', () => {
    const fromSpec = specEmailNames().map((name) => SPEC_EMAIL_NAMES[name] ?? `unknown:"${name}"`);
    const diffs = [
      ...setDiff('spec RF-M1-16', fromSpec, 'plan §3.2 email_kind', planEmailKinds()),
      ...setDiff('plan §3.2 email_kind', planEmailKinds(), 'EMAIL_KINDS', EMAIL_KINDS),
      ...setDiff('EMAIL_KINDS', EMAIL_KINDS, 'type EmailKind', typeEmailKinds()),
      ...setDiff('EMAIL_KINDS', EMAIL_KINDS, 'emailTemplates', Object.keys(emailTemplates)),
      ...setDiff(
        'EMAIL_KINDS',
        EMAIL_KINDS,
        'schema.prisma email_kind',
        prismaEnumValues('email_kind'),
      ),
    ];
    expect(diffs).toEqual([]);
    expect(fromSpec).toHaveLength(5);
  });

  it('RF-M1-16 no email kind is about failed sign-in attempts', () => {
    const all = [
      ...planEmailKinds(),
      ...EMAIL_KINDS,
      ...typeEmailKinds(),
      ...Object.keys(emailTemplates),
      ...prismaEnumValues('email_kind'),
    ];
    expect(all.filter((k) => /alert|login|attempt_failed|failed/i.test(k))).toEqual([]);
  });

  it('RF-M1-08 neither the spec nor the plan announces an email for failed attempts', () => {
    const offending: string[] = [];
    for (const [name, doc] of [
      ['spec.md', spec],
      ['plan.md', plan],
    ] as const) {
      doc.split('\n').forEach((line, i) => {
        if (/^\|\s*1\.\d+\s*\|/.test(line)) return; // version history row
        // `login_alert` may only appear to say it no longer exists ("sin login_alert").
        for (const m of line.matchAll(/login_alert|last_alert_sent_at/g)) {
          const before = line.slice(Math.max(0, (m.index ?? 0) - 5), m.index);
          if (!/sin\s+$/.test(before)) offending.push(`${name}:${i + 1}: ${line.trim()}`);
        }
        if (/correo de (alerta|aviso) (de|por) (inicio de sesión|intentos)/i.test(line)) {
          offending.push(`${name}:${i + 1}: ${line.trim()}`);
        }
      });
    }
    expect(offending).toEqual([]);
    expect(specRule('RF-M1-08')).toContain('No envía ningún correo por los intentos fallidos');
    const signIn = plan.split('\n').find((l) => l.startsWith('| `POST /api/auth/sign-in`')) ?? '';
    expect(signIn).toContain('no se envía ningún correo');
  });

  it('RF-M1-08 the progressive wait is still in the spec and in the plan', () => {
    const rule = specRule('RF-M1-08');
    expect(rule).toContain('Tras 5 fallos seguidos exige 1 minuto de espera');
    expect(rule).toContain('tras 10, 15 minutos');
    expect(rule).toContain('NUNCA bloquea la cuenta de forma permanente');
    const signIn = plan.split('\n').find((l) => l.startsWith('| `POST /api/auth/sign-in`')) ?? '';
    expect(signIn).toContain('LOGIN_LOCKED');
    expect(signIn).toContain('throttle.fail()');
    expect(plan).toContain('Espera progresiva tras intentos fallidos');
  });
});

// ---------------------------------------------------------------------------------------------
// (2) Endpoints
// ---------------------------------------------------------------------------------------------

const METHOD_RE = /^(GET|POST|PUT|PATCH|DELETE)\s+(\/\S*)/;

/** `/api/x/:id?a&b {body}` → `/api/x/:param`, so the plan and the code can be compared. */
const normalizePath = (path: string): string => {
  const clean = path.split('?')[0]?.split(' ')[0]?.replace(/\/+$/, '') ?? '';
  return (clean === '' ? '/' : clean).replace(/:\w+/g, ':param');
};

const parentOf = (path: string): string => path.replace(/\/[^/]+$/, '');

/**
 * Each endpoint of the plan, as the alternatives it may stand for: a bare method after a route
 * (`POST /api/shortcuts` · `PATCH`) is that resource or one of its items.
 */
const planEndpoints = (): string[][] => {
  const found = new Map<string, string[]>();
  const add = (alternatives: string[]): void => {
    found.set(alternatives.join(' | '), alternatives);
  };
  const headings = matchAll(plan, /^(#### 4\.\d+\.\d+ Endpoints)$/gm);
  for (const heading of headings) {
    const text = section(plan, new RegExp(`^${heading.replace(/\./g, '\\.')}$`));
    const firstCells = [
      ...tableRows(text).map((row) => row[0] ?? ''),
      ...text
        .split('\n')
        .filter((l) => /^- `(GET|POST|PUT|PATCH|DELETE) /.test(l))
        .map((l) => /^- (`[^`]+`)/.exec(l)?.[1] ?? ''),
    ];
    for (const cell of firstCells) {
      let method: string | null = null;
      let lastPath: string | null = null;
      for (const token of matchAll(cell.replace(/\\\|/g, '|'), /`([^`]+)`/g)) {
        const full = METHOD_RE.exec(token);
        if (full !== null) {
          method = full[1] ?? null;
          lastPath = normalizePath(full[2] ?? '');
          add([`${method} ${lastPath}`]);
        } else if (/^(GET|POST|PUT|PATCH|DELETE)$/.test(token) && lastPath !== null) {
          const base = lastPath.replace(/\/:param$/, '');
          add([`${token} ${base}`, `${token} ${base}/:param`]);
        } else if (token.startsWith('/') && method !== null && lastPath !== null) {
          lastPath = normalizePath(parentOf(lastPath) + token);
          add([`${method} ${lastPath}`]);
        }
      }
    }
  }
  return [...found.values()];
};

const codeEndpoints = (): Set<string> => {
  const routesDir = 'apps/api/src/presentation/routes';
  const routerPaths = new Map<string, string[]>();
  for (const file of readdirSync(join(ROOT, routesDir))) {
    if (!file.endsWith('.ts')) continue;
    const source = read(`${routesDir}/${file}`);
    const parts = source.split(/^export const /m).slice(1);
    for (const part of parts) {
      const name = /^(\w+)/.exec(part)?.[1];
      if (name === undefined) continue;
      const routes = [...part.matchAll(/router\.(get|post|put|patch|delete)\(\s*'([^']+)'/g)].map(
        (m) => `${(m[1] ?? '').toUpperCase()} ${m[2] ?? ''}`,
      );
      if (routes.length > 0) routerPaths.set(name, routes);
    }
  }
  const app = read('apps/api/src/presentation/app.ts');
  const found = new Set<string>();
  for (const m of app.matchAll(/app\.use\(\s*'([^']+)',\s*(\w+)\(/g)) {
    const prefix = m[1] ?? '';
    for (const route of routerPaths.get(m[2] ?? '') ?? []) {
      const [method, path = ''] = route.split(' ');
      found.add(`${method} ${normalizePath(prefix + (path === '/' ? '' : path))}`);
    }
  }
  return found;
};

describe('TASK-271 SDD coherence — (2) endpoints', () => {
  it('TASK-271 every endpoint of plan §4.x.2 is a registered route and every route is in the plan', () => {
    const fromPlan = planEndpoints();
    const fromCode = codeEndpoints();
    expect(fromPlan.length).toBeGreaterThan(50);
    const diffs = [
      ...fromPlan
        .filter((alternatives) => !alternatives.some((e) => fromCode.has(e)))
        .map(
          (alternatives) =>
            `${alternatives.join(' or ')}: in plan §4.x.2, missing in routes + app.ts`,
        ),
      ...[...fromCode]
        .filter((e) => !fromPlan.some((alternatives) => alternatives.includes(e)))
        .map((e) => `${e}: in routes + app.ts, missing in plan §4.x.2`),
    ].sort();
    expect(diffs).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// (3) Error catalog
// ---------------------------------------------------------------------------------------------

const planErrorCodes = (): Set<string> => {
  const codes = new Set<string>();
  // A code with its HTTP status anywhere in the plan: `NAME_TAKEN 409`.
  for (const m of plan.matchAll(/`([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+) [1-5]\d\d\b[^`]*`/g)) {
    codes.add(m[1] ?? '');
  }
  // Any code in the errors / responses column (the last one) of the endpoint tables.
  for (const heading of matchAll(plan, /^(#### 4\.\d+\.\d+ Endpoints)$/gm)) {
    const text = section(plan, new RegExp(`^${heading.replace(/\./g, '\\.')}$`));
    for (const row of tableRows(text)) {
      // A parenthesis explains a code (`VALIDATION_ERROR 400` (`SAME_ACCOUNT`, …)); it is not one.
      const last = (row[row.length - 1] ?? '').replace(/\([^)]*\)/g, '');
      for (const m of last.matchAll(/`([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)\b[^`]*`/g)) {
        codes.add(m[1] ?? '');
      }
    }
  }
  return codes;
};

describe('TASK-271 SDD coherence — (3) error catalog', () => {
  it('TASK-271 every code of the contracts catalog is in the plan and every plan code is in the catalog', () => {
    const catalog = Object.keys(ErrorCode);
    const notInPlan = catalog
      .filter((code) => !new RegExp(`\\b${code}\\b`).test(plan))
      .map((code) => `${code}: in the contracts catalog, missing in plan.md`);
    const notInCatalog = [...planErrorCodes()]
      .filter((code) => !catalog.includes(code))
      .map((code) => `${code}: in plan.md, missing in the contracts catalog`);
    expect([...notInPlan, ...notInCatalog].sort()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// (4) Tables
// ---------------------------------------------------------------------------------------------

describe('TASK-271 SDD coherence — (4) tables', () => {
  it('TASK-271 every CREATE TABLE of plan §3 is a schema.prisma model and the other way around', () => {
    const planTables = matchAll(
      section(plan, /^## 3\. /),
      /CREATE TABLE (?:IF NOT EXISTS )?(\w+)/g,
    );
    const schema = read('packages/db/prisma/schema.prisma');
    const models = [...schema.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)].map(
      (m) => /@@map\("([^"]+)"\)/.exec(m[2] ?? '')?.[1] ?? m[1] ?? '',
    );
    expect(planTables.length).toBeGreaterThan(30);
    expect(setDiff('plan §3', planTables, 'schema.prisma', models)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// (5) Traceability
// ---------------------------------------------------------------------------------------------

const specIds = (kinds: RegExp): string[] =>
  matchAll(spec, /^- \*\*([A-Z]+(?:-M\d+)?-\d+):\*\*/gm).filter((id) => kinds.test(id));

describe('TASK-271 SDD coherence — (5) traceability', () => {
  it('TASK-271 every RF, EC and RNF of the spec has its row in the matrix of plan §5.5', () => {
    const ids = specIds(/^(RF-M\d+|EC-M\d+|RNF)-\d+$/);
    const matrix = tableRows(section(plan, /^### 5\.5 /)).map((row) => row[0] ?? '');
    expect(ids.length).toBeGreaterThan(200);
    const missing = ids
      .filter((id) => !matrix.includes(id))
      .map((id) => `${id}: in spec.md, missing in plan §5.5`);
    expect(missing).toEqual([]);
  });

  it('TASK-271 every Gherkin scenario of the spec has its row in plan §5.2', () => {
    const scenarios = matchAll(spec, /^\s*Escenario:\s*(.+?)\s*$/gm);
    const rows = tableRows(section(plan, /^### 5\.2 /)).map((row) => row[1] ?? '');
    expect(scenarios.length).toBeGreaterThan(50);
    expect(setDiff('spec.md scenarios', scenarios, 'plan §5.2', rows)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// (6) Environment
// ---------------------------------------------------------------------------------------------

const envKeys = (): string[] => {
  const source = read('apps/api/src/infrastructure/config/env.ts');
  const object = /z\s*\.object\(\{([\s\S]*?)\n\s*\}\)/.exec(source)?.[1] ?? '';
  return matchAll(object, /^\s*([A-Z][A-Z0-9_]*):/gm);
};

describe('TASK-271 SDD coherence — (6) environment', () => {
  it('TASK-271 every variable of env.ts is in .env.example', () => {
    // A commented line (`# EMAIL_FROM=…`) documents an optional variable.
    const example = matchAll(read('.env.example'), /^#?\s*([A-Z][A-Z0-9_]*)=/gm);
    const keys = envKeys();
    expect(keys.length).toBeGreaterThan(5);
    const missing = keys
      .filter((key) => !example.includes(key))
      .map((key) => `${key}: in env.ts, missing in .env.example`);
    expect(missing).toEqual([]);
  });

  it('TASK-271 every render.yaml variable with sync: false is in env.ts', () => {
    const render = read('render.yaml');
    const secrets = matchAll(render, /- key: ([A-Z][A-Z0-9_]*)\n\s*sync: false/g);
    const keys = envKeys();
    expect(secrets.length).toBeGreaterThan(0);
    const missing = secrets
      .filter((key) => !keys.includes(key))
      .map((key) => `${key}: sync: false in render.yaml, missing in env.ts`);
    expect(missing).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// (7) IDs cited by the tasks
// ---------------------------------------------------------------------------------------------

describe('TASK-271 SDD coherence — (7) IDs cited by tasks.md', () => {
  it('TASK-271 every RN, RF, EC and RNF cited by the tasks exists in the spec', () => {
    const defined = new Set(specIds(/^(RN|RNF|RF-M\d+|EC-M\d+)-\d+$/));
    const backlog = section(tasks, /^## 2\. /);
    const cited = new Set(matchAll(backlog, /\b(RNF-\d+|RN-\d+|RF-M\d+-\d+|EC-M\d+-\d+)\b/g));
    const missing = [...cited]
      .filter((id) => !defined.has(id))
      .sort()
      .map((id) => `${id}: cited in tasks.md, missing in spec.md`);
    expect(missing).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// (8) Versions cited in the headers
// ---------------------------------------------------------------------------------------------

/** The header of a document: everything before its first `## ` heading or `---` rule. */
const header = (doc: string): string => {
  const lines = doc.split('\n');
  const end = lines.findIndex((l, i) => i > 0 && (/^## /.test(l) || /^---\s*$/.test(l)));
  return lines.slice(0, end === -1 ? undefined : end).join('\n');
};

const versionOf = (doc: string): string => /\*\*Versión:\*\*\s*([\d.]+)/.exec(doc)?.[1] ?? '?';

describe('TASK-271 SDD coherence — (8) versions in the headers', () => {
  it('TASK-271 the version each header cites is the version of the cited document', () => {
    const docs: Record<string, string> = {
      'docs/constitution.md': constitution,
      [`${FEATURE}/spec.md`]: spec,
      [`${FEATURE}/plan.md`]: plan,
      [`${FEATURE}/tasks.md`]: tasks,
    };
    const diffs: string[] = [];
    let citations = 0;
    for (const [name, doc] of Object.entries(docs)) {
      for (const m of header(doc).matchAll(/`([^`]+\.md)`\s+v([\d.]+)/g)) {
        citations += 1;
        const cited = m[1] ?? '';
        const target = docs[cited] ?? read(cited);
        const actual = versionOf(target);
        if (actual !== m[2]) diffs.push(`${name} cites ${cited} v${m[2]}, but it is v${actual}`);
      }
    }
    expect(citations).toBeGreaterThan(3);
    expect(diffs).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// (9) Phase map
// ---------------------------------------------------------------------------------------------

const taskNumber = (id: string): number => Number(id.replace('TASK-', ''));
const taskId = (n: number): string => `TASK-${String(n).padStart(3, '0')}`;

describe('TASK-271 SDD coherence — (9) phase map', () => {
  it('TASK-271 the phase map of tasks.md covers exactly the tasks of each phase', () => {
    const map = new Map<string, Set<string>>();
    for (const row of tableRows(section(tasks, /^## 1\. /))) {
      const phase = (row[0] ?? '').replace(/\*/g, '').trim();
      if (!/^\d+$/.test(phase)) continue;
      const listed = new Set<string>();
      const cell = row[row.length - 1] ?? '';
      for (const m of cell.matchAll(/(TASK-\d+)(?:\s+a\s+(TASK-\d+))?/g)) {
        const from = taskNumber(m[1] ?? '');
        const to = m[2] === undefined ? from : taskNumber(m[2]);
        for (let n = from; n <= to; n += 1) listed.add(taskId(n));
      }
      map.set(phase, listed);
    }

    const backlog = section(tasks, /^## 2\. /);
    const actual = new Map<string, Set<string>>();
    let current: string | null = null;
    for (const line of backlog.split('\n')) {
      const phase = /^### Fase (\d+)/.exec(line)?.[1];
      if (phase !== undefined) {
        current = phase;
        actual.set(phase, new Set());
        continue;
      }
      const task = /^- \[[ xX]\] \*\*`(TASK-\d+)`/.exec(line)?.[1];
      if (task !== undefined && current !== null) actual.get(current)?.add(task);
    }

    expect(map.size).toBeGreaterThan(20);
    const diffs = setDiff('phase map', map.keys(), 'backlog', actual.keys());
    for (const [phase, listed] of map) {
      const real = actual.get(phase);
      if (real === undefined) continue;
      diffs.push(...setDiff(`phase map Fase ${phase}`, listed, `backlog Fase ${phase}`, real));
    }
    expect(diffs).toEqual([]);
  });
});
