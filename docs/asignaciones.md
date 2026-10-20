# Asignaciones de las Fases 7 a 12

Quién hace cada tarea de las ramas de grupo (protocolo §5.2). La rama de cada tarea la dice
[`tools/sdd/branch-groups.json`](../tools/sdd/branch-groups.json); aquí solo va la persona. Los agentes leen
esta tabla con `node tools/sdd/coordinate.mjs` de su copia local, que actualizan antes de cada tarea. Un cambio
de reparto se hace en un commit `chore(sdd):` aparte, se sube a las dos ramas de grupo y se avisa al equipo.

Formato de cada fila: `| TASK-NNN | @usuario |` o un rango `TASK-NNN..TASK-MMM` (incluye los dos extremos).
Una tarea va en una sola fila. Las tareas ya cerradas pueden quedarse en la tabla.

El reparto sale de las cadenas de dependencias de `tasks.md`: la Fase 7 es de Sebastián, que ya la
estaba haciendo, y las otras 57 tareas se reparten 19 por persona. Las que dependen entre sí van a la misma
persona cuando se puede, y nadie se queda sin trabajo esperando a otro si las tareas duran lo mismo. A grandes
rasgos: Alejandro lleva tasas, monedas y cuentas; Sebastián, el dominio de saldos, categorías y atajos;
Matías, repositorios, movimientos y Registrar.

| Tareas             | Persona           | Fase | Qué son                                                            |
| ------------------ | ----------------- | ---- | ------------------------------------------------------------------ |
| TASK-068..TASK-076 | @SebastianCatunta | 7    | Fase 7 completa: ajustes, navegación, perfil y eliminar la cuenta  |
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
