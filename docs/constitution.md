# Constitución — App de Finanzas Personales

**Versión:** 1.2.0 · **Ratificada:** 2026-10-15 · **Última enmienda:** 2026-10-16

Principios innegociables del proyecto. Los DEBEN respetar todas las personas y agentes de IA que trabajen en él. El *qué* se define en cada especificación y el *cómo* en cada plan; este documento fija solo lo que no cambia.

## 1. Producto
- **Propósito:** que una persona en Bolivia lleve sus finanzas personales en bolivianos y dólares, con el tipo de cambio paralelo y el oficial.
- **Principio rector:** registrar un movimiento DEBE ser siempre rápido y simple. Ninguna funcionalidad puede volver más lento ni más complicado ese flujo.
- **Privacidad:** cada usuario ve y modifica SOLO sus propios datos, y puede exportarlos o borrarlos cuando quiera.
- **Plataforma:** aplicación web responsive y accesible, en español de Bolivia, con los textos preparados para traducirse.
- **Entregas incrementales:** V1.0 (núcleo) → V1.1 (presupuestos, metas, deudas y bandeja básica de avisos) → V1.2 (recurrentes y recordatorios completos). Cada entrega DEBE quedar usable antes de empezar la siguiente.
- **Avisos:** todos los avisos llegan solo dentro de la app. El correo se usa únicamente para la cuenta del usuario (confirmación, recuperación y seguridad).
- **Fuera de alcance:** reportes, inteligencia artificial, conexión con bancos, cuentas compartidas o roles, app nativa, notificaciones push, avisos por correo y modo sin conexión.

## 2. Stack tecnológico
- **Lenguaje:** TypeScript en todo el proyecto, organizado como monorepo.
- **Frontend:** React + Vite, Tailwind CSS + shadcn/ui, TanStack Query.
- **Backend:** Node.js + Express, Prisma, Zod.
- **Base de datos:** PostgreSQL.
- **Autenticación:** Better Auth.
- **Dinero:** decimal.js.
- **Correo (solo de cuenta):** Resend.
- **Tests:** Vitest y Playwright.
- **Despliegue:** Railway o Render (backend), Neon (base de datos), Vercel o Netlify (frontend).

Agregar una tecnología que reemplace o duplique alguna de estas requiere el acuerdo de todo el equipo.

## 3. Datos y dinero
- El dinero se calcula SIEMPRE con precisión decimal exacta, NUNCA con punto flotante. Los montos se redondean a dos decimales, con la mitad hacia arriba.
- La historia no se reescribe: un movimiento conserva el tipo de cambio con el que se registró, y los valores históricos no cambian por movimientos del dólar ni por cambios de configuración.
- Los saldos se calculan a partir de los movimientos y NUNCA se editan a mano.
- Las cuentas y categorías con movimientos se archivan, no se borran.
- Una misma acción repetida NUNCA genera registros duplicados, y un mismo evento NUNCA genera dos avisos.

## 4. Seguridad
- Toda entrada al sistema DEBE validarse. NUNCA se confía en lo que envía el cliente.
- La identidad del usuario sale SIEMPRE de su sesión, nunca de los datos que envía.
- NUNCA se exponen secretos, contraseñas ni detalles internos en el código, los logs ni los mensajes de error.

## 5. Calidad
- El código DEBE tener tipado estricto y pasar lint, verificación de tipos y tests antes de integrarse.
- Toda regla de negocio DEBE tener un test que la verifique.
- Todo acceso a datos DEBE tener un test que demuestre el aislamiento entre usuarios.
- El código se escribe en inglés y la interfaz en español.

## 6. Desarrollo guiado por especificaciones (SDD)
- Toda funcionalidad sigue este orden: **especificación → plan → tareas → implementación**.
- Cada funcionalidad vive en una carpeta `NNN-nombre/` en la raíz del proyecto, al mismo nivel que `docs/`, con su `spec.md`, `plan.md` y `tasks.md`.
- No se implementa nada sin una especificación aprobada por el equipo.
- Ante una ambigüedad, se pregunta. NUNCA se inventan reglas de negocio.
- Si un cambio contradice la especificación, primero se actualiza la especificación.
- Los agentes de IA pueden programar, ejecutar tests y hacer acciones de git, siguiendo esta Constitución y el flujo de §7.

## 7. Git Flow
- **`main`:** producción.
- **`qa`:** validación antes de producción.
- **`develop`:** integración.
- **`feature/*` y `fix/*`:** salen de `develop` y vuelven a `develop` por Pull Request.
- **Promoción:** `develop` → `qa` → `main`, siempre por Pull Request.
- **`hotfix/*`:** sale de `main` y se integra en `main`, `qa` y `develop`.
- Los commits siguen Conventional Commits.

## 8. Ejecución de tareas con agentes
- La unidad de trabajo es una tarea de `tasks.md`. Se implementa una tarea a la vez y solo dentro de los archivos que declara.
- Cada tarea pasa por el mismo pipeline: **pruebas primero → implementación → auditoría** contra esta Constitución, la especificación y el plan. Cada etapa la hace un agente distinto, con el contexto mínimo de la tarea.
- Lo que una máquina puede verificar lo verifican hooks deterministas, no un agente: alcance de archivos, lint, tipos, reglas de capas y tests.
- Una tarea se cierra solo con todas las verificaciones en verde y la auditoría aprobada, y queda en un commit propio que la referencia.
- Si un agente encuentra una ambigüedad o necesita salir del alcance, se detiene y pregunta (§6). Nunca se cambian el alcance ni las pruebas para que algo pase.
- Ningún guardarraíl se salta.
- El detalle operativo vive en `docs/execution-protocol.md`.

## 9. Enmiendas
Esta Constitución solo cambia con el acuerdo de todo el equipo. Cada cambio sube su número de versión.
