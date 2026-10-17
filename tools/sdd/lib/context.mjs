// Paquete de contexto de una tarea (docs/execution-protocol.md §2.3).
import { join } from 'node:path';
import { readText, exists, writeText } from './repo.mjs';
import { taskDir, lastFindings } from './state.mjs';
import { isTestFile } from './scope.mjs';

/** Extrae una sección numerada del plan ("4.6.2") con sus subsecciones. */
export function planSection(planText, number) {
  const lines = planText.split('\n');
  const head = new RegExp(`^(#{2,4}) ${number.replace(/\./g, '\\.')}\\.?\\s`);
  const start = lines.findIndex((l) => head.test(l));
  if (start < 0) return null;
  const level = lines[start].match(/^#+/)[0].length;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const m = lines[i].match(/^(#+) /);
    if (m && m[1].length <= level) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join('\n').trim();
}

/** Las secciones citadas, sin repetir las que ya contiene una sección padre citada. */
export function dedupeSections(numbers) {
  return numbers.filter((n) => !numbers.some((o) => o !== n && n.startsWith(`${o}.`)));
}

export function adrRow(planText, adr) {
  return planText.split('\n').find((l) => l.startsWith(`| ${adr} |`)) ?? null;
}

/** Texto literal de una regla de la spec (RN, RF, EC o RNF), con sus viñetas anidadas. */
export function specItem(specText, id) {
  const lines = specText.split('\n');
  const start = lines.findIndex((l) => new RegExp(`^\\s*- \\*\\*${id}:\\*\\*`).test(l));
  if (start < 0) return null;
  const out = [lines[start]];
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    if (/^\s*- \*\*(RNF|RN|RF|EC)-/.test(l) || /^#/.test(l) || /^```/.test(l) || /^---/.test(l)) break;
    out.push(l);
  }
  return out.join('\n').trimEnd();
}

export function scenario(specText, title) {
  const lines = specText.split('\n');
  const start = lines.findIndex((l) => l.trim() === `Escenario: ${title}`);
  if (start < 0) return null;
  const out = [lines[start]];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^Escenario:/.test(lines[i]) || /^```/.test(lines[i])) break;
    out.push(lines[i]);
  }
  return out.join('\n').trimEnd();
}

function planConventions(planText) {
  const m = planText.match(/Convenciones de este documento:\n([\s\S]*?)\n---/);
  return m ? m[1].trim() : '';
}

/** Construye context.md de la tarea y devuelve su ruta. */
export function buildContext(task, { round = 0 } = {}) {
  const constitution = readText('docs/constitution.md');
  const planFile = `${task.feature}/plan.md`;
  const specFile = `${task.feature}/spec.md`;
  const plan = exists(planFile) ? readText(planFile) : '';
  const spec = exists(specFile) ? readText(specFile) : '';

  const sections = dedupeSections(task.planSections)
    .map((n) => planSection(plan, n) ?? `> plan §${n}: no se encontró la sección.`)
    .join('\n\n');
  const adrs = task.adrs.map((a) => adrRow(plan, a) ?? `> ${a}: no se encontró.`);
  const rules = task.specIds.map((id) => specItem(spec, id) ?? `> ${id}: no se encontró en la spec.`).join('\n\n');
  const scenarios = task.scenarios.map((t) => scenario(spec, t) ?? `> Escenario "${t}": no se encontró en la spec.`);
  const testFiles = task.scope.filter(isTestFile);
  const implFiles = task.scope.filter((p) => !isTestFile(p));

  const parts = [
    `# Paquete de contexto — ${task.id}: ${task.title}`,
    `Fase ${task.phase.number} — ${task.phase.name}. Lee este archivo completo antes de empezar.`,
    '## 1. La tarea (tasks.md)',
    task.raw,
    '## 2. Archivos en alcance',
    `- **Archivos de test** (los escribe test-author y quedan bloqueados después): ${testFiles.length ? testFiles.map((f) => `\`${f}\``).join(', ') : 'ninguno'}`,
    `- **Archivos de implementación** (los escribe implementer): ${implFiles.length ? implFiles.map((f) => `\`${f}\``).join(', ') : 'ninguno'}`,
    'Ningún otro archivo del repositorio se puede crear, modificar ni borrar. Se puede leer cualquier archivo.',
    '## 3. Reglas de la spec citadas (texto literal)',
    rules || '_La tarea no cita reglas de la spec._',
    scenarios.length ? `## 4. Escenarios Gherkin citados\n\n\`\`\`gherkin\n${scenarios.join('\n\n')}\n\`\`\`` : '## 4. Escenarios Gherkin citados\n\n_Ninguno._',
    '## 5. Plan técnico: convenciones y secciones citadas',
    planConventions(plan),
    adrs.length ? `Decisiones citadas:\n\n| ID | Decisión | Motivo | Alternativas descartadas |\n|---|---|---|---|\n${adrs.join('\n')}` : '',
    sections || '_La tarea no cita secciones del plan._',
    '## 6. Constitución del proyecto',
    constitution,
  ];

  if (round > 0) {
    const findings = lastFindings(task.id);
    parts.push(`## 7. Hallazgos de la auditoría anterior (ronda ${round})`, findings ?? '_No se encontraron hallazgos._', 'Corrige cada hallazgo sin salir del alcance ni tocar las pruebas.');
  }

  const file = join(taskDir(task.id), 'context.md');
  writeText(file, `${parts.filter(Boolean).join('\n\n')}\n`);
  return file;
}
