# App de Finanzas Personales

[![ci](https://github.com/AppDeFinanzas-FullStack/AppDeFinanzasPersonales/actions/workflows/ci.yml/badge.svg?branch=develop)](https://github.com/AppDeFinanzas-FullStack/AppDeFinanzasPersonales/actions/workflows/ci.yml) [![deploy](https://github.com/AppDeFinanzas-FullStack/AppDeFinanzasPersonales/actions/workflows/deploy.yml/badge.svg?branch=main)](https://github.com/AppDeFinanzas-FullStack/AppDeFinanzasPersonales/actions/workflows/deploy.yml)

Aplicación web para que una persona en Bolivia lleve sus finanzas personales en bolivianos y dólares, con el tipo de cambio paralelo y el oficial. El principio rector es que **registrar un movimiento siempre sea rápido y simple** ([constitución §1](docs/constitution.md)).

## Despliegues

Son tres despliegues separados, cada uno en su servicio, y se actualizan solos desde `main` con [`deploy.yml`](#integración-y-despliegue-continuos):

| Parte                          | Servicio | URL                                     | Se verifica con                    |
| ------------------------------ | -------- | --------------------------------------- | ---------------------------------- |
| **Frontend** (React + Vite)    | Vercel   | <https://finanzas-web-orpin.vercel.app> | `GET <web>/` → 200                 |
| **Backend** (Express API)      | Render   | <https://finanzas-api-va.onrender.com>  | `GET <api>/api/health` → 204       |
| **Base de datos** (PostgreSQL) | Neon     | sin URL pública: solo la usa el API     | `GET <api>/api/health/ready` → 204 |

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
- **Prueba de punta a punta:** cada despliegue corre cuatro pruebas de humo, una por enlace. La última, `GET <web>/api/health/ready` → 204, pasa por la web, el API y la base de datos a la vez. Para mostrarlo, basta con abrir <https://finanzas-web-orpin.vercel.app/api/health/ready> en el navegador: responde vacío (204) si todo está conectado.

## Equipo

| Integrante | GitHub                                                   | Trabajo principal                                                                                               |
| ---------- | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Matías     | [@matiasmm1011](https://github.com/matiasmm1011)         | Cimientos, contratos, base del API, pipeline SDD, ajustes, onboarding, cierre de V1.0 y V1.1 y validación final |
| Alejandro  | [@alejandrorozich](https://github.com/alejandrorozich)   | Esquema de datos, exportación, bandeja de avisos, deudas, recurrentes (backend) y recordatorios                 |
| Sebastián  | [@SebastianCatunta](https://github.com/SebastianCatunta) | Dominio transversal, web y monedas, metas de ahorro, presupuestos y recurrentes (web)                           |

El reparto de las Fases 14 a 25 está en [`docs/asignaciones-fases-14-25.md`](docs/asignaciones-fases-14-25.md).

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
docs/              Constitución, protocolo de ejecución, dirección de diseño y asignaciones
001-appFinanzas-mvp/  spec.md, plan.md y tasks.md de la funcionalidad
e2e/               Pruebas E2E con Playwright (accesibilidad y rendimiento incluidos)
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
| `pnpm --filter e2e test`      | E2E con Playwright (Chromium, WebKit y Firefox)          |
| `node --test tools/sdd/test/` | Pruebas de los scripts del pipeline                      |

Cada regla de negocio tiene su prueba, y el nombre de cada caso lleva el ID que verifica (`RF-M4-04 …`, `TASK-038 …`).

Dentro de `pnpm test:unit`, [`sdd-coherence.test.ts`](apps/api/test/unit/sdd-coherence.test.ts) compara la spec, el plan y `tasks.md` con el código: tipos de correo, endpoints, códigos de error, tablas, matriz de trazabilidad, variables de entorno, IDs citados, versiones y mapa de fases. Si un documento y el código se separan, la prueba falla y lista cada diferencia. La revisión manual de cada requisito está en [`coherencia.md`](001-appFinanzas-mvp/coherencia.md).

Cada respuesta de la API trae `Server-Timing` (tiempo total, tiempo en la base y número de consultas). Para reproducir en local la distancia a Neon, `DB_LATENCY_MS` agrega esa latencia a cada consulta (solo fuera de producción).

## Integración y despliegue continuos

```mermaid
flowchart LR
  F[feature/* · fix/*] -- PR + ci --> DEV[develop]
  DEV -- PR + ci --> QA[qa]
  QA -- PR + ci --> MAIN[main]
  MAIN -- push --> DEP[deploy.yml]
  DEP --> MIG[migraciones en Neon] --> REN[API en Render] --> VER[web en Vercel] --> SMK[4 pruebas de humo]
```

| Workflow                                               | Cuándo corre                      | Qué hace                                                                                                                                             | Estado |
| ------------------------------------------------------ | --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| [`ci.yml`](.github/workflows/ci.yml)                   | En cada push y PR                 | Instalación, commitlint, lint, typecheck, dependency-cruiser, unitarias, integración con Postgres 16 y build                                         | Activo |
| [`deploy.yml`](.github/workflows/deploy.yml)           | En cada push a `main` y a mano    | CI, luego migraciones, despliegue del API, despliegue de la web y pruebas de humo. Si un paso falla, se detiene y queda en línea la versión anterior | Activo |
| [`qa-e2e.yml`](.github/workflows/qa-e2e.yml)           | En cada push a `qa` y PR a `main` | E2E con Playwright, accesibilidad y rendimiento en un entorno efímero, en 3 navegadores a 360 px y 1280 px                                           | Activo |
| [`fx-backfill.yml`](.github/workflows/fx-backfill.yml) | Solo a mano                       | Carga única del historial de tipo de cambio en producción. Es idempotente                                                                            | Activo |

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
| `DATABASE_URL`, `AUTH_SECRET`, `HMAC_SECRET`, `JOBS_SECRET`, `RESEND_API_KEY`, `EMAIL_FROM`, `RELEASE`, `WEB_ORIGIN`, `INTEGRATIONS`         | `.env` | Variables del servicio en Render                              |
| `DATABASE_URL_DIRECT`, `RENDER_DEPLOY_HOOK_URL`, `RENDER_API_KEY`, `RENDER_SERVICE_ID`, `VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID` | —      | Secretos del Environment `production` de GitHub (solo `main`) |
| `NEON_API_KEY` y, opcional, `NEON_MCP_READONLY` (solo el [MCP de Neon](#mcp-de-neon-claude-code))                                            | `.env` | —                                                             |
| `WEB_URL`, `API_URL`                                                                                                                         | —      | Variables del Environment `production`                        |
| `TEST_DATABASE_URL` y, opcionales, `TEST_TIMEOUT_MS` (PC lenta) y `DB_LATENCY_MS` (latencia simulada)                                        | `.env` | —                                                             |

## MCP de Neon (Claude Code)

[`.mcp.json`](.mcp.json) conecta Claude Code con el servidor MCP de Neon para listar tablas, ver el esquema y consultar la base durante el desarrollo. Es solo para desarrollo local: la aplicación no lo lee y no se despliega.

1. Consigue una API key de Neon (**Settings → API keys**, en la consola). Si el proyecto de Neon es de otra persona, esa persona crea la clave, o te invita al proyecto para que crees la tuya. Pásala por un canal privado, nunca por el repositorio ni por un chat grupal.
2. Pégala en tu `.env` local como `NEON_API_KEY=…`. El archivo está en `.gitignore`: la clave no se versiona. En el repositorio solo está el nombre de la variable.
3. Reinicia Claude Code en la carpeta del proyecto, aprueba el servidor `neon` y comprueba que aparece conectado con `/mcp`.

Por defecto queda en **solo lectura**. Para permitir escrituras, agrega `NEON_MCP_READONLY=false` a tu `.env`. Cuidado con la base a la que apunta la clave: con escrituras habilitadas, el MCP puede modificarla.

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

Avance real al 2026-10-30: **274 de 274 tareas cerradas (100 %)**. La Fase 27 está en la rama `feature/27-pulido-transversal-rendimiento-correos`, pendiente de su PR a `develop`. El hook `SessionStart` muestra el valor actualizado en cada sesión.

| Entrega | Fases                                                                                                                                     | Tareas cerradas |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| Base    | 0 a 5: cimientos, esquema, contratos, dominio, API y web                                                                                  | 46 / 46         |
| V1.0    | 6 a 17: acceso, navegación, monedas, cuentas, categorías, transacciones, registrar, inicio, ajustes, onboarding, exportación y despliegue | 129 / 129       |
| V1.1    | 18 a 22: avisos, metas, presupuestos y deudas                                                                                             | 48 / 48         |
| V1.2    | 23 a 25: recurrentes, recordatorios y validación final                                                                                    | 25 / 25         |
| Pulido  | 26 y 27: correcciones de QA, rendimiento, correos de la cuenta, botón "Volver", marca y coherencia de la documentación                    | 26 / 26         |

Las tres entregas y el pulido están completos. La Fase 25 cerró la validación final: la regresión con todos los escenarios Gherkin, los jobs que se retoman tras una interrupción sin duplicar (RNF-13), las fechas de negocio en varias zonas horarias, la consistencia ante operaciones concurrentes y la accesibilidad y el control de versión de V1.2.

La Fase 27 pulió la app de punta a punta:

- **Rendimiento:** la sesión se resuelve en una consulta, las lecturas ya no bloquean por usuario, Inicio pide pocas consultas, la web pide los datos junto con la sesión, muestra esqueletos y precarga cada pestaña al elegirla. La API corre en Virginia, junto a Neon.
- **Correos de la cuenta:** ya no existe el correo de intentos fallidos (`login_alert`); quedan 5 tipos. El enlace de confirmación solo confirma, y la app que espera en "Revisa tu correo" continúa sola al Onboarding con un ticket de registro. Si en ese navegador había otra sesión abierta, se cierra y sus borradores se descartan.
- **Navegación y marca:** botón "Volver" en la cabecera de las pantallas internas, y el logo en la pestaña, las pantallas de acceso, el Onboarding y la cabecera.
- **Coherencia de la documentación:** la prueba automática y el informe descritos en [Pruebas y calidad](#pruebas-y-calidad); las 5 diferencias encontradas quedaron resueltas.

## Documentación

- [Constitución](docs/constitution.md): principios que no cambian.
- [Especificación](001-appFinanzas-mvp/spec.md): el qué y el porqué.
- [Plan técnico](001-appFinanzas-mvp/plan.md): el cómo, con las decisiones de arquitectura (ADR).
- [Tareas](001-appFinanzas-mvp/tasks.md): el backlog atómico.
- [Coherencia](001-appFinanzas-mvp/coherencia.md): cada requisito de la spec frente al código y sus pruebas.
- [Protocolo de ejecución con agentes](docs/execution-protocol.md): el pipeline, sus hooks y sus gates.
- [Dirección de diseño](docs/design-direction.md): la guía visual de la interfaz.
