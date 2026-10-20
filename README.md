# App de Finanzas Personales

[![ci](https://github.com/matiasmm1011/AppDeFinanzasPersonales/actions/workflows/ci.yml/badge.svg?branch=develop)](https://github.com/matiasmm1011/AppDeFinanzasPersonales/actions/workflows/ci.yml)

Aplicación web para que una persona en Bolivia lleve sus finanzas personales en bolivianos y dólares, con el tipo de cambio paralelo y el oficial. El principio rector es que **registrar un movimiento siempre sea rápido y simple** ([constitución §1](docs/constitution.md)).

## Despliegues

Son tres despliegues separados, cada uno en su servicio, y se actualizan solos desde `main` con [`deploy.yml`](#integración-y-despliegue-continuos):

| Parte                          | Servicio | URL                                 | Se verifica con                    |
| ------------------------------ | -------- | ----------------------------------- | ---------------------------------- |
| **Frontend** (React + Vite)    | Vercel   | _pendiente del primer despliegue_   | `GET <web>/` → 200                 |
| **Backend** (Express API)      | Render   | _pendiente del primer despliegue_   | `GET <api>/api/health` → 204       |
| **Base de datos** (PostgreSQL) | Neon     | sin URL pública: solo la usa el API | `GET <api>/api/health/ready` → 204 |

### Cómo se conectan

```mermaid
flowchart LR
  U[Navegador] -->|HTML y JS| WEB["Frontend<br/>Vercel"]
  U -->|/api/* con cookie propia| WEB
  WEB -->|rewrite /api/*| API["Backend<br/>Render"]
  API -->|DATABASE_URL, con pooler| DB[("Base de datos<br/>Neon")]
  CRON[cron-job.org] -->|POST /internal/jobs/tick| API
```

- **Frontend → Backend:** Vercel reenvía `/api/*` al API de Render. El navegador solo ve el dominio de la web, así que no hace falta CORS y la cookie de sesión funciona también en Safari (ADR-02).
- **Backend → Base de datos:** el API usa `DATABASE_URL` (con el pooler de Neon). Las migraciones usan `DATABASE_URL_DIRECT`.
- **Prueba de punta a punta:** cada despliegue corre cuatro pruebas de humo, una por enlace. La última, `GET <web>/api/health/ready` → 204, pasa por la web, el API y la base de datos a la vez. Para mostrarlo, basta con abrir esa URL en el navegador.

## Equipo

| Integrante | GitHub                                                   | Trabajo principal                                                               |
| ---------- | -------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Matías     | [@matiasmm1011](https://github.com/matiasmm1011)         | Fase 0 (cimientos), Fase 2 (contratos), Fase 4 (base del API) y el pipeline SDD |
| Alejandro  | [@alejandrorozich](https://github.com/alejandrorozich)   | Fase 1 (esquema de datos)                                                       |
| Sebastián  | [@SebastianCatunta](https://github.com/SebastianCatunta) | Fase 3 (dominio transversal)                                                    |

**Docente:** _pendiente: agregarlo como colaborador del repositorio_.

## Stack

| Capa          | Tecnología                                                           |
| ------------- | -------------------------------------------------------------------- |
| Lenguaje      | TypeScript en un monorepo pnpm                                       |
| Frontend      | React + Vite, Tailwind CSS + shadcn/ui, TanStack Query, React Router |
| Backend       | Node.js + Express, Prisma, Zod, Better Auth                          |
| Base de datos | PostgreSQL 16 (Neon en producción, Docker en local)                  |
| Dinero        | decimal.js: nunca punto flotante                                     |
| Pruebas       | Vitest (unitarias, integración y contratos HTTP) y Playwright (E2E)  |
| Despliegue    | Vercel (web), Render (API), Neon (BD) y GitHub Actions               |

El backend está en cuatro capas (presentación → aplicación → dominio, más infraestructura), y dependency-cruiser verifica las reglas entre ellas en CI. Detalle en el [plan §1.4](001-appFinanzas-mvp/plan.md).

## Estructura

```
apps/api           API Express en capas (presentation, application, domain, infrastructure)
apps/web           SPA React + Vite
packages/contracts Schemas Zod compartidos por la web y el API
packages/domain    Reglas puras: dinero, fechas y formatos
packages/db        Prisma: schema, migraciones y seed
packages/config    TypeScript, ESLint y Vitest compartidos
docs/              Constitución y protocolo de ejecución con agentes
001-appFinanzas-mvp/  spec.md, plan.md y tasks.md de la funcionalidad
tools/sdd/         Scripts del pipeline de tareas (gates, check, cierre, pre-push)
.claude/           Hooks, subagentes y la skill /implement-task
```

## Cómo correrlo en local

Hace falta tener Node 22 (`.nvmrc`), corepack (trae pnpm) y Docker.

```bash
corepack enable
pnpm install
docker compose up -d
cp .env.example .env
```

En `.env`, completa `DATABASE_URL` y `DATABASE_URL_DIRECT` con `postgresql://postgres:postgres@localhost:5432/finanzas_dev`, `TEST_DATABASE_URL` con la base `finanzas_test`, `RELEASE=1.0` y cualquier valor no vacío en los secretos. Con `INTEGRATIONS=fake` no se manda ningún correo real.

```bash
set -a; . ./.env; set +a
pnpm --filter @finanzas/db generate
pnpm --filter @finanzas/db migrate:deploy
pnpm --filter api exec tsx --env-file=../../.env src/main.ts
pnpm --filter web dev
```

La web queda en <http://localhost:5173>, y el proxy de Vite manda `/api` al API, en el puerto 3000.

## Pruebas y calidad

| Comando                       | Qué revisa                                               |
| ----------------------------- | -------------------------------------------------------- |
| `pnpm lint`                   | ESLint estricto, sin textos sueltos en la interfaz       |
| `pnpm typecheck`              | Tipos estrictos en todo el monorepo                      |
| `pnpm depcruise`              | Reglas de capas del backend                              |
| `pnpm test:unit`              | Pruebas unitarias                                        |
| `pnpm test:integration`       | Integración contra Postgres (con `docker compose up -d`) |
| `node --test tools/sdd/test/` | Pruebas de los scripts del pipeline                      |

Cada regla de negocio tiene su prueba, y el nombre de cada caso lleva el ID que verifica (`RF-M4-04 …`, `TASK-038 …`).

## Integración y despliegue continuos

```mermaid
flowchart LR
  F[feature/* · fix/*] -- PR + ci --> DEV[develop]
  DEV -- PR + ci --> QA[qa]
  QA -- PR + ci --> MAIN[main]
  MAIN -- push --> DEP[deploy.yml]
  DEP --> MIG[migraciones en Neon] --> REN[API en Render] --> VER[web en Vercel] --> SMK[4 pruebas de humo]
```

| Workflow                             | Cuándo corre                      | Qué hace                                                                                                                                             | Estado   |
| ------------------------------------ | --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| [`ci.yml`](.github/workflows/ci.yml) | En cada push y PR                 | Instalación, commitlint, lint, typecheck, dependency-cruiser, unitarias, integración con Postgres 16 y build                                         | Activo   |
| `deploy.yml`                         | En cada push a `main` y a mano    | CI, luego migraciones, despliegue del API, despliegue de la web y pruebas de humo. Si un paso falla, se detiene y queda en línea la versión anterior | TASK-173 |
| `qa-e2e.yml`                         | En cada push a `qa` y PR a `main` | E2E con Playwright, accesibilidad y rendimiento en un entorno efímero                                                                                | TASK-172 |

Las ramas siguen Git Flow ([constitución §7](docs/constitution.md)): `feature/*` sale de `develop` y vuelve por PR. La promoción es `develop` → `qa` → `main`, siempre por PR. Los commits siguen Conventional Commits.

## Desarrollo guiado por especificaciones (SDD) con agentes

Toda funcionalidad sigue el orden **especificación → plan → tareas → implementación**. Cada tarea de [`tasks.md`](001-appFinanzas-mvp/tasks.md) se implementa con la skill `/implement-task TASK-NNN`, que reparte el trabajo entre tres subagentes:

```mermaid
flowchart LR
  P[preflight] --> T[test-author<br/>pruebas en rojo] --> GA{Gate A}
  GA --> I[implementer<br/>código en verde] --> GB{Gate B}
  GB --> A[sdd-auditor<br/>solo lectura] -->|APPROVED| C[commit de la tarea]
  A -->|CHANGES_REQUIRED| I
```

| Subagente     | Qué hace                                                                    |
| ------------- | --------------------------------------------------------------------------- |
| `test-author` | Escribe las pruebas a partir de la spec, antes del código                   |
| `implementer` | Escribe el código hasta poner las pruebas en verde, sin tocarlas            |
| `sdd-auditor` | Audita el cambio contra la constitución, la spec y el plan. No escribe nada |

| Hook                                           | Cuándo corre                             | Qué hace                                                                                                                                                                          |
| ---------------------------------------------- | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SubagentStop` → `tools/sdd/gate.mjs`          | Cuando termina un subagente del pipeline | Aplica el gate de la etapa: alcance de archivos, IDs en las pruebas, tipos, lint, capas, pruebas y comandos. Si falla, el subagente sigue trabajando, con un máximo de 3 intentos |
| `SessionStart` → `tools/sdd/session-brief.mjs` | Al abrir o retomar una sesión de Claude  | Resume la rama, la tarea activa, el avance y las próximas tareas disponibles                                                                                                      |
| `pre-push` de git → `tools/sdd/pre-push.mjs`   | Antes de cada push                       | Commitlint, secretos y trazabilidad de las tareas, en segundos. La suite completa la corre CI                                                                                     |

Antes de terminar, cada subagente corre `node tools/sdd/check.mjs`, que aplica los mismos controles del gate sin gastar intentos. El detalle está en el [protocolo de ejecución](docs/execution-protocol.md).

## Secretos y variables

Ningún secreto se versiona. `.gitignore` excluye todo `.env*` salvo [`.env.example`](.env.example), y el `pre-push` rechaza archivos `.env`, claves y URLs de base de datos con contraseña.

| Variable                                                                                                                                     | Local  | Producción                                                    |
| -------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ------------------------------------------------------------- |
| `DATABASE_URL`, `AUTH_SECRET`, `HMAC_SECRET`, `JOBS_SECRET`, `RESEND_API_KEY`, `RELEASE`, `WEB_ORIGIN`, `INTEGRATIONS`                       | `.env` | Variables del servicio en Render                              |
| `DATABASE_URL_DIRECT`, `RENDER_DEPLOY_HOOK_URL`, `RENDER_API_KEY`, `RENDER_SERVICE_ID`, `VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID` | —      | Secretos del Environment `production` de GitHub (solo `main`) |
| `WEB_URL`, `API_URL`                                                                                                                         | —      | Variables del Environment `production`                        |

## Puesta en marcha del despliegue (una sola vez)

Los agentes no pueden crear cuentas ni cargar secretos, así que estos pasos los hace una persona. Cada uno está detallado en los «Pasos manuales» de [TASK-171, TASK-172, TASK-173 y TASK-174](001-appFinanzas-mvp/tasks.md):

1. **Neon:** crear el proyecto y guardar las URLs con pooler y directa.
2. **Resend:** crear la API key.
3. **Secretos de la app:** generar `AUTH_SECRET`, `HMAC_SECRET` y `JOBS_SECRET` con `openssl rand -base64 32`.
4. **Vercel:** `vercel link` en la raíz, crear el token y anotar `WEB_URL`.
5. **Render:** crear el Blueprint desde `render.yaml` (rama `main`), cargar las variables y anotar `API_URL`, el Deploy Hook, la API key y el ID del servicio.
6. **GitHub:** crear el Environment `production` con sus secretos y variables, y proteger `develop`, `qa` y `main` con el check `ci`.
7. **cron-job.org:** programar `POST $API_URL/internal/jobs/tick` cada minuto, con `x-jobs-secret`, `Content-Type: application/json` y el cuerpo `{}`.
8. **Primer despliegue:** promover `develop` → `qa` → `main` por PR y revisar el workflow `deploy` en Actions.

## Estado del proyecto

Avance real al 2026-10-19: **38 de 247 tareas cerradas (15 %)**. El hook `SessionStart` muestra el valor actualizado en cada sesión.

| Entrega | Fases                                                                                                                                     | Tareas cerradas |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| Base    | 0 a 5: cimientos, esquema, contratos, dominio, API y web                                                                                  | 38 / 46         |
| V1.0    | 6 a 17: acceso, navegación, monedas, cuentas, categorías, transacciones, registrar, inicio, ajustes, onboarding, exportación y despliegue | 0 / 128         |
| V1.1    | 18 a 22: avisos, metas, presupuestos y deudas                                                                                             | 0 / 48          |
| V1.2    | 23 a 25: recurrentes, recordatorios y validación final                                                                                    | 0 / 25          |

Las Fases 0 a 4 están completas. Lo siguiente es el despliegue temprano (TASK-171 y TASK-173) y la base de la web (Fase 5).

## Documentación

- [Constitución](docs/constitution.md): principios que no cambian.
- [Especificación](001-appFinanzas-mvp/spec.md): el qué y el porqué.
- [Plan técnico](001-appFinanzas-mvp/plan.md): el cómo, con las decisiones de arquitectura (ADR).
- [Tareas](001-appFinanzas-mvp/tasks.md): el backlog atómico.
- [Protocolo de ejecución con agentes](docs/execution-protocol.md): el pipeline, sus hooks y sus gates.
