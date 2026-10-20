# Asignaciones de las Fases 7 a 12

Quién hace cada tarea de las ramas de grupo (protocolo §5.2). La rama de cada tarea la dice
[`tools/sdd/branch-groups.json`](../tools/sdd/branch-groups.json); aquí solo va la persona. Los agentes leen
esta tabla con `node tools/sdd/coordinate.mjs` de su copia local, que actualizan antes de cada tarea. Un cambio
de reparto se hace en un commit `chore(sdd):` aparte, se sube a las dos ramas de grupo y se avisa al equipo.

Formato de cada fila: `| TASK-NNN | @usuario |` o un rango `TASK-NNN..TASK-MMM` (incluye los dos extremos).
Una tarea va en una sola fila. Las tareas ya cerradas pueden quedarse en la tabla.

El reparto sale de las cadenas de dependencias de `tasks.md`: cada persona tiene 22 tareas, las que dependen
entre sí van a la misma persona cuando se puede, y nadie se queda sin trabajo esperando a otro si las tareas
duran lo mismo. A grandes rasgos: Matías lleva ajustes, tasas y cuentas; Alejandro, navegación y categorías;
Sebastián, movimientos.

| Tareas             | Persona           | Fase | Qué son                                                         |
| ------------------ | ----------------- | ---- | --------------------------------------------------------------- |
| TASK-068..TASK-070 | @matiasmm1011     | 7    | Contratos, servicio y rutas de ajustes; `useSettings` en la web |
| TASK-071           | @SebastianCatunta | 7    | Web: guardas de rutas                                           |
| TASK-072           | @matiasmm1011     | 7    | Web: AppShell, cabecera y barras                                |
| TASK-073..TASK-076 | @alejandrorozich  | 7    | Web: menú «Más», perfil, sin conexión y eliminar la cuenta      |
| TASK-085..TASK-086 | @matiasmm1011     | 8    | RatesService y endpoints de tasas                               |
| TASK-087           | @SebastianCatunta | 8    | Referencia del dólar, moneda base y valor manual                |
| TASK-088..TASK-089 | @matiasmm1011     | 8    | Monedas agregadas: crear, listar, desactivar y reactivar        |
| TASK-090           | @SebastianCatunta | 8    | Endpoint interno de prueba para fijar las tasas del _fake_      |
| TASK-092           | @matiasmm1011     | 8    | Web: `useCurrentRate` y ficha del dólar en la cabecera          |
| TASK-093..TASK-094 | @SebastianCatunta | 8    | Web: panel de Tipo de cambio y gráfico de tasas                 |
| TASK-095           | @matiasmm1011     | 8    | Web: lista de monedas                                           |
| TASK-096           | @alejandrorozich  | 9    | Contratos de M4                                                 |
| TASK-097..TASK-098 | @SebastianCatunta | 9    | Dominio `balance`: reglas, total neto y desglose                |
| TASK-099..TASK-100 | @alejandrorozich  | 9    | Repositorios de cuentas y del libro contable; BalanceGuard      |
| TASK-101..TASK-108 | @matiasmm1011     | 9    | AccountsService, rutas de cuentas y su web                      |
| TASK-109..TASK-117 | @alejandrorozich  | 10   | Categorías completas: contratos, servicio, rutas y web          |
| TASK-118           | @SebastianCatunta | 11   | Contratos de M6                                                 |
| TASK-119           | @alejandrorozich  | 11   | Repositorio del libro contable: lista, búsqueda y totales       |
| TASK-120..TASK-125 | @SebastianCatunta | 11   | LedgerHooks y TransactionsService (crear, editar, eliminar)     |
| TASK-126           | @alejandrorozich  | 11   | Servicio de lista y totales de movimientos                      |
| TASK-127..TASK-132 | @SebastianCatunta | 11   | Rutas y _job_ de movimientos; su web (lista, lote, detalle)     |
| TASK-133           | @matiasmm1011     | 11   | Web: movimientos en el detalle de una cuenta                    |
| TASK-134           | @alejandrorozich  | 12   | Contratos de M7                                                 |
| TASK-135           | @SebastianCatunta | 12   | Contexto de Registrar y movimientos de hoy                      |
| TASK-136           | @alejandrorozich  | 12   | Atajos: crear, editar, reordenar y eliminar                     |
| TASK-137..TASK-138 | @matiasmm1011     | 12   | Web: Registrar gastos, ingresos y transferencias                |
| TASK-139..TASK-140 | @alejandrorozich  | 12   | Web: segundo nivel de Registrar y fichas de atajos              |
| TASK-141           | @matiasmm1011     | 12   | Web: errores y estados vacíos de Registrar                      |
| TASK-142           | @SebastianCatunta | 12   | Web: después de guardar (limpieza, «Deshacer»)                  |
