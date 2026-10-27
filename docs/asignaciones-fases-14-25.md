# Asignaciones de las Fases 14 a 25

Propuesta de reparto para terminar V1.0, V1.1 y V1.2 antes del próximo despliegue (en unas 2 semanas). Las
filas usan el mismo formato que [`asignaciones.md`](asignaciones.md) (`| TASK-NNN..TASK-MMM | @usuario |`), así
que, cuando el equipo la apruebe, se copian a esa tabla en un commit `chore(sdd):` y `/coordinar-fases` las
toma. Mientras tanto, `coordinate.mjs` no lee este archivo.

## Criterio del reparto

- **Las tareas con E2E (Playwright) van sobre todo a Sebastián y Matías.** En la PC de Alejandro, cada tarea
  con E2E tarda de 40 a 60 minutos con `/implement-task`: levanta la web, el API y 4 navegadores, y la base de
  datos se satura (errores `P2024` de Prisma). Las tareas de backend tardan de 15 a 25 minutos. Por eso
  Alejandro lleva más tareas, pero casi todas de backend.
- **Lo que queda de la Fase 14 es de Matías**, que ya lo está empezando. TASK-151 quedó bloqueada en la copia
  de Alejandro con parte de la web ya commiteada en `feature/14-m9-ajustes-y-personalizacion`
  (`758172c`, `87eb04d`); Matías la retoma desde esa rama.
- **Las cadenas de dependencias van a una misma persona cuando se puede**, como en las Fases 7 a 12.

| Persona           | Fases                                          | Tareas | Con E2E |
| ----------------- | ---------------------------------------------- | -----: | ------: |
| @alejandrorozich  | 16, 18, 21, 23 (backend), 24                    |     36 |       5 |
| @matiasmm1011     | 14 (lo que queda), 15, 17, 22, 25              |     28 |      14 |
| @SebastianCatunta | 19, 20, 23 (web)                               |     31 |       9 |

## Orden y dependencias entre personas

```
Ya se pueden empezar:  14   15   16   18
                        └────┼────┘    │
                             17        19
                                      ┌┴┐
                                     20  21
                                      └┬┘
                                       22 → 23 → 24 → 25
```

1. **Alejandro empieza por la Fase 18** (bandeja de avisos): habilita la 19 de Sebastián y está al inicio de
   la ruta crítica. Mientras Sebastián hace la 19, Alejandro hace la 16.
2. **Matías** cierra la 14 y sigue con la 15. La 17 espera a la 14, la 15 y la 16 (la 16 es de Alejandro).
3. Con la 19 cerrada, **Alejandro hace la 21 y Sebastián la 20**, en paralelo.
4. La 22 de Matías espera a la 20 (TASK-204) y a la 21 (TASK-216).
5. La 23 se divide por capa: **Alejandro el backend (TASK-223 a TASK-233) y Sebastián la web (TASK-234 a
   TASK-236)**. Después Alejandro hace la 24 y Matías cierra con la 25.

**Riesgo:** la ruta crítica pasa por la 19 y la 20 de Sebastián (28 tareas seguidas). Si se atrasa, TASK-193
a TASK-196 (contratos, dominio y repositorios de presupuestos) no dependen de la 19 y Alejandro puede
adelantarlas.

## Tabla

| Tareas             | Persona           | Fase | Qué son                                                                  |
| ------------------ | ----------------- | ---- | ------------------------------------------------------------------------ |
| TASK-151..TASK-154 | @matiasmm1011     | 14   | Web: Ajustes, General, Registrar, Inicio y monedas                       |
| TASK-155..TASK-162 | @matiasmm1011     | 15   | Onboarding: contratos, servicio, rutas y su web                          |
| TASK-163..TASK-165 | @alejandrorozich  | 16   | Exportación: CSV y ZIP en streaming, `/api/me/export` y su web           |
| TASK-166..TASK-170 | @matiasmm1011     | 17   | Seed E2E, rendimiento, accesibilidad y barrido de aislamiento de V1.0    |
| TASK-172           | @matiasmm1011     | 17   | Workflow de QA efímero `qa-e2e.yml`                                      |
| TASK-174           | @matiasmm1011     | 17   | Workflow manual `fx-backfill.yml`                                        |
| TASK-248           | @matiasmm1011     | 17   | División de código por ruta y presupuesto de bundle de la web            |
| TASK-175..TASK-179 | @alejandrorozich  | 18   | Bandeja de avisos: contratos, avisos por evento, retención y campana     |
| TASK-180..TASK-192 | @SebastianCatunta | 19   | Metas de ahorro: dominio, apartados, servicio, rutas y su web            |
| TASK-193..TASK-207 | @SebastianCatunta | 20   | Presupuestos: períodos, umbrales, cierre, _jobs_, rutas y su web         |
| TASK-208..TASK-218 | @alejandrorozich  | 21   | Deudas y préstamos: interés, pagos, vencimientos, rutas y su web         |
| TASK-219..TASK-222 | @matiasmm1011     | 22   | Bloques del Inicio de V1.1, exportadores y regresión                     |
| TASK-223..TASK-233 | @alejandrorozich  | 23   | Recurrentes (backend): reglas, ocurrencias, _jobs_ y rutas               |
| TASK-234..TASK-236 | @SebastianCatunta | 23   | Recurrentes (web): pantalla, formulario y pendientes en la bandeja       |
| TASK-237..TASK-242 | @alejandrorozich  | 24   | Recordatorios: preferencias, avisos programados, su web y exportadores  |
| TASK-243..TASK-247 | @matiasmm1011     | 25   | Final: Gherkin, _jobs_ interrumpidos, zonas horarias, concurrencia y RNF |

TASK-171 y TASK-173 (Fase 17) ya están cerradas.

## Para activarlo

1. Copiar las filas de la tabla a `docs/asignaciones.md` (y ajustar su título y su texto a las Fases 7 a 25).
2. Agregar en `tools/sdd/branch-groups.json` una rama de grupo para la Fase 23, porque la hacen dos personas.
   Las demás fases las hace una sola persona y pueden ir en su rama de fase.
3. Hacer el commit `chore(sdd):`, subirlo y avisar al equipo.
