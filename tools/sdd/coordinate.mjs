#!/usr/bin/env node
// Coordinación entre personas en las ramas de grupo (protocolo §5.2).
//   node tools/sdd/coordinate.mjs next [--no-fetch]          → qué me toca ahora (JSON)
//   node tools/sdd/coordinate.mjs wait [--interval 180] [--max-hours 12]
//                                                            → espera hasta que me toque algo (JSON al final)
//   node tools/sdd/coordinate.mjs status [--no-fetch]        → qué le toca a cada persona (JSON)
// Quién soy: `git config sdd.member <usuario-de-github>` o, si no está, el usuario de `gh`.
// Las asignaciones se leen de docs/asignaciones.md en la copia local; el estado de cada tarea, del tasks.md
// de cada rama en origin.
import { allTasks, featureDirs, loadBranchGroups, parseTasks, tasksPath } from './lib/tasks.mjs';
import { ASSIGNMENTS, nextStep, parseAssignments } from './lib/coordination.mjs';
import { loadState } from './lib/state.mjs';
import { currentBranch, exists, fail, git, printJson, readText, sh } from './lib/repo.mjs';

const [cmd = 'next', ...rest] = process.argv.slice(2);
const flag = (name) => rest.includes(`--${name}`);
const option = (name, fallback) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 && rest[i + 1] !== undefined ? Number(rest[i + 1]) : fallback;
};

function whoami() {
  const configured = git('config --get sdd.member');
  if (configured.code === 0 && configured.output.trim()) return configured.output.trim();
  const gh = sh('gh api user --jq .login');
  if (gh.code === 0 && gh.output.trim()) return gh.output.trim();
  fail('No sé quién eres. Configúralo una vez con: git config sdd.member <tu-usuario-de-github>');
}

/** Contenido de un archivo en una rama de origin, o null si la rama o el archivo no existen. */
function showRemote(branch, path) {
  const r = git(`show "origin/${branch}:${path}"`);
  return r.code === 0 ? r.output.replace(/\r\n/g, '\n') : null;
}

function assignments() {
  if (!exists(ASSIGNMENTS)) fail(`No hay asignaciones: falta ${ASSIGNMENTS}. ¿Estás en una rama de grupo actualizada?`);
  try {
    return parseAssignments(readText(ASSIGNMENTS));
  } catch (e) {
    fail(`${ASSIGNMENTS}: ${e.message}`);
  }
}

function read({ fetch }) {
  if (fetch) git('fetch --quiet origin');
  const groups = loadBranchGroups();
  const tasks = allTasks();
  const branches = [...new Set([...groups.map((g) => g.branch), 'develop'])];
  const sources = branches.flatMap((branch) =>
    featureDirs().flatMap((f) => {
      const text = showRemote(branch, tasksPath(f));
      return text === null ? [] : [{ branch, tasks: parseTasks(text, f) }];
    }),
  );
  // La copia local cuenta como su rama: una tarea recién cerrada aquí se ve aunque todavía no se haya subido.
  sources.push({ branch: currentBranch(), tasks });
  return { groups, tasks, sources, assignments: assignments() };
}

const step = (member, data) => nextStep({ member, ...data, active: loadState() });

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

switch (cmd) {
  case 'next': {
    printJson(step(whoami(), read({ fetch: !flag('no-fetch') })));
    break;
  }
  case 'wait': {
    const member = whoami();
    const intervalMs = option('interval', 180) * 1000;
    const deadline = Date.now() + option('max-hours', 12) * 3_600_000;
    for (;;) {
      const result = step(member, read({ fetch: true }));
      if (result.action !== 'wait') {
        printJson(result);
        break;
      }
      const pending = result.blocked[0].waitingOn.map((w) => `${w.task} (${w.owner})`).join(', ');
      process.stderr.write(`${new Date().toISOString()} ${result.blocked[0].task} espera a ${pending}\n`);
      if (Date.now() + intervalMs > deadline) {
        printJson({ ...result, action: 'timeout' });
        break;
      }
      sleep(intervalMs);
    }
    break;
  }
  case 'status': {
    const data = read({ fetch: !flag('no-fetch') });
    const members = [...new Set(data.assignments.values())].sort();
    const closed = new Set(data.sources.flatMap((s) => s.tasks.filter((x) => x.done).map((x) => x.id)));
    const grouped = new Set(data.groups.flatMap((g) => g.tasks));
    printJson({
      members: members.map((m) => {
        const s = nextStep({ member: m, ...data });
        const total = [...data.assignments.values()].filter((x) => x === m).length;
        return { member: m, open: s.mine.length, total, action: s.action, task: s.task ?? s.blocked?.[0]?.task ?? null };
      }),
      // Tareas abiertas de un grupo que nadie tiene: quien dependa de ellas queda trabado.
      unassigned: data.tasks.filter((x) => grouped.has(x.id) && !closed.has(x.id) && !data.assignments.has(x.id)).map((x) => x.id),
    });
    break;
  }
  default:
    fail('Uso: node tools/sdd/coordinate.mjs <next|wait|status> [--no-fetch] [--interval s] [--max-hours h]');
}
