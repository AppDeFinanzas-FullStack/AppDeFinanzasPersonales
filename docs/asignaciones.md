# Asignaciones de las Fases 7 a 25

Quién hace cada tarea de las ramas de grupo (protocolo §5.2). La rama de cada tarea la dice
[`tools/sdd/branch-groups.json`](../tools/sdd/branch-groups.json); aquí solo va la persona. Los agentes leen
esta tabla con `node tools/sdd/coordinate.mjs` de su copia local, que actualizan antes de cada tarea. Un cambio
de reparto se hace en un commit `chore(sdd):` aparte, se sube a las ramas de grupo abiertas y se avisa al equipo.

Formato de cada fila: `| TASK-NNN | @usuario |` o un rango `TASK-NNN..TASK-MMM` (incluye los dos extremos).
Una tarea va en una sola fila. Las tareas ya cerradas pueden quedarse en la tabla.

El reparto sale de las cadenas de dependencias de `tasks.md`. La Fase 7 es de Sebastián, que ya la
estaba haciendo, salvo TASK-074 (Alejandro) y TASK-075 (Matías). Las otras 57 tareas se reparten 19 por
persona: las que dependen entre sí van a la misma persona cuando se puede, y nadie se queda sin trabajo
esperando a otro si las tareas duran lo mismo. A grandes rasgos: Alejandro lleva tasas, monedas y cuentas;
Sebastián, el dominio de saldos, categorías y atajos; Matías, repositorios, movimientos y Registrar.

El reparto de las Fases 14 a 25 y su criterio están en [`asignaciones-fases-14-25.md`](asignaciones-fases-14-25.md);
aquí solo van las Fases 20 a 25, porque las 14 a 19 ya están cerradas en `develop`.
Las Fases 20 a 25 son cada una una rama de grupo con el nombre de su rama de fase, para que `coordinate.mjs` vea
las tareas que cada persona cierra en ellas; la 23 la comparten Alejandro (backend) y Sebastián (web).

| Tareas             | Persona           | Fase | Qué son                                                            |
| ------------------ | ----------------- | ---- | ------------------------------------------------------------------ |
| TASK-068..TASK-073 | @SebastianCatunta | 7    | Ajustes, guardas de rutas, AppShell y menú «Más»                   |
| TASK-074           | @alejandrorozich  | 7    | Web: pantalla de perfil                                            |
| TASK-075           | @matiasmm1011     | 7    | Web: bloqueo sin conexión y diálogo de sesión vencida              |
| TASK-076           | @SebastianCatunta | 7    | Web: eliminar la cuenta                                            |
| TASK-085..TASK-090 | @alejandrorozich  | 8    | RatesService, endpoints de tasas, dólar de referencia y monedas    |
| TASK-092..TASK-095 | @alejandrorozich  | 8    | Web: ficha del dólar, panel de Tipo de cambio, gráfico y monedas   |
| TASK-096..TASK-098 | @SebastianCatunta | 9    | Contratos de M4 y dominio `balance`                                |
| TASK-099..TASK-100 | @matiasmm1011     | 9    | Repositorios de cuentas y del libro contable; BalanceGuard         |
| TASK-101..TASK-108 | @alejandrorozich  | 9    | AccountsService, rutas de cuentas y su web                         |
| TASK-109           | @SebastianCatunta | 10   | Contratos de M5                                                    |
| TASK-110           | @matiasmm1011     | 10   | Repositorio de categorías                                          |
| TASK-111..TASK-117 | @SebastianCatunta | 10   | CategoriesService, rutas de categorías y su web                    |
| TASK-118           | @SebastianCatunta | 11   | Contratos de M6                                                    |
| TASK-119           | @matiasmm1011     | 11   | Repositorio del libro contable: lista, búsqueda y totales          |
| TASK-120           | @SebastianCatunta | 11   | LedgerHooks y registro de deshacer                                 |
| TASK-121..TASK-129 | @matiasmm1011     | 11   | TransactionsService, rutas y _job_ de movimientos; web de la lista |
| TASK-130           | @SebastianCatunta | 11   | Web: selección y acciones en lote                                  |
| TASK-131..TASK-132 | @matiasmm1011     | 11   | Web: detalle, edición y «Deshacer» de un movimiento                |
| TASK-133           | @alejandrorozich  | 11   | Web: movimientos en el detalle de una cuenta                       |
| TASK-134           | @SebastianCatunta | 12   | Contratos de M7                                                    |
| TASK-135           | @matiasmm1011     | 12   | Contexto de Registrar y movimientos de hoy                         |
| TASK-136           | @SebastianCatunta | 12   | Atajos: crear, editar, reordenar y eliminar                        |
| TASK-137           | @matiasmm1011     | 12   | Web: Registrar gastos e ingresos                                   |
| TASK-138..TASK-140 | @SebastianCatunta | 12   | Web: transferencias, segundo nivel de Registrar y fichas de atajos |
| TASK-141..TASK-142 | @matiasmm1011     | 12   | Web: errores, estados vacíos y después de guardar en Registrar     |
| TASK-193..TASK-207 | @SebastianCatunta | 20   | Presupuestos: períodos, umbrales, cierre, _jobs_, rutas y su web   |
| TASK-208..TASK-218 | @alejandrorozich  | 21   | Deudas y préstamos: interés, pagos, vencimientos, rutas y su web   |
| TASK-219..TASK-222 | @matiasmm1011     | 22   | Bloques del Inicio de V1.1, exportadores y regresión               |
| TASK-223..TASK-233 | @alejandrorozich  | 23   | Recurrentes (backend): reglas, ocurrencias, _jobs_ y rutas         |
| TASK-234..TASK-236 | @SebastianCatunta | 23   | Recurrentes (web): pantalla, formulario y pendientes en la bandeja |
| TASK-237..TASK-242 | @alejandrorozich  | 24   | Recordatorios: preferencias, avisos programados, web, exportadores |
| TASK-243..TASK-247 | @matiasmm1011     | 25   | Final: Gherkin, _jobs_ interrumpidos, zonas horarias, concurrencia |
