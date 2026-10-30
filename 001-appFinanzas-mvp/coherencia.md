# Coherencia de la documentación SDD con el código — Informe de revisión

**Tarea:** TASK-272 · **Fecha:** 2026-10-30 · **Actualizado:** 2026-10-30, con las correcciones de §6 · **Rama:** `feature/27-pulido-transversal-rendimiento-correos`
**Documentos revisados:** `spec.md` v1.5 · `plan.md` v1.4 · `tasks.md` (Fase 27) · `docs/constitution.md` v1.2.0
**Complementa a:** `apps/api/test/unit/sdd-coherence.test.ts` (TASK-271), que ya compara de forma automática los tipos de correo, los endpoints, los códigos de error, las tablas, la matriz de trazabilidad, las variables de entorno, los IDs citados, las versiones y el mapa de fases.

Este informe no modifica la spec, el plan ni `tasks.md`. Las correcciones se aplican después, con lo que la persona apruebe: los cambios de documento en commits `docs:` aparte, y los cambios de código en tareas nuevas.

## 1. Método

- **Filas:** una por cada RF, EC y RNF de `spec.md` v1.5, en el orden de la spec (M1 a M15 y luego los RNF).
- **Estado:**
  - `coincide`: el código hace lo que dice el requisito y al menos una prueba que lo cita lo demuestra.
  - `difiere`: el código, la prueba o el documento dicen otra cosa; el detalle está en la tabla de diferencias (§3).
  - `no verificable`: el requisito depende de condiciones que el pipeline no reproduce (un dispositivo, un navegador o una red reales). Se indica la prueba que lo aproxima.
- **Evidencia:** las pruebas (Vitest y Playwright) que citan el ID en su nombre o en su comentario, hasta dos por fila; entre paréntesis, cuántas más lo citan. No se cuenta `sdd-coherence.test.ts`, que cita todos los IDs para comprobar la matriz.
- **Revisión del contenido:** se leyó a mano el código de los requisitos que cambió la v1.5 (RF-M1-08, RF-M1-16, RF-M1-18, EC-M1-11, EC-M1-13, EC-M1-14, RF-M2-13, RF-M2-14, EC-M2-04, RNF-25, RNF-29) y los límites de RNF-28 (`apps/api/src/application/shared/limits.ts`). Para el resto, la evidencia es la prueba que cita el ID y que está en verde en la rama.

## 2. Requisitos por módulo

### M1 — Acceso y cuenta de usuario

| ID | Lo que pide la spec (resumen) | Estado | Evidencia | Nota |
|---|---|---|---|---|
| RF-M1-01 | El sistema DEBE exigir nombre (1-60 caracteres), correo con formato válido, contraseña de 8 a 128 caracteres… | coincide | `apps/api/test/integration/auth-signup.test.ts`, `packages/contracts/test/auth.test.ts` (+2) |  |
| RF-M1-02 | El sistema DEBE tratar el correo sin espacios al inicio ni al final y sin distinguir mayúsculas. | coincide | `packages/contracts/test/auth.test.ts`, `packages/db/test/schema-auth.test.ts` |  |
| RF-M1-03 | El sistema DEBE responder con el mismo mensaje neutro al registrarse o pedir la recuperación, exista o no el… | coincide | `apps/api/test/http/auth.test.ts`, `apps/api/test/integration/auth-signup.test.ts` (+1) |  |
| RF-M1-04 | El sistema DEBE impedir todo acceso a los datos hasta que el correo esté confirmado. Registrarse o iniciar… | coincide | `apps/api/test/http/auth.test.ts`, `apps/api/test/integration/auth-confirm.test.ts` (+6) |  |
| RF-M1-05 | El sistema DEBE permitir reenviar la confirmación una vez cada 60 segundos y como máximo 5 veces por hora.… | coincide | `apps/api/test/integration/auth-confirm.test.ts`, `apps/api/test/integration/email-links.test.ts` (+2) |  |
| RF-M1-06 | El sistema DEBE descartar los registros sin confirmar a los 7 días del último registro con ese correo. Un… | coincide | `apps/api/test/integration/auth-signup.test.ts`, `apps/api/test/integration/maintenance-auth.test.ts` |  |
| RF-M1-07 | El sistema DEBE mantener la sesión durante 30 días desde la última acción del usuario (las peticiones en… | coincide | `apps/api/test/http/session-middlewares.test.ts`, `apps/api/test/integration/auth-gateway.test.ts` (+4) |  |
| RF-M1-08 | El sistema DEBE contar los intentos fallidos por correo, exista o no una cuenta con ese correo. Tras 5 fallos… | coincide | `apps/api/test/integration/auth-signin.test.ts`, `apps/api/test/integration/login-throttle.test.ts` (+1) |  |
| RF-M1-09 | El enlace de recuperación DEBE vencer en 1 hora y servir una sola vez. Pedir uno nuevo invalida el anterior. | coincide | `apps/api/test/integration/auth-password.test.ts`, `apps/api/test/integration/email-links.test.ts` (+1) |  |
| RF-M1-10 | Al cambiar o recuperar la contraseña, el sistema DEBE revocar todas las demás sesiones y enviar un correo de… | coincide | `apps/api/test/integration/auth-password.test.ts`, `e2e/m1-password-reset.spec.ts` (+1) |  |
| RF-M1-11 | El sistema DEBE detectar la zona horaria del dispositivo al registrarse (Bolivia, si no puede detectarla) y… | coincide | `apps/api/test/http/me.test.ts`, `packages/contracts/test/auth.test.ts` (+2) |  |
| RF-M1-12 | Cambiar la zona horaria NO DEBE alterar la fecha de los movimientos ya registrados. | coincide | `apps/api/test/http/me.test.ts` |  |
| RF-M1-13 | El sistema NO DEBE permitir cambiar el correo de la cuenta. | coincide | `apps/api/test/http/me.test.ts`, `packages/contracts/test/auth.test.ts` (+1) |  |
| RF-M1-14 | La exportación DEBE incluir todos los datos del usuario, archivados incluidos, y generarse en el momento, sin… | coincide | `apps/api/test/http/me-export-v1-1.test.ts`, `apps/api/test/http/me-export-v1-2.test.ts` (+3) |  |
| RF-M1-15 | La eliminación de la cuenta DEBE exigir la contraseña y la palabra ELIMINAR. Debe borrar todos los datos del… | coincide | `apps/api/test/http/me-delete.test.ts`, `packages/db/test/schema-integrity.test.ts` (+2) |  |
| RF-M1-16 | Los únicos correos que envía el sistema son: confirmación, intento de registro con un correo existente,… | coincide | `apps/api/test/integration/auth-signin.test.ts`, `apps/api/test/integration/login-throttle.test.ts` (+3) |  |
| RF-M1-17 | El aviso de intento de registro con un correo existente DEBE enviarse como máximo una vez por hora por cuenta. | coincide | `apps/api/test/integration/auth-signup.test.ts` |  |
| RF-M1-18 | El enlace de confirmación DEBE servir solo para confirmar la cuenta: no abre sesión ni lleva al Onboarding.… | coincide | `apps/api/test/http/auth.test.ts`, `apps/api/test/http/dashboard.test.ts` (+23) |  |
| EC-M1-01 | Se abre un enlace de confirmación vencido o invalidado. El sistema muestra "Este enlace ya no es válido" y… | coincide | `apps/api/test/integration/auth-confirm.test.ts`, `apps/api/test/integration/email-links.test.ts` (+1) |  |
| EC-M1-02 | Se abre un enlace de confirmación ya usado con la cuenta activa. El sistema lleva al inicio de sesión. | coincide | `apps/api/test/integration/auth-confirm.test.ts`, `apps/api/test/integration/email-links.test.ts` (+1) |  |
| EC-M1-03 | Alguien se registra con un correo cuyo registro sin confirmar fue descartado. Se trata como un registro nuevo. | coincide | `apps/api/test/integration/auth-signup.test.ts`, `apps/api/test/integration/maintenance-auth.test.ts` |  |
| EC-M1-04 | Se intenta iniciar sesión durante el tiempo de espera, aunque sea con la contraseña correcta. Se rechaza y se… | coincide | `apps/api/test/integration/auth-signin.test.ts`, `apps/api/test/integration/login-throttle.test.ts` (+1) |  |
| EC-M1-05 | Se cambia la contraseña en el dispositivo A mientras B está abierto. B pierde la sesión en su siguiente… | coincide | `apps/api/test/http/session-middlewares.test.ts`, `apps/api/test/integration/auth-password.test.ts` (+2) |  |
| EC-M1-06 | Se elimina la cuenta en A mientras B está abierto. B pierde la sesión en su siguiente acción. | coincide | `apps/api/test/http/me-delete.test.ts`, `apps/api/test/http/session-middlewares.test.ts` (+1) |  |
| EC-M1-07 | El servicio de correo falla. El registro o la recuperación muestran el mismo mensaje neutro, y el usuario… | coincide | `apps/api/test/integration/outbox.test.ts` |  |
| EC-M1-08 | La contraseña de la eliminación es incorrecta, o la palabra no es exactamente ELIMINAR. No se elimina nada y… | coincide | `apps/api/test/http/me-delete.test.ts`, `packages/contracts/test/auth.test.ts` (+1) |  |
| EC-M1-09 | Alguien se registra con un correo que tiene un registro Sin confirmar (aún no descartado). Se reemplazan el… | coincide | `apps/api/test/http/auth.test.ts`, `apps/api/test/integration/auth-signup-ticket.test.ts` (+1) |  |
| EC-M1-10 | Se recupera la contraseña de una cuenta Sin confirmar. Al definir la contraseña nueva, la cuenta queda Activa. | coincide | `apps/api/test/http/auth.test.ts`, `apps/api/test/integration/auth-password.test.ts` (+1) |  |
| EC-M1-11 | Se confirma el correo de A mientras la app que lo espera está en un navegador con la sesión de B abierta. Se… | coincide | `e2e/m1-sign-up-confirm-sync.spec.ts`, `apps/api/test/http/auth.test.ts` (+1) | D-01 resuelta en TASK-273: al confirmar se descartan los borradores de B. |
| EC-M1-12 | Hay intentos fallidos con un correo sin cuenta. Se aplica la misma espera que a uno con cuenta, para no… | coincide | `apps/api/test/integration/auth-signin.test.ts`, `apps/api/test/integration/login-throttle.test.ts` |  |
| EC-M1-13 | El usuario cierra la app donde se registró antes de confirmar. Al abrir el enlace, nada continúa solo: la… | coincide | `e2e/m1-sign-up-confirm-sync.spec.ts` |  |
| EC-M1-14 | Una cuenta Sin confirmar recupera su contraseña (EC-M1-10), o alguien se registra de nuevo con su correo… | coincide | `apps/api/test/http/auth.test.ts`, `apps/api/test/integration/auth-password.test.ts` (+2) |  |

### M2 — Navegación y estructura

| ID | Lo que pide la spec (resumen) | Estado | Evidencia | Nota |
|---|---|---|---|---|
| RF-M2-01 | Por debajo de 1024 px, el sistema DEBE usar la barra inferior de 5 pestañas con Registrar en el centro. Desde… | coincide | `e2e/m2-navigation.spec.ts` |  |
| RF-M2-02 | "Más" DEBE existir solo en el formato de barra inferior. | coincide | `e2e/m2-navigation.spec.ts` |  |
| RF-M2-03 | El sistema DEBE mostrar únicamente los módulos de las entregas liberadas. | coincide | `apps/api/test/http/budgets.test.ts`, `apps/api/test/http/debts.test.ts` (+9) |  |
| RF-M2-04 | Cada pestaña DEBE recordar su estado (mes, filtros, posición, detalle abierto) al cambiar de pestaña. Ese… | coincide | `apps/web/test/prefetch-routes.test.ts`, `apps/web/test/search-params.test.ts` (+3) |  |
| RF-M2-05 | Tocar la pestaña activa DEBE llevar al inicio de esa pestaña. En Registrar no borra el borrador. | coincide | `apps/web/test/ui-store.test.ts`, `e2e/m2-more-menu.spec.ts` |  |
| RF-M2-06 | El botón Atrás del navegador o del celular DEBE funcionar en todas las pantallas. | coincide | `apps/web/test/search-params.test.ts`, `e2e/m2-back-button.spec.ts` (+1) |  |
| RF-M2-07 | Sin conexión, el sistema DEBE bloquear toda la app, incluido Registrar, con una pantalla de aviso y liberarla… | coincide | `apps/web/test/api-client.test.ts`, `apps/web/test/online.test.ts` (+2) |  |
| RF-M2-08 | Con la sesión vencida, el sistema DEBE pedir que el usuario inicie sesión y, tras hacerlo, volver a la misma… | coincide | `apps/api/test/http/session-middlewares.test.ts`, `apps/web/test/api-client.test.ts` (+1) |  |
| RF-M2-09 | El estado contraído de la barra lateral DEBE guardarse en la cuenta del usuario (M9). | coincide | `apps/api/test/http/settings.test.ts`, `packages/contracts/test/settings.test.ts` (+2) |  |
| RF-M2-10 | Todo formulario con datos sin guardar DEBE conservarlos como borrador en el mismo dispositivo al cambiar de… | coincide | `apps/web/test/drafts.test.ts`, `e2e/gherkin-register.spec.ts` (+2) |  |
| RF-M2-11 | Al restaurar un borrador, o al aplicar un atajo, cuya cuenta o categoría ya no está activa, ese campo DEBE… | coincide | `apps/web/test/drafts.test.ts` |  |
| RF-M2-12 | Las secciones de "Más" y de la barra lateral sin módulos liberados DEBEN ocultarse. | coincide | `e2e/m2-more-menu.spec.ts` |  |
| RF-M2-13 | Toda pantalla que no sea la raíz de una pestaña DEBE mostrar en la cabecera un botón "Volver", antes del… | coincide | `apps/web/test/route-parents.test.ts`, `e2e/m2-back-button.spec.ts` |  |
| RF-M2-14 | La app DEBE mostrar su logo como ícono de la pestaña del navegador, en las pantallas de acceso y registro, y… | coincide | `apps/web/test/brand-assets.test.ts`, `e2e/m2-brand.spec.ts` |  |
| EC-M2-01 | Otra persona inicia sesión tras el vencimiento de la sesión en el mismo dispositivo. El borrador del usuario… | coincide | `apps/web/test/drafts.test.ts`, `e2e/m1-sign-in.spec.ts` (+1) |  |
| EC-M2-02 | La conexión se pierde a mitad de un guardado. Aparece el bloqueo. Al reconectar, el usuario ve si el… | coincide | `apps/web/test/online.test.ts` |  |
| EC-M2-03 | El ancho de la pantalla cambia al girar la tablet. La navegación cambia de formato sin perder el estado. | coincide | `e2e/m2-navigation.spec.ts` |  |
| EC-M2-04 | Se abre una pantalla interna desde un enlace directo, sin pantallas previas en la app. "Volver" lleva a la… | coincide | `e2e/m2-back-button.spec.ts` |  |

### M3 — Monedas y tipo de cambio

| ID | Lo que pide la spec (resumen) | Estado | Evidencia | Nota |
|---|---|---|---|---|
| RF-M3-01 | BOB y USD DEBEN estar siempre activas. Toda moneda usa 2 decimales, y las tasas de cambio también se guardan… | coincide | `apps/api/test/http/currencies-deactivate.test.ts`, `apps/api/test/http/currencies.test.ts` (+2) |  |
| RF-M3-02 | El código de una moneda DEBE tener 3 letras y ser único para el usuario. Las monedas agregadas DEBEN tener… | coincide | `apps/api/test/http/currencies.test.ts`, `packages/contracts/test/common.test.ts` (+2) |  |
| RF-M3-03 | La referencia por defecto DEBE ser la mediana del paralelo, tal como la publica paralelo.bo. El valor manual… | coincide | `apps/api/test/http/fx-settings.test.ts`, `apps/api/test/integration/rates-service.test.ts` (+2) |  |
| RF-M3-04 | El sistema DEBE actualizar las tasas automáticas: | coincide | `apps/api/test/http/rates.test.ts`, `apps/api/test/integration/fx-jobs.test.ts` (+1) |  |
| RF-M3-05 | El sistema DEBE mostrar junto a toda tasa "actualizado hace X" y su fuente. NO muestra avisos de… | coincide | `apps/api/test/http/rates.test.ts`, `apps/api/test/integration/rates-service.test.ts` (+1) |  |
| RF-M3-06 | Todo movimiento, esté o no en la moneda base, DEBE guardar al guardarse la tasa de su moneda frente al… | coincide | `apps/api/test/integration/rates-service.test.ts`, `apps/api/test/integration/transactions-create.test.ts` (+1) |  |
| RF-M3-07 | En una transferencia entre monedas distintas, el sistema DEBE precargar el campo "Tipo de cambio usado": | coincide | `apps/api/test/integration/recurring-generate-job.test.ts`, `apps/api/test/integration/transactions-transfer.test.ts` (+1) |  |
| RF-M3-08 | En esa transferencia, el sistema DEBE calcular el monto que llega a partir del monto que sale y la tasa. Si… | coincide | `apps/api/test/integration/transactions-transfer.test.ts`, `packages/domain/test/fx-convert.test.ts` |  |
| RF-M3-09 | La tasa declarada en una transferencia DEBE ser la tasa histórica de ese movimiento. | coincide | `apps/api/test/integration/transactions-transfer.test.ts` |  |
| RF-M3-10 | Al editar un movimiento, la tasa guardada DEBE conservarse siempre, aunque cambien su fecha o su cuenta. Solo… | coincide | `apps/api/test/integration/transactions-update.test.ts` |  |
| RF-M3-11 | Cambiar la referencia o la moneda base DEBE recalcular los saldos y totales actuales sin modificar los… | coincide | `apps/api/test/http/fx-settings.test.ts`, `apps/api/test/integration/gherkin-accounts-categories.test.ts` (+1) |  |
| RF-M3-12 | La brecha DEBE calcularse como (paralelo − oficial) ÷ oficial, en % y en Bs, comparando con el oficial (TCO)… | coincide | `apps/api/test/integration/rates-service.test.ts`, `packages/contracts/test/fx.test.ts` (+1) |  |
| RF-M3-13 | El sistema DEBE guardar un historial diario de tasas por moneda: las referencias automáticas del dólar, el… | coincide | `apps/api/test/http/currencies.test.ts`, `apps/api/test/http/fx-settings.test.ts` (+4) |  |
| EC-M3-01 | La fuente no responde. Se usa el último valor guardado y la app sigue funcionando. | coincide | `apps/api/test/integration/fx-jobs.test.ts` |  |
| EC-M3-02 | La fuente no responde y no hay ningún valor guardado (usuario nuevo). | coincide | `apps/api/test/integration/rates-service.test.ts`, `apps/api/test/integration/transactions-create.test.ts` (+1) |  |
| EC-M3-03 | Se registra un movimiento con fecha de un día sin registro de tasas. Se usa la del día anterior más cercano… | coincide | `packages/domain/test/fx-resolve.test.ts` |  |
| EC-M3-04 | La fuente devuelve un valor inválido (cero, negativo o vacío). Se descarta y se conserva el último valor… | coincide | `apps/api/test/integration/fx-jobs.test.ts`, `apps/api/test/unit/bcb.test.ts` (+1) |  |
| EC-M3-05 | El usuario intenta desactivar una moneda en uso. Se rechaza y se indica qué la usa (cuentas, metas,… | coincide | `apps/api/test/http/currencies-deactivate.test.ts`, `apps/api/test/integration/budgets-create.test.ts` (+2) |  |
| EC-M3-07 | Se agrega una moneda con una tasa menor a Bs 0,01 (por ejemplo, el peso argentino o el chileno). Se rechaza… | coincide | `apps/api/test/http/currencies.test.ts` |  |
| EC-M3-06 | Con el valor manual activo, se transfiere de una cuenta en Bs a una en $. Se precarga el valor manual, no el… | coincide | `packages/domain/test/fx-convert.test.ts` |  |

### M4 — Cuentas

| ID | Lo que pide la spec (resumen) | Estado | Evidencia | Nota |
|---|---|---|---|---|
| RF-M4-01 | El nombre DEBE tener de 1 a 40 caracteres y ser único entre las cuentas activas, sin distinguir mayúsculas. | coincide | `apps/api/test/integration/onboarding-step2.test.ts`, `packages/contracts/test/accounts.test.ts` (+3) |  |
| RF-M4-02 | El saldo inicial DEBE cumplir según el tipo: | coincide | `apps/api/test/integration/onboarding-step2.test.ts`, `packages/contracts/test/accounts.test.ts` (+3) |  |
| RF-M4-03 | El saldo DEBE calcularse según RN-01. Un movimiento con fecha anterior a la del saldo inicial se permite,… | coincide | `apps/api/test/integration/transactions-create.test.ts` |  |
| RF-M4-04 | En efectivo y billetera, el sistema DEBE rechazar toda acción que deje el saldo actual en negativo, y… | coincide | `apps/api/test/integration/balance-guard.test.ts`, `apps/api/test/integration/transactions-create.test.ts` |  |
| RF-M4-05 | Un ajuste NO cuenta como ingreso ni como gasto. Se puede editar y eliminar. Si la diferencia es 0, no se… | coincide | `apps/api/test/integration/gherkin-accounts-categories.test.ts`, `apps/api/test/integration/goals-crud.test.ts` (+1) |  |
| RF-M4-06 | La moneda de una cuenta solo DEBE poder cambiarse si no tiene movimientos. | coincide | `apps/api/test/integration/gherkin-accounts-categories.test.ts` |  |
| RF-M4-07 | El saldo inicial y su fecha NO DEBEN editarse después de crear la cuenta: cualquier diferencia se corrige con… | coincide | `apps/api/test/integration/accounts-goals.test.ts`, `packages/contracts/test/accounts.test.ts` (+2) |  |
| RF-M4-08 | En una tarjeta: | coincide | `apps/api/test/http/dashboard-upcoming.test.ts`, `apps/api/test/integration/notifications-payments-job.test.ts` (+2) |  |
| RF-M4-09 | Una cuenta archivada NO DEBE aparecer en los selectores ni sumar en los saldos y totales actuales, y DEBE… | coincide | `apps/api/test/integration/gherkin-accounts-categories.test.ts`, `e2e/gherkin-accounts-categories.spec.ts` |  |
| RF-M4-10 | El total neto DEBE ser la suma de las cuentas activas (la deuda de tarjetas resta), en moneda base y su… | coincide | `apps/api/test/integration/accounts-goals.test.ts`, `packages/domain/test/net-worth.test.ts` (+2) |  |
| RF-M4-11 | Las cuentas DEBEN poder reordenarse. La lista agrupa por tipo y respeta ese orden. | coincide | `apps/api/test/integration/gherkin-accounts-categories.test.ts`, `e2e/gherkin-accounts-categories.spec.ts` |  |
| RF-M4-12 | Si se archiva la cuenta por defecto o la última usada en Registrar, Registrar DEBE pasar a la cuenta que… | coincide | `apps/api/test/integration/gherkin-accounts-categories.test.ts` |  |
| RF-M4-13 | Al eliminar una cuenta sin movimientos, el sistema DEBE quitarla como cuenta por defecto y eliminar sus… | coincide | `apps/api/test/integration/recurring-cascades.test.ts`, `packages/contracts/test/errors.test.ts` (+1) |  |
| EC-M4-01 | Se elimina un ingreso del efectivo y el saldo quedaría en −50. Se rechaza: "El efectivo quedaría en Bs… | coincide | `apps/api/test/integration/balance-guard.test.ts`, `apps/api/test/integration/transactions-delete-undo.test.ts` |  |
| EC-M4-02 | El usuario quiere corregir el saldo inicial de una cuenta. No es editable; se ofrece "Ajustar saldo". | coincide | `packages/db/test/schema-account.test.ts` |  |
| EC-M4-03 | Un recurrente automático dejaría el efectivo en negativo. No se registra y pasa a pendiente (M14). | coincide | `apps/api/test/integration/recurring-generate-job.test.ts` |  |
| EC-M4-04 | Se restaura una cuenta cuyo nombre está en uso. Se pide un nombre nuevo antes de restaurarla. | coincide | `apps/api/test/integration/gherkin-accounts-categories.test.ts`, `e2e/gherkin-accounts-categories.spec.ts` |  |
| EC-M4-05 | La única cuenta activa se archiva. Registrar y el Inicio invitan a crear una cuenta. | coincide | `apps/api/test/integration/gherkin-accounts-categories.test.ts`, `e2e/gherkin-accounts-categories.spec.ts` |  |
| EC-M4-06 | Un banco queda con saldo negativo. Se permite (sobregiro). | coincide | `apps/api/test/integration/balance-guard.test.ts` |  |
| EC-M4-07 | Se restaura una cuenta cuya moneda está inactiva. Se pide reactivar la moneda primero. | coincide | `apps/api/test/integration/gherkin-accounts-categories.test.ts`, `e2e/gherkin-accounts-categories.spec.ts` |  |
| EC-M4-08 | Se ajusta el saldo al mismo valor que ya tiene. No se crea ningún ajuste y se informa "El saldo ya coincide". | coincide | `apps/api/test/integration/gherkin-accounts-categories.test.ts`, `e2e/gherkin-accounts-categories.spec.ts` |  |

### M5 — Categorías

| ID | Lo que pide la spec (resumen) | Estado | Evidencia | Nota |
|---|---|---|---|---|
| RF-M5-01 | Gastos e ingresos DEBEN tener categorías separadas. El tipo de una categoría nunca cambia. | coincide | `apps/api/test/integration/categories-crud.test.ts`, `packages/contracts/test/categories.test.ts` (+1) |  |
| RF-M5-02 | El nombre DEBE tener de 1 a 30 caracteres y ser único dentro del mismo tipo y el mismo padre, sin distinguir… | coincide | `apps/api/test/integration/categories-crud.test.ts`, `packages/contracts/test/categories.test.ts` (+1) |  |
| RF-M5-03 | Un movimiento PUEDE asignarse a una categoría padre o a una subcategoría. El total de un padre incluye el de… | coincide | `apps/api/test/http/dashboard.test.ts`, `apps/api/test/integration/category-repository.test.ts` (+1) |  |
| RF-M5-04 | El ícono DEBE elegirse de una galería fija (unos 60) y el color de una paleta de 12 colores con contraste AA… | coincide | `apps/api/test/integration/categories-crud.test.ts`, `apps/api/test/integration/onboarding-step3.test.ts` (+3) |  |
| RF-M5-05 | La categoría del sistema "Deudas y préstamos" (gasto e ingreso) y su subcategoría "Intereses" DEBEN estar… | coincide | `apps/api/test/integration/categories-crud.test.ts`, `apps/api/test/integration/gherkin-accounts-categories.test.ts` (+6) |  |
| RF-M5-06 | Una categoría archivada NO DEBE ofrecerse al registrar y DEBE conservar su historia. | coincide | `apps/api/test/integration/categories-archive.test.ts` |  |
| RF-M5-07 | Antes de archivar una categoría en uso, el sistema DEBE listar lo afectado y aplicar: | coincide | `apps/api/test/integration/categories-archive.test.ts`, `apps/api/test/integration/categories-budgets.test.ts` (+1) |  |
| RF-M5-08 | La fusión de A en B DEBE cumplir: | coincide | `apps/api/test/integration/categories-budgets.test.ts`, `apps/api/test/integration/gherkin-accounts-categories.test.ts` (+1) |  |
| RF-M5-09 | Fusionar categorías o mover una subcategoría a otro padre DEBE cambiar el gasto por categoría de los meses… | coincide | `apps/api/test/http/dashboard.test.ts` |  |
| EC-M5-01 | Se crea "comida" existiendo "Comida" en gastos. Se rechaza por duplicado. | coincide | `apps/api/test/integration/categories-crud.test.ts`, `packages/db/test/schema-category.test.ts` |  |
| EC-M5-02 | Se intenta fusionar una categoría con subcategorías. Se pide fusionar o mover primero las subcategorías. | coincide | `apps/api/test/integration/gherkin-accounts-categories.test.ts`, `e2e/gherkin-accounts-categories.spec.ts` |  |
| EC-M5-03 | Se mueve una subcategoría con presupuesto a otro padre. El gasto del presupuesto del padre anterior deja de… | coincide | `apps/api/test/integration/categories-budgets.test.ts`, `apps/api/test/integration/categories-crud.test.ts` |  |
| EC-M5-04 | Al restaurar una categoría, su nombre ya está en uso en el mismo nivel. Se pide renombrarla. | coincide | `apps/api/test/integration/categories-archive.test.ts` |  |
| EC-M5-05 | Se convierte una subcategoría en principal y ya existe una principal con ese nombre. Se pide renombrarla… | coincide | `apps/api/test/integration/categories-crud.test.ts` |  |
| EC-M5-06 | Se restaura una subcategoría cuyo padre está archivado. Se pide restaurar el padre o elegir otro padre activo. | coincide | `apps/api/test/integration/categories-archive.test.ts` |  |
| EC-M5-07 | Se intenta eliminar una categoría sin movimientos que usa un presupuesto o una regla recurrente. Se rechaza y… | coincide | `apps/api/test/integration/gherkin-accounts-categories.test.ts` |  |

### M6 — Transacciones

| ID | Lo que pide la spec (resumen) | Estado | Evidencia | Nota |
|---|---|---|---|---|
| RF-M6-01 | El monto DEBE estar entre 0,01 y 999.999.999,99, con 2 decimales como máximo. | coincide | `apps/api/test/integration/transactions-create.test.ts`, `packages/contracts/test/common.test.ts` (+2) |  |
| RF-M6-02 | La fecha DEBE ser hoy o anterior (RN-07), sin hora y sin fecha mínima. Dentro de un día, la lista ordena por… | coincide | `apps/api/test/integration/ledger-list.test.ts` |  |
| RF-M6-03 | La nota DEBE ser opcional y de hasta 140 caracteres. | coincide | `packages/contracts/test/common.test.ts`, `packages/contracts/test/transactions.test.ts` (+1) |  |
| RF-M6-04 | El origen y el destino de una transferencia DEBEN ser cuentas activas y distintas. | coincide | `apps/api/test/integration/transactions-transfer.test.ts`, `apps/api/test/integration/transactions-update.test.ts` (+1) |  |
| RF-M6-05 | La comisión de una transferencia DEBE crear un gasto vinculado en la cuenta de origen. Se edita desde la… | coincide | `apps/api/test/integration/transactions-transfer.test.ts`, `apps/api/test/integration/transactions-update.test.ts` (+2) |  |
| RF-M6-06 | El tipo de un movimiento NO DEBE cambiar. | coincide | `apps/api/test/integration/transactions-update.test.ts`, `packages/contracts/test/transactions.test.ts` |  |
| RF-M6-07 | La cuenta PUEDE cambiarse: | coincide | `apps/api/test/integration/transactions-update.test.ts`, `packages/contracts/test/transactions.test.ts` |  |
| RF-M6-08 | Toda edición, eliminación o deshacer DEBE respetar el bloqueo de negativos (M4), la protección de apartados… | coincide | `apps/api/test/integration/earmark-protection.test.ts`, `apps/api/test/integration/transactions-delete-undo.test.ts` (+1) |  |
| RF-M6-09 | En los movimientos vinculados (glosario), el monto, la cuenta y la fecha DEBEN editarse solo desde su origen,… | coincide | `apps/api/test/integration/transactions-delete-undo.test.ts`, `apps/api/test/integration/transactions-update.test.ts` (+1) |  |
| RF-M6-10 | Los movimientos creados por un recurrente DEBEN ser movimientos normales, editables y eliminables, con el… | coincide | `apps/api/test/integration/recurring-generate-job.test.ts`, `apps/api/test/integration/transactions-delete-undo.test.ts` |  |
| RF-M6-11 | Los pendientes NO DEBEN aparecer en la lista de movimientos ni contar en saldos o totales. | coincide | `apps/api/test/integration/ledger-list.test.ts` |  |
| RF-M6-12 | El neto diario y los totales de la lista DEBEN excluir los movimientos que indica RN-02. | coincide | `apps/api/test/integration/ledger-list.test.ts`, `apps/api/test/integration/transactions-transfer.test.ts` |  |
| RF-M6-13 | Las acciones en lote DEBEN omitir los movimientos que violarían el bloqueo de negativos o de apartados. Al… | coincide | `apps/api/test/integration/earmark-protection.test.ts` |  |
| RF-M6-14 | Un doble toque o un reintento NUNCA DEBE crear dos movimientos (RN-10). No existe aviso de posible duplicado. | coincide | `apps/api/test/integration/transactions-create.test.ts` |  |
| EC-M6-01 | El mismo movimiento se edita en dos dispositivos. Gana la última edición guardada. | coincide | `apps/api/test/integration/transactions-update.test.ts` |  |
| EC-M6-02 | Se guarda la edición de un movimiento eliminado en otro dispositivo. Se informa "Este movimiento ya no… | coincide | `apps/api/test/integration/transactions-update.test.ts` |  |
| EC-M6-03 | Se intenta deshacer una eliminación cuyo resultado violaría el bloqueo de negativos. Se rechaza con la… | coincide | `apps/api/test/integration/transactions-delete-undo.test.ts` |  |
| EC-M6-04 | Se cambia la fecha de un gasto en dólares. Conserva su tasa guardada; el usuario puede editarla a mano… | coincide | `apps/api/test/integration/transactions-update.test.ts` |  |
| EC-M6-05 | Se elimina una transferencia con comisión. Se eliminan ambas, con un único "Deshacer". | coincide | `apps/api/test/integration/transactions-delete-undo.test.ts` |  |
| EC-M6-06 | El usuario cambia de pantalla durante los 10 segundos de "Deshacer". La eliminación queda definitiva. | coincide | `e2e/gherkin-register.spec.ts` |  |
| EC-M6-07 | Se pasa un movimiento a una cuenta de otra moneda y el monto convertido superaría 999.999.999,99. Se rechaza… | coincide | `apps/api/test/integration/transactions-update.test.ts`, `packages/contracts/test/transactions.test.ts` |  |
| EC-M6-08 | Se carga una comisión y "Comisiones bancarias" fue eliminada en el Onboarding. Se pide elegir otra categoría… | coincide | `apps/api/test/integration/transactions-transfer.test.ts` |  |

### M7 — Registrar

| ID | Lo que pide la spec (resumen) | Estado | Evidencia | Nota |
|---|---|---|---|---|
| RF-M7-01 | Registrar DEBE ser una pestaña normal: centro de la barra inferior en celular, entrada de la barra lateral en… | coincide | `e2e/m2-navigation.spec.ts` |  |
| RF-M7-02 | Al entrar con el formulario vacío, el tipo DEBE ser Gasto y el foco DEBE estar en el monto. Si hay un… | coincide | `packages/domain/test/format-money.test.ts`, `e2e/gherkin-register.spec.ts` |  |
| RF-M7-03 | La cuenta preseleccionada DEBE ser la cuenta por defecto de Ajustes (una sola, para gastos e ingresos), si… | coincide | `apps/api/test/http/settings-register.test.ts`, `apps/api/test/integration/gherkin-accounts-categories.test.ts` (+1) |  |
| RF-M7-04 | La grilla DEBE mostrar 8 categorías del tipo actual: | coincide | `apps/api/test/http/settings-register.test.ts`, `e2e/m9-settings-register.spec.ts` |  |
| RF-M7-05 | La fecha DEBE ofrecer las fichas "Hoy" (marcada), "Ayer" y "Calendario", sin fechas futuras. | coincide | `e2e/gherkin-register.spec.ts` |  |
| RF-M7-06 | "Guardar" DEBE habilitarse con monto mayor que 0 y categoría (gasto o ingreso), o con origen y destino… | coincide | `e2e/gherkin-register.spec.ts` |  |
| RF-M7-07 | Al guardar, el sistema DEBE limpiar el formulario y permanecer en Registrar. Debe mostrar "Deshacer" durante… | coincide | `apps/api/test/integration/gherkin-accounts-categories.test.ts`, `apps/api/test/integration/transactions-delete-undo.test.ts` (+1) |  |
| RF-M7-08 | El borrador DEBE conservarse según RF-M2-10, también tras volver a iniciar sesión el mismo usuario. | coincide | `apps/web/test/drafts.test.ts` |  |
| RF-M7-09 | Los atajos DEBEN guardar nombre (de 1 a 30 caracteres), tipo (gasto, ingreso o transferencia), monto… | coincide | `packages/db/test/schema-ledger.test.ts`, `e2e/gherkin-register.spec.ts` |  |
| RF-M7-10 | Los atajos se crean con "Guardar como atajo" y se editan, reordenan y eliminan en Ajustes › Registrar. | coincide | `e2e/m9-settings-register.spec.ts` |  |
| RF-M7-11 | La ficha de cuenta DEBE mostrar el saldo libre de la cuenta. En una tarjeta, muestra el crédito disponible… | coincide | `apps/api/test/integration/accounts-goals.test.ts` |  |
| RF-M7-12 | En escritorio, el formulario DEBE poder usarse completo con Tab y Enter. No hay atajos de teclado propios. | coincide | `e2e/keyboard-v1-0.spec.ts` |  |
| RF-M7-13 | El ajuste "Mostrar la nota siempre" DEBE poner la nota en el primer nivel. | coincide | `e2e/m9-settings-register.spec.ts` |  |
| RF-M7-14 | Al registrar una salida de una cuenta dedicada a una meta, DEBE mostrarse el aviso no bloqueante "Esto resta… | coincide | `e2e/m12-earmark-confirm.spec.ts` |  |
| EC-M7-01 | No hay cuentas. Registrar muestra "Crea tu primera cuenta" con un formulario mínimo (nombre, tipo, moneda,… | coincide | `e2e/gherkin-register.spec.ts` |  |
| EC-M7-02 | El gasto dejaría el efectivo en negativo. Se muestra el error en la pantalla y el formulario no se limpia. | coincide | `e2e/gherkin-register.spec.ts` |  |
| EC-M7-03 | El gasto usa dinero apartado para metas. Aparece la confirmación de M12. Si se cancela, el formulario queda… | coincide | `e2e/i18n-direct-load.spec.ts`, `e2e/m12-earmark-confirm.spec.ts` |  |
| EC-M7-04 | No hay ninguna tasa y la cuenta está en dólares. Se pide el valor en ese momento (EC-M3-02). | coincide | `e2e/gherkin-register.spec.ts` |  |
| EC-M7-05 | La cuenta por defecto se archiva. El ajuste se limpia y se aplica RF-M7-03. | coincide | `apps/api/test/integration/gherkin-accounts-categories.test.ts`, `e2e/gherkin-register.spec.ts` |  |
| EC-M7-06 | Ya existen 12 atajos. "Guardar como atajo" informa el límite y ofrece gestionar los atajos. | coincide | `apps/api/test/integration/gherkin-accounts-categories.test.ts`, `e2e/gherkin-register.spec.ts` |  |
| EC-M7-07 | No hay categorías del tipo elegido (gasto o ingreso). "Ver todas" aparece vacío con la acción "Crear… | coincide | `e2e/gherkin-register.spec.ts`, `e2e/m10-onboarding-step3.spec.ts` |  |
| EC-M7-08 | El borrador apunta a una cuenta archivada desde otro dispositivo. El campo de cuenta se vacía y se marca para… | coincide | `e2e/gherkin-register.spec.ts` |  |

### M8 — Inicio

| ID | Lo que pide la spec (resumen) | Estado | Evidencia | Nota |
|---|---|---|---|---|
| RF-M8-01 | El mes DEBE ser el mes calendario. El selector va desde el mes del primer movimiento o del primer saldo… | coincide | `apps/api/test/integration/dashboard-cards.test.ts`, `apps/api/test/integration/dashboard-cost.test.ts` (+2) |  |
| RF-M8-02 | Los ingresos y gastos DEBEN excluir los movimientos que indica RN-02 y convertirse con la tasa guardada en… | coincide | `apps/api/test/integration/dashboard-cards.test.ts` |  |
| RF-M8-03 | Balance = ingresos − gastos. Tasa de ahorro = balance ÷ ingresos, en porcentaje entero redondeado con la… | coincide | `apps/api/test/integration/dashboard-cards.test.ts`, `packages/contracts/test/dashboard.test.ts` (+2) |  |
| RF-M8-04 | Cada tarjeta DEBE mostrar su variación contra el mes anterior: | coincide | `apps/api/test/integration/dashboard-cards.test.ts`, `packages/domain/test/dashboard.test.ts` (+1) |  |
| RF-M8-05 | "Gasto por categoría" DEBE mostrar barras horizontales con las 5 categorías principales de mayor gasto… | coincide | `apps/api/test/http/dashboard.test.ts`, `e2e/m8-dashboard-blocks.spec.ts` |  |
| RF-M8-06 | "Ritmo del gasto" DEBE comparar el gasto acumulado día a día del mes elegido (hasta hoy, si es el actual)… | coincide | `apps/api/test/http/dashboard.test.ts`, `e2e/m8-dashboard-blocks.spec.ts` |  |
| RF-M8-07 | "Saldos por cuenta" DEBE mostrar el total neto en moneda base y en la otra moneda (glosario) y las 5 primeras… | coincide | `apps/api/test/http/dashboard.test.ts`, `e2e/m8-dashboard-blocks.spec.ts` |  |
| RF-M8-08 | "Presupuesto del mes" (V1.1) DEBE mostrar una barra por presupuesto activo, con su período visible. En un mes… | coincide | `apps/api/test/http/dashboard-budgets.test.ts`, `e2e/m8-dashboard-budgets.spec.ts` |  |
| RF-M8-09 | "Próximos pagos y deudas" (V1.1) DEBE listar los vencimientos de los próximos 7 días: deudas (en ambas… | coincide | `apps/api/test/http/dashboard-upcoming-recurring.test.ts`, `apps/api/test/http/dashboard-upcoming.test.ts` (+2) |  |
| RF-M8-10 | Cada bloque DEBE llevar a su módulo. Los bloques 3 a 8 se reordenan y ocultan en Ajustes. | coincide | `apps/api/test/http/dashboard-budgets.test.ts`, `apps/api/test/http/dashboard.test.ts` (+4) |  |
| RF-M8-11 | El Inicio DEBE reflejar todo cambio de datos al volver a él. | coincide | `e2e/m8-dashboard-cards.spec.ts` |  |
| EC-M8-01 | Usuario sin cuentas. El Inicio invita a crear la primera cuenta. | coincide | `e2e/m8-dashboard-cards.spec.ts` |  |
| EC-M8-02 | Mes sin movimientos. Las tarjetas muestran 0, la tasa de ahorro se oculta y los gráficos muestran su estado… | coincide | `apps/api/test/integration/dashboard-cards.test.ts`, `e2e/m8-dashboard-cards.spec.ts` |  |
| EC-M8-03 | Mes actual el día 31 contra un mes anterior de 30 días. Se compara con el mes anterior completo. | coincide | `packages/domain/test/dashboard.test.ts` |  |
| EC-M8-04 | No hay ninguna tasa. Los saldos en otra moneda no se convierten y se indica "Sin tipo de cambio". | coincide | `apps/api/test/http/dashboard.test.ts`, `e2e/m8-dashboard-blocks.spec.ts` |  |

### M9 — Ajustes y personalización

| ID | Lo que pide la spec (resumen) | Estado | Evidencia | Nota |
|---|---|---|---|---|
| RF-M9-01 | TODOS los ajustes, incluidos el tema y la barra lateral contraída, DEBEN guardarse en la cuenta y verse… | coincide | `apps/api/test/http/settings.test.ts`, `apps/web/test/formatters.test.ts` (+3) |  |
| RF-M9-02 | El símbolo de la moneda DEBE ir antes del monto, separado por un espacio ("Bs 35,00", "$ 97,09"). Al escribir… | coincide | `apps/web/test/formatters.test.ts`, `packages/domain/test/format-money.test.ts` (+1) |  |
| RF-M9-03 | Todas las fechas y montos de la app DEBEN respetar los formatos elegidos. Las listas usan expresiones… | coincide | `apps/web/test/formatters.test.ts`, `packages/domain/test/format-date.test.ts` (+1) |  |
| RF-M9-04 | El primer día de la semana DEBE aplicarse al calendario. | coincide | `packages/domain/test/format-date.test.ts` |  |
| RF-M9-05 | "Restablecer" NO DEBE tocar datos: cuentas, movimientos, categorías, atajos, monedas ni moneda base. En… | coincide | `apps/api/test/http/settings-reset.test.ts`, `e2e/m9-settings-general.spec.ts` |  |
| RF-M9-06 | NO existen valores globales de presupuestos. Cada presupuesto se configura por separado (M11). | coincide | `apps/api/test/integration/budgets-create.test.ts`, `e2e/m11-budget-form.spec.ts` |  |
| EC-M9-01 | Se cambia un ajuste en dos dispositivos a la vez. Gana el último guardado, y el otro dispositivo lo refleja… | coincide | `apps/api/test/http/settings.test.ts`, `e2e/m9-settings-general.spec.ts` |  |
| EC-M9-02 | Se elige como cuenta por defecto una cuenta que luego se archiva. Se aplica EC-M7-05. | coincide | `apps/api/test/http/settings-register.test.ts`, `e2e/m9-settings-register.spec.ts` |  |

### M10 — Onboarding

| ID | Lo que pide la spec (resumen) | Estado | Evidencia | Nota |
|---|---|---|---|---|
| RF-M10-01 | El progreso DEBE guardarse en la cuenta en cada paso. Si se interrumpe, retoma en el paso pendiente, en… | coincide | `apps/api/test/http/onboarding.test.ts`, `apps/api/test/integration/onboarding-step1.test.ts` (+2) |  |
| RF-M10-02 | Saltar el paso 1 DEBE dejar BOB como moneda base. | coincide | `apps/api/test/http/onboarding.test.ts`, `apps/api/test/integration/onboarding-step1.test.ts` (+1) |  |
| RF-M10-03 | Saltar el paso 2 NO DEBE crear ninguna cuenta. | coincide | `apps/api/test/http/onboarding.test.ts`, `apps/api/test/integration/onboarding-step1.test.ts` |  |
| RF-M10-04 | Los saldos del paso 2 DEBEN cumplir las reglas de saldo inicial (RF-M4-02), con fecha de hoy. | coincide | `apps/api/test/http/onboarding.test.ts`, `apps/api/test/integration/onboarding-step2.test.ts` (+2) |  |
| RF-M10-05 | En el paso 3, la categoría del sistema "Deudas y préstamos" NO DEBE poder desmarcarse. | coincide | `apps/api/test/http/onboarding.test.ts`, `apps/api/test/integration/onboarding-step3.test.ts` (+1) |  |
| RF-M10-06 | Saltar el paso 3 DEBE conservar todas las categorías precargadas. | coincide | `apps/api/test/http/onboarding.test.ts`, `apps/api/test/integration/onboarding-step1.test.ts` |  |
| EC-M10-01 | Se ingresa un saldo negativo para el efectivo. Se rechaza con la explicación. | coincide | `apps/api/test/http/onboarding.test.ts`, `apps/api/test/integration/onboarding-step2.test.ts` (+1) |  |
| EC-M10-02 | Se renombran dos cuentas con el mismo nombre. Se rechaza por duplicado (RF-M4-01). | coincide | `apps/api/test/http/onboarding.test.ts`, `apps/api/test/integration/onboarding-step2.test.ts` (+1) |  |
| EC-M10-03 | Se desmarcan todas las categorías de gasto, o todas las de ingreso. Se permite. Registrar mostrará "Ver… | coincide | `apps/api/test/integration/onboarding-step3.test.ts`, `e2e/m10-onboarding-step3.spec.ts` |  |

### M11 — Presupuestos

| ID | Lo que pide la spec (resumen) | Estado | Evidencia | Nota |
|---|---|---|---|---|
| RF-M11-01 | DEBE existir como máximo un presupuesto activo o pausado por categoría o subcategoría de gasto, más uno… | coincide | `apps/api/test/integration/budgets-create.test.ts`, `packages/db/test/schema-budgets.test.ts` (+1) |  |
| RF-M11-02 | Los presupuestos se anidan. Un gasto cuenta en el presupuesto de su subcategoría, en el de su padre y en el… | coincide | `apps/api/test/integration/budget-repositories.test.ts`, `apps/api/test/integration/budgets-create.test.ts` |  |
| RF-M11-03 | El gasto de un presupuesto DEBE sumar los gastos de su alcance dentro del período, excluyendo lo que indica… | coincide | `apps/api/test/integration/budget-repositories.test.ts` |  |
| RF-M11-04 | El período DEBE empezar el día elegido, que va de 1 a 28. | coincide | `packages/contracts/test/budgets.test.ts`, `packages/db/test/schema-budgets.test.ts` (+1) |  |
| RF-M11-05 | Disponible = monto del período + arrastre (positivo o negativo). Un período puede empezar ya superado: se… | coincide | `apps/api/test/integration/budgets-decision.test.ts`, `packages/domain/test/budget-math.test.ts` (+1) |  |
| RF-M11-06 | El monto, la acción por defecto y los umbrales DEBEN aplicarse al período actual al editarlos. Los períodos… | coincide | `apps/api/test/integration/budgets-lifecycle.test.ts` |  |
| RF-M11-07 | Un cambio del día de inicio DEBE aplicarse desde el próximo período: el período en curso se alarga hasta el… | coincide | `apps/api/test/integration/budgets-close-job.test.ts`, `apps/api/test/integration/budgets-lifecycle.test.ts` (+3) |  |
| RF-M11-08 | En el cierre, sobrante o exceso = disponible − gastado. El sobrante DEBE repartirse entre arrastrar, enviar a… | coincide | `apps/api/test/integration/budgets-decision.test.ts`, `packages/contracts/test/budgets.test.ts` (+2) |  |
| RF-M11-09 | "Enviar a meta" DEBE: | coincide | `apps/api/test/integration/budgets-decision.test.ts`, `e2e/m11-close-decision.spec.ts` |  |
| RF-M11-10 | Si en 7 días no hay decisión, el sistema DEBE aplicar la acción por defecto del presupuesto. Ante un exceso,… | coincide | `apps/api/test/integration/budgets-close-job.test.ts`, `apps/api/test/integration/budgets-default-job.test.ts` (+2) |  |
| RF-M11-11 | Los movimientos tardíos (cargados, editados o eliminados con fecha de un período ya cerrado, sin límite de… | coincide | `apps/api/test/integration/budget-ledger-hook.test.ts` |  |
| RF-M11-12 | "Reiniciar arrastre" DEBE poner el acumulado en 0, con una confirmación que muestra el monto. | coincide | `apps/api/test/integration/budgets-lifecycle.test.ts`, `e2e/m11-budgets.spec.ts` |  |
| RF-M11-13 | Los umbrales (de 0 a 3, entre 1 % y 150 %) DEBEN medirse sobre el monto del período, no sobre el disponible: | coincide | `apps/api/test/integration/budget-ledger-hook.test.ts`, `apps/api/test/integration/budgets-close-job.test.ts` (+4) |  |
| RF-M11-14 | Un presupuesto superado DEBE seguir contando gastos y mostrarse como superado. | coincide | `packages/domain/test/budget-math.test.ts`, `e2e/m11-budgets.spec.ts` |  |
| EC-M11-01 | El arrastre negativo supera el monto del período. El período empieza superado y la barra lo muestra. | coincide | `packages/domain/test/budget-math.test.ts`, `e2e/m11-budgets.spec.ts` |  |
| EC-M11-02 | En el cierre se envía a una meta más que el saldo libre de la cuenta elegida. Se rechaza y se pide otra… | coincide | `apps/api/test/integration/budgets-decision.test.ts` |  |
| EC-M11-03 | Se elimina o se archiva la meta elegida mientras el cierre está pendiente. Esa opción desaparece de la… | coincide | `apps/api/test/integration/budgets-decision.test.ts`, `e2e/m11-close-decision.spec.ts` |  |
| EC-M11-04 | Se archiva la categoría con una decisión de cierre pendiente. La decisión sigue disponible hasta los 7 días. | coincide | `apps/api/test/integration/categories-budgets.test.ts` |  |
| EC-M11-05 | Se elimina un gasto de un período cerrado cuya decisión incluyó arrastrar. El arrastre del período en curso… | coincide | `apps/api/test/integration/budget-ledger-hook.test.ts` |  |
| EC-M11-06 | Se intenta crear un segundo presupuesto para la misma categoría. Se rechaza y se ofrece editar el existente. | coincide | `apps/api/test/http/budgets.test.ts`, `apps/api/test/integration/budgets-create.test.ts` (+1) |  |
| EC-M11-07 | Se cambia el día de inicio de 1 a 15 durante el período del 1 al 31 de octubre. Ese período se alarga hasta… | coincide | `packages/domain/test/budget-periods.test.ts` |  |
| EC-M11-08 | Se reanuda a mitad de período un presupuesto pausado. El período que contiene hoy cuenta el gasto desde su… | coincide | `apps/api/test/integration/budgets-lifecycle.test.ts` |  |
| EC-M11-09 | Se archiva la categoría de un presupuesto. Al cerrar su último período, la decisión ofrece descartar o enviar… | coincide | `apps/api/test/integration/budgets-close-job.test.ts`, `apps/api/test/integration/budgets-decision.test.ts` (+1) |  |

### M12 — Metas de ahorro

| ID | Lo que pide la spec (resumen) | Estado | Evidencia | Nota |
|---|---|---|---|---|
| RF-M12-01 | El nombre DEBE tener de 1 a 40 caracteres, el objetivo DEBE ser mayor que 0 y la fecha objetivo, si existe,… | coincide | `apps/api/test/integration/goal-milestones.test.ts`, `apps/api/test/integration/goals-crud.test.ts` (+3) |  |
| RF-M12-02 | El progreso DEBE ser el saldo de su cuenta dedicada (si tiene, con mínimo 0) más sus apartados en otras… | coincide | `apps/api/test/integration/goals-crud.test.ts`, `packages/domain/test/goals.test.ts` (+1) |  |
| RF-M12-03 | Una meta DEBE tener como máximo una cuenta dedicada, que no puede ser una tarjeta. Una cuenta dedicada… | coincide | `apps/api/test/integration/goals-earmarks.test.ts`, `packages/db/test/schema-goals-debts.test.ts` (+1) |  |
| RF-M12-04 | Una cuenta normal que no sea tarjeta PUEDE tener apartados de varias metas. Solo se aparta dentro del saldo… | coincide | `apps/api/test/integration/goal-repositories.test.ts`, `apps/api/test/integration/goals-earmarks.test.ts` |  |
| RF-M12-05 | El sistema DEBE pedir confirmación antes de guardar toda operación que deje el saldo de una cuenta por debajo… | coincide | `apps/api/test/integration/balance-guard-earmarks.test.ts`, `apps/api/test/integration/earmark-protection.test.ts` (+3) |  |
| RF-M12-06 | Aporte mensual sugerido = (objetivo − progreso) ÷ meses calendario restantes, incluido el actual. Además: | coincide | `apps/api/test/integration/goals-crud.test.ts`, `packages/domain/test/goals.test.ts` (+1) |  |
| RF-M12-07 | El detalle DEBE mostrar el progreso por cuenta, la historia de apartados y retiros con su origen (manual,… | coincide | `apps/api/test/integration/goal-repositories.test.ts`, `apps/api/test/integration/goals-crud.test.ts` (+1) |  |
| RF-M12-08 | El total neto de Cuentas NO DEBE cambiar por los apartados. El desglose suma la línea "Apartado para metas":… | coincide | `apps/api/test/integration/accounts-goals.test.ts`, `e2e/i18n-direct-load.spec.ts` |  |
| RF-M12-09 | "Usar y cerrar" DEBE liberar todos los apartados, convertir la cuenta dedicada en normal y archivar la meta… | coincide | `apps/api/test/integration/goals-lifecycle.test.ts`, `e2e/m12-goal-dialogs.spec.ts` |  |
| EC-M12-01 | Se intenta apartar más que el saldo libre. Se rechaza indicando el saldo libre. | coincide | `apps/api/test/http/goals.test.ts`, `apps/api/test/integration/goals-earmarks.test.ts` (+1) |  |
| EC-M12-02 | Se intenta archivar una cuenta con apartados. Se rechaza indicando qué metas debe liberar primero. | coincide | `apps/api/test/integration/accounts-goals.test.ts` |  |
| EC-M12-03 | Una meta en USD con apartados en BOB baja del 100 % porque el dólar subió. Pasa a En curso. | coincide | `packages/domain/test/goals.test.ts` |  |
| EC-M12-04 | La cuenta dedicada queda en negativo (un banco con sobregiro). Aporta 0 a la meta, nunca un valor negativo. | coincide | `packages/domain/test/goals.test.ts` |  |
| EC-M12-05 | Un recurrente automático tocaría dinero apartado. No se registra y pasa a pendiente (M14). | coincide | `apps/api/test/integration/recurring-generate-job.test.ts` |  |
| EC-M12-06 | Se dedica a una meta una cuenta que ya tiene apartados de otras metas. Se rechaza: primero hay que liberar… | coincide | `apps/api/test/http/goals.test.ts`, `apps/api/test/integration/goals-earmarks.test.ts` |  |
| EC-M12-07 | Se registra un ajuste negativo en un banco y su saldo quedaría por debajo de lo apartado. Se pide la… | coincide | `apps/api/test/integration/balance-guard-earmarks.test.ts`, `apps/api/test/integration/earmark-protection.test.ts` (+1) |  |
| EC-M12-08 | Se intenta dedicar una tarjeta a una meta. La opción no está disponible. | coincide | `apps/api/test/integration/goals-earmarks.test.ts`, `e2e/m12-goal-dialogs.spec.ts` |  |

### M13 — Deudas y préstamos

| ID | Lo que pide la spec (resumen) | Estado | Evidencia | Nota |
|---|---|---|---|---|
| RF-M13-01 | La persona DEBE tener de 1 a 40 caracteres, con autocompletado sobre las personas ya usadas. El monto es… | coincide | `apps/api/test/integration/debts-create.test.ts`, `packages/contracts/test/debts.test.ts` (+2) |  |
| RF-M13-02 | El interés simple DEBE acumularse día a día sobre el capital pendiente, desde la fecha de inicio (aunque sea… | coincide | `apps/api/test/integration/debts-create.test.ts`, `packages/domain/test/debts.test.ts` |  |
| RF-M13-03 | La tasa y el período de interés DEBEN quedar fijos al crear la deuda. | coincide | `packages/contracts/test/debts.test.ts` |  |
| RF-M13-04 | El interés ya acumulado NUNCA DEBE recalcularse: ni por pagos con fecha pasada, ni por eliminar un pago, ni… | coincide | `apps/api/test/integration/debts-delete-payment.test.ts`, `apps/api/test/integration/debts-payments.test.ts` |  |
| RF-M13-05 | En cada pago, el desglose DEBE venir precargado (interés primero) y ser editable, cumpliendo: | coincide | `apps/api/test/integration/debts-payments.test.ts`, `packages/db/test/schema-goals-debts.test.ts` (+2) |  |
| RF-M13-06 | Saldo pendiente = capital pendiente + interés acumulado no pagado. Nunca es negativo, y un pago no puede… | coincide | `apps/api/test/integration/debts-payments.test.ts`, `packages/domain/test/debts.test.ts` (+1) |  |
| RF-M13-07 | La fecha de un pago DEBE estar entre la fecha de inicio y hoy. | coincide | `apps/api/test/integration/debts-payments.test.ts` |  |
| RF-M13-08 | La parte de interés de un pago DEBE contar como gasto ("Debo") o como ingreso ("Me deben"). La parte de… | coincide | `apps/api/test/integration/debts-create.test.ts`, `apps/api/test/integration/debts-payments.test.ts` |  |
| RF-M13-09 | Un pago, o el movimiento inicial, en una cuenta de otra moneda DEBE pedir el tipo de cambio usado, precargado… | coincide | `apps/api/test/integration/debts-create.test.ts`, `apps/api/test/integration/debts-payments.test.ts` (+1) |  |
| RF-M13-10 | La edición DEBE cumplir: | coincide | `apps/api/test/integration/debts-lifecycle.test.ts`, `packages/contracts/test/debts.test.ts` |  |
| RF-M13-11 | Al eliminar una deuda con movimientos asociados (el inicial o pagos), el usuario DEBE elegir entre "Eliminar… | coincide | `apps/api/test/integration/debts-lifecycle.test.ts`, `e2e/m13-debts.spec.ts` |  |
| RF-M13-12 | "Condonar saldo" DEBE cerrar la deuda en Condonada, mostrar el monto condonado y no crear movimientos. | coincide | `apps/api/test/integration/debts-lifecycle.test.ts`, `e2e/m13-debts.spec.ts` |  |
| RF-M13-13 | El resumen DEBE mostrar el total que se debe y el total que deben al usuario, en moneda base con la… | coincide | `apps/api/test/integration/debt-repositories.test.ts`, `apps/api/test/integration/debts-create.test.ts` (+1) |  |
| RF-M13-14 | Los avisos de vencimiento (desde la V1.1), en ambas direcciones, DEBEN llegar 3 días antes, el día del… | coincide | `apps/api/test/integration/notifications-debts-job.test.ts` |  |
| EC-M13-01 | Un pago supera el saldo pendiente. Se rechaza indicando el saldo. | coincide | `apps/api/test/integration/debts-payments.test.ts`, `packages/domain/test/debts.test.ts` |  |
| EC-M13-02 | El capital llega a 0 pero queda interés acumulado sin pagar. La deuda sigue Activa (o Vencida) hasta… | coincide | `packages/domain/test/debts.test.ts` |  |
| EC-M13-03 | El pago sale del efectivo y lo dejaría en negativo. Se rechaza (M4). | coincide | `apps/api/test/integration/debts-payments.test.ts` |  |
| EC-M13-04 | El pago sale de una cuenta con apartados. Se aplica la confirmación de M12. | coincide | `apps/api/test/integration/debts-payments.test.ts`, `e2e/m13-debt-forms.spec.ts` |  |
| EC-M13-05 | Se intenta eliminar un pago que no es el último. La acción no está disponible. | coincide | `apps/api/test/integration/debts-delete-payment.test.ts`, `e2e/m13-debts.spec.ts` |  |
| EC-M13-06 | La misma persona aparece en "Debo" y en "Me deben". La vista por persona muestra el neto. | coincide | `apps/api/test/integration/debt-repositories.test.ts`, `apps/api/test/integration/debts-create.test.ts` |  |
| EC-M13-07 | Se elimina el último pago de una deuda Pagada. Vuelve a Activa (o Vencida): el capital se restablece y el… | coincide | `apps/api/test/integration/debts-delete-payment.test.ts` |  |
| EC-M13-08 | Se crea hoy una deuda con interés y fecha de inicio el 1 de enero. El interés se acumula desde el 1 de enero. | coincide | `apps/api/test/integration/debts-create.test.ts` |  |

### M14 — Recurrentes

| ID | Lo que pide la spec (resumen) | Estado | Evidencia | Nota |
|---|---|---|---|---|
| RF-M14-01 | Las frecuencias DEBEN ser diaria, semanal, mensual con día fijo y anual. Una regla semanal tiene un solo día… | coincide | `packages/contracts/test/recurring.test.ts`, `packages/domain/test/recurrence.test.ts` (+1) |  |
| RF-M14-02 | Si el día elegido no existe en un mes, la ocurrencia DEBE caer el último día del mes. El 29 de febrero pasa… | coincide | `packages/domain/test/dates.test.ts`, `packages/domain/test/recurrence.test.ts` |  |
| RF-M14-03 | La fecha de inicio DEBE ser hoy o futura. El sistema NUNCA genera ocurrencias con fecha anterior a la fecha… | coincide | `apps/api/test/integration/recurring-create.test.ts`, `packages/contracts/test/recurring.test.ts` (+1) |  |
| RF-M14-04 | Las ocurrencias DEBEN ejecutarse a las 00:00 en la zona horaria del usuario. Si ese día no existe la 00:00… | coincide | `apps/api/test/integration/recurring-generate-job.test.ts`, `apps/api/test/integration/timezones.test.ts` |  |
| RF-M14-05 | Una ocurrencia automática DEBE quedar como pendiente si dejaría una cuenta en negativo (M4) o si tocaría… | coincide | `apps/api/test/integration/recurring-generate-job.test.ts` |  |
| RF-M14-06 | En una transferencia recurrente entre monedas distintas, el modo automático DEBE usar la precarga de RF-M3-07… | coincide | `apps/api/test/integration/recurring-confirm.test.ts`, `apps/api/test/integration/recurring-generate-job.test.ts` |  |
| RF-M14-07 | Un pendiente sin decisión DEBE pasar a Omitido a los 30 días de generado, con un aviso. Esto vale también… | coincide | `apps/api/test/integration/recurring-expire-job.test.ts` |  |
| RF-M14-08 | Un pendiente se confirma con su fecha original o con otra, sin fechas futuras. Puede ser anterior al saldo… | coincide | `apps/api/test/integration/recurring-confirm.test.ts`, `e2e/m14-recurring.spec.ts` |  |
| RF-M14-09 | Al reanudar una regla, el sistema DEBE preguntar qué ocurrencias saltadas registrar. Se registran con su… | coincide | `apps/api/test/integration/recurring-resume.test.ts`, `packages/domain/test/recurrence.test.ts` (+1) |  |
| RF-M14-10 | Editar una regla DEBE afectar solo a las ocurrencias futuras. Los pendientes y los movimientos ya creados no… | coincide | `apps/api/test/integration/recurring-update-delete.test.ts` |  |
| RF-M14-11 | Eliminar una regla DEBE conservar los movimientos creados y borrar sus pendientes. | coincide | `apps/api/test/integration/recurring-update-delete.test.ts`, `packages/db/test/schema-integrity.test.ts` |  |
| RF-M14-12 | NUNCA DEBE existir más de una ocurrencia de la misma regla para la misma fecha. Si el sistema estuvo caído,… | coincide | `apps/api/test/integration/jobs-resume.test.ts`, `apps/api/test/integration/recurring-generate-job.test.ts` (+2) |  |
| RF-M14-13 | La pantalla DEBE mostrar: | coincide | `apps/api/test/integration/recurring-create.test.ts`, `packages/domain/test/recurrence.test.ts` (+1) |  |
| RF-M14-14 | El monto DEBE ser obligatorio en modo automático y opcional en modo confirmación. Una regla sin monto se… | coincide | `apps/api/test/integration/recurring-create.test.ts`, `packages/contracts/test/recurring.test.ts` (+3) |  |
| RF-M14-15 | Cada regla DEBE tener un nombre de 1 a 40 caracteres, que se usa en la etiqueta "De recurrente: X", en la… | coincide | `packages/contracts/test/recurring.test.ts`, `packages/db/test/schema-recurring-notifications.test.ts` |  |
| EC-M14-01 | Una regla mensual con el día 31 en noviembre. La ocurrencia cae el 30 de noviembre. | coincide | `packages/domain/test/recurrence.test.ts` |  |
| EC-M14-02 | Se archiva la cuenta de la regla. La regla se pausa con un aviso para elegir otra cuenta. | coincide | `apps/api/test/integration/recurring-cascades.test.ts` |  |
| EC-M14-03 | El sistema estuvo caído 2 días. Al volver, crea las ocurrencias de esos días una sola vez. | coincide | `apps/api/test/integration/recurring-generate-job.test.ts` |  |
| EC-M14-04 | Se elimina una regla con un pendiente. El pendiente desaparece. | coincide | `apps/api/test/integration/recurring-update-delete.test.ts` |  |
| EC-M14-05 | Se reanuda una regla de "12 veces" que generó 11 ocurrencias antes de la pausa, y el usuario quiere registrar… | coincide | `apps/api/test/integration/recurring-resume.test.ts`, `packages/domain/test/recurrence.test.ts` |  |
| EC-M14-06 | Se reanuda una regla cuya fecha de fin pasó durante la pausa. Queda Finalizada y solo ofrece registrar las… | coincide | `apps/api/test/integration/recurring-resume.test.ts`, `packages/domain/test/recurrence.test.ts` |  |
| EC-M14-07 | Se crea a las 15:00 una regla que empieza hoy. La ocurrencia de hoy se crea al guardar. | coincide | `apps/api/test/integration/recurring-create.test.ts` |  |

### M15 — Recordatorios y avisos

| ID | Lo que pide la spec (resumen) | Estado | Evidencia | Nota |
|---|---|---|---|---|
| RF-M15-01 | Todos los avisos DEBEN llegar solo dentro de la app, sin correo de avisos ni notificaciones push. | coincide | `apps/api/test/integration/notification-emitter.test.ts`, `packages/contracts/test/notifications.test.ts` |  |
| RF-M15-02 | Los tipos y sus valores por defecto DEBEN ser: | coincide | `apps/api/test/http/notification-preferences.test.ts`, `apps/api/test/integration/goal-milestones.test.ts` (+6) |  |
| RF-M15-03 | Todos los tipos DEBEN poder desactivarse. Desactivar un tipo de decisión no oculta la decisión: los… | coincide | `apps/api/test/http/dashboard-upcoming-recurring.test.ts`, `apps/api/test/http/notification-preferences.test.ts` (+4) |  |
| RF-M15-04 | Un mismo evento NUNCA DEBE generar dos avisos (RN-10). Cada hito de meta avisa una sola vez, aunque el tipo… | coincide | `apps/api/test/integration/goal-milestones.test.ts`, `apps/api/test/integration/notification-emitter.test.ts` |  |
| RF-M15-05 | Los avisos DEBEN borrarse solos a los 90 días, salvo los que esperan una decisión. | coincide | `apps/api/test/integration/maintenance-notifications.test.ts` |  |
| RF-M15-06 | El contador de la campana DEBE mostrar los avisos no leídos. | coincide | `apps/api/test/http/notifications.test.ts`, `e2e/m15-inbox.spec.ts` |  |
| RF-M15-07 | En la V1.1 existen la campana, la bandeja y los avisos de alertas de presupuesto, cierre de período y… | coincide | `apps/api/test/http/notification-preferences.test.ts`, `apps/api/test/integration/notification-emitter.test.ts` (+1) |  |
| RF-M15-08 | El aviso de "cambio fuerte del dólar" NO existe. | coincide | `packages/contracts/test/notifications.test.ts` |  |
| RF-M15-09 | Los avisos programados sin hora configurable (vencimientos de deudas y tarjetas, pagos próximos, avance… | coincide | `apps/api/test/http/notification-preferences.test.ts`, `apps/api/test/integration/notifications-debts-job.test.ts` (+1) |  |
| RF-M15-10 | Al reactivar un tipo de aviso, NO DEBEN generarse avisos de lo ocurrido mientras estaba desactivado. | coincide | `apps/api/test/integration/notifications-payments-job.test.ts` |  |
| RF-M15-11 | Al tocar un aviso de algo que ya no existe (deuda, meta, regla), el sistema DEBE mostrar "Esto ya no existe"… | coincide | `e2e/m15-inbox.spec.ts` |  |
| RF-M15-12 | "Marcar todo como leído" y eliminar un aviso DEBEN funcionar también con los avisos que esperan una decisión.… | coincide | `apps/api/test/http/notifications.test.ts`, `e2e/m15-inbox.spec.ts` |  |
| EC-M15-01 | El usuario resuelve un pendiente desde Recurrentes. El aviso de la bandeja queda Resuelto. | coincide | `apps/api/test/integration/recurring-confirm.test.ts`, `e2e/m14-inbox-pending.spec.ts` |  |
| EC-M15-02 | Se cambia el día de pago de una tarjeta después de generado su aviso. El aviso ya generado no se repite, y el… | coincide | `apps/api/test/integration/notifications-payments-job.test.ts` |  |
| EC-M15-03 | El aviso "Registrar el día" se genera aunque ya haya movimientos ese día, porque es el comportamiento elegido. | coincide | `apps/api/test/integration/notifications-log-day-job.test.ts` |  |

### RNF — Requerimientos no funcionales

| ID | Lo que pide la spec (resumen) | Estado | Evidencia | Nota |
|---|---|---|---|---|
| RNF-01 | Registrar un movimiento DEBE tomar menos de 10 segundos desde abrir la app (flujo M7). | no verificable | `apps/web/test/bundle-budget.test.ts`, `e2e/perf.spec.ts` | La prueba E2E lo simula (4G y CPU x4); la spec pide medirlo en un celular de gama media real. |
| RNF-02 | Guardar un movimiento DEBE tardar menos de 1 segundo en el 95 % de los casos. | no verificable | `apps/api/test/integration/performance.test.ts` | El p95 se mide en el dispositivo y la red reales; la prueba mide en local. |
| RNF-03 | El Inicio DEBE cargar en menos de 2 segundos con 5.000 movimientos, en una conexión 4G. | no verificable | `apps/api/test/integration/account-ledger-repositories.test.ts`, `apps/api/test/integration/dashboard-cost.test.ts` (+7) | Celular de gama media en 4G; la prueba usa 5.000 movimientos con red simulada. |
| RNF-04 | La actualización del tipo de cambio NUNCA DEBE bloquear ni demorar el uso de la app. | coincide | `apps/api/test/http/rates.test.ts` |  |
| RNF-05 | La app DEBE funcionar desde 360 px de ancho en las 2 últimas versiones mayores de Chrome, Safari y Firefox,… | no verificable | `e2e/a11y-v1-0.spec.ts`, `e2e/a11y-v1-1.spec.ts` (+4) | Playwright corre los motores Chromium, WebKit y Firefox, no las 2 últimas versiones publicadas de cada navegador ni un celular real. |
| RNF-06 | La app DEBE cumplir WCAG 2.2 nivel AA y ser usable por completo con teclado. Toda acción por gesto DEBE tener… | coincide | `packages/contracts/test/catalogs.test.ts`, `e2e/a11y-v1-0.spec.ts` (+12) |  |
| RNF-07 | Todos los textos DEBEN estar en español de Bolivia y preparados para traducirse. | coincide | `apps/web/test/i18n-errors.test.ts`, `e2e/a11y-v1-2.spec.ts` (+1) |  |
| RNF-08 | El mismo usuario PUEDE usar varios dispositivos a la vez. Ante ediciones simultáneas del mismo dato, gana la… | coincide | `apps/api/test/http/settings.test.ts`, `apps/api/test/integration/transactions-update.test.ts` |  |
| RNF-09 | Una acción sobre un dato eliminado en otro dispositivo DEBE informar que el dato ya no existe, sin guardar… | coincide | `apps/api/test/integration/transactions-delete-undo.test.ts`, `apps/api/test/integration/transactions-update.test.ts` |  |
| RNF-10 | Las validaciones de saldo (negativos y apartados) DEBEN evaluarse con el saldo vigente al momento de guardar,… | coincide | `apps/api/test/integration/balance-guard-earmarks.test.ts`, `apps/api/test/integration/balance-guard.test.ts` (+3) |  |
| RNF-11 | Un doble toque, un reintento o una reconexión NUNCA DEBEN duplicar movimientos, pagos, apartados ni… | coincide | `apps/api/test/integration/budgets-decision.test.ts`, `apps/api/test/integration/concurrency-sweep.test.ts` (+3) |  |
| RNF-12 | Un recurrente genera como máximo una ocurrencia por regla y fecha. Un cierre de presupuesto se decide una… | coincide | `apps/api/test/integration/budget-ledger-hook.test.ts`, `apps/api/test/integration/budgets-default-job.test.ts` (+6) |  |
| RNF-13 | Los procesos automáticos que se interrumpan DEBEN retomarse sin duplicar ni omitir lo pendiente. | coincide | `apps/api/test/integration/budgets-close-job.test.ts`, `apps/api/test/integration/budgets-default-job.test.ts` (+6) |  |
| RNF-14 | Cada usuario accede SOLO a sus datos. Un dato ajeno se comporta como inexistente. | coincide | `apps/api/test/http/budgets.isolation.test.ts`, `apps/api/test/http/dashboard-budgets.test.ts` (+18) |  |
| RNF-15 | Los mensajes de registro, recuperación e inicio de sesión NO DEBEN revelar si un correo tiene cuenta ni cuál… | coincide | `apps/api/test/http/auth.test.ts`, `apps/api/test/integration/auth-signin.test.ts` (+4) |  |
| RNF-16 | El usuario DEBE poder exportar todos sus datos y eliminarlos por completo y de inmediato. | coincide | `apps/api/test/http/me-delete.test.ts`, `apps/api/test/http/me-export-v1-1.test.ts` (+2) |  |
| RNF-17 | La app NUNCA DEBE mostrar al usuario detalles internos en los mensajes de error. | coincide | `apps/api/test/http/app.test.ts`, `apps/api/test/http/logs-secrets.test.ts` (+3) |  |
| RNF-18 | Los cálculos DEBEN ser exactos al centavo, con el redondeo de RN-06. No deben acumularse diferencias por… | coincide | `packages/domain/test/debts.test.ts`, `packages/domain/test/money.test.ts` |  |
| RNF-19 | Los valores históricos (movimientos, períodos cerrados, interés acumulado) NUNCA DEBEN cambiar por… | coincide | `packages/domain/test/fx-convert.test.ts`, `apps/api/test/integration/dashboard-cards.test.ts` | D-03 resuelta en TASK-274: las dos pruebas citan RNF-19. |
| RNF-20 | Todas las fechas de negocio (día de un movimiento, períodos, vencimientos, ejecución de recurrentes y avisos)… | coincide | `apps/api/test/integration/budgets-close-job.test.ts`, `apps/api/test/integration/notifications-debts-job.test.ts` (+3) |  |
| RNF-21 | Si fallan las fuentes del tipo de cambio, la app DEBE seguir funcionando con el último valor guardado (M3). | coincide | `apps/api/test/integration/fx-jobs.test.ts` |  |
| RNF-22 | Si falla el servicio de correo, el usuario DEBE poder reenviar los correos de la cuenta respetando los… | coincide | `apps/api/test/integration/outbox.test.ts` |  |
| RNF-23 | Sin conexión, la app DEBE bloquearse por completo, incluido Registrar, sin perder los borradores (M2). Es una… | coincide | `apps/web/test/online.test.ts`, `e2e/m2-offline-session.spec.ts` |  |
| RNF-24 | En la V1 no existe un historial de ediciones por movimiento. | coincide | `apps/api/test/integration/transactions-update.test.ts` |  |
| RNF-25 | Los eventos de seguridad (cambio de contraseña y eliminación de la cuenta) DEBEN notificarse al dueño por… | coincide | `apps/api/test/http/me-delete.test.ts`, `apps/api/test/integration/auth-password.test.ts` (+1) |  |
| RNF-26 | Retención: | coincide | `apps/api/test/integration/maintenance-auth.test.ts`, `apps/api/test/integration/maintenance-notifications.test.ts` (+1) |  |
| RNF-27 | La fuente "paralelo.bo" DEBE mostrarse junto a sus datos, como exige su licencia de uso. | coincide | `apps/api/test/http/rates.test.ts` |  |
| RNF-28 | Cada usuario tiene como máximo 50 cuentas, 300 categorías, 50 metas, 200 deudas, 100 presupuestos, 100 reglas… | coincide | `apps/api/test/integration/budgets-create.test.ts`, `apps/api/test/integration/categories-crud.test.ts` (+4) |  |
| RNF-29 | Cambiar de pestaña DEBE mostrar sus datos principales en menos de 2 segundos en una conexión 4G, con el… | no verificable | `apps/api/test/http/server-timing.test.ts`, `apps/api/test/http/session-middlewares.test.ts` (+9) | Red 4G real con el servicio activo; la prueba usa latencia simulada (`DB_LATENCY_MS`). |

### Totales

| Filas | coincide | difiere | no verificable |
|---|---|---|---|
| 311 | 306 | 0 | 5 |

## 3. Diferencias

| # | Documento | Sección | Lo que dice | Lo que hace el código | Corrección propuesta | Cambia |
|---|---|---|---|---|---|---|
| D-01 | `spec.md` | §2.1.4 EC-M1-11 | Al confirmar el correo de A en un navegador con la sesión de B, "se cierra la sesión de B, su borrador se descarta y se inicia la de A". | `POST /api/auth/confirmation/status` cierra la sesión de B y abre la de A (`auth.service.ts`, `e2e/m1-sign-up-confirm-sync.spec.ts`), pero `CheckEmail.onConfirmed` (`apps/web/src/features/auth/components/check-email.tsx`) solo invalida `['me']` y navega a `/bienvenida`: no llama a `clearAllDrafts` con el id de B, como sí lo hace el diálogo de sesión vencida (EC-M2-01). Los borradores de B quedan guardados bajo `draft:{idDeB}:…` y vuelven a aparecer cuando B inicia sesión. | Tarea nueva: en `onConfirmed`, leer el `me` anterior de la caché y, si es de otro usuario, llamar a `clearAllDrafts(previous.id)` antes de limpiar la caché; agregar el caso al E2E de EC-M1-11. | Código |
| D-02 | `plan.md` | §5.5 Matriz de trazabilidad | "Cada regla, requerimiento, caso borde y RNF de `spec.md` v1.3". | La matriz ya incluye los IDs de la v1.5 (RF-M1-18, EC-M1-13, EC-M1-14, RF-M2-13, RF-M2-14, EC-M2-04, RNF-29), y el encabezado del plan dice `spec.md` v1.5. | Cambiar "v1.3" por "v1.5" en la frase de §5.5. | Documento |
| D-03 | `spec.md` | §3.6 RNF-19 | Los valores históricos nunca cambian por el tipo de cambio ni por la configuración. | El comportamiento se cumple (tasa guardada en cada asiento, ingresos y gastos con la tasa guardada: RN-05, RN-11), pero RNF-19 es el único RF, EC o RNF que ninguna prueba cita, así que no se puede rastrear desde la spec. | Tarea nueva: citar RNF-19 en las pruebas de RN-05 que ya lo demuestran (`packages/domain/test/fx-convert.test.ts`, `apps/api/test/integration/dashboard-cards.test.ts`) o agregar una que cambie la tasa y la zona horaria y compare un período cerrado. | Código (pruebas) |
| D-04 | `plan.md` | §5.5 Matriz de trazabilidad | La fila de EC-M3-07 aparece antes que la de EC-M3-06. | No afecta al código; el resto de la matriz sigue el orden de la spec. | Poner EC-M3-06 antes de EC-M3-07. | Documento |
| D-05 | `tasks.md` | TASK-048, TASK-052, TASK-054, TASK-055, TASK-056, TASK-057, TASK-063, TASK-065 | Describen el correo de intentos fallidos y la confirmación que abría la sesión (detalle en §4). | El código sigue la v1.5 (TASK-262 a TASK-266). | Agregar a cada tarea la nota de §4, sin reescribir su texto (son tareas cerradas con su commit). | Documento |

Los requisitos marcados `no verificable` (RNF-01, RNF-02, RNF-03, RNF-05 y RNF-29) no son diferencias: el código tiene la prueba que los aproxima en el pipeline (`e2e/perf.spec.ts`, `e2e/perf-tabs.spec.ts`, las pruebas de accesibilidad en Chromium, WebKit y Firefox), pero la condición de la spec (celular de gama media, red 4G real, Safari y Firefox) solo se comprueba con una medición manual antes de cada entrega.

## 4. Tareas cerradas con texto obsoleto por la Fase 27

Su código ya fue reemplazado; el texto de la tarea describe el comportamiento anterior a la spec v1.5.

| Tarea | Texto que quedó obsoleto | Nota a agregar |
|---|---|---|
| TASK-048 | Plantillas para los 6 tipos de `email_kind`; `RNF-25` exige la plantilla de intentos fallidos. Hoy son 5 tipos, sin `login_alert`. | Reemplazada por TASK-262 y TASK-263. |
| TASK-052 | `createLoginThrottle` devuelve `shouldAlert` y "la alerta sale como máximo una vez por hora". | Reemplazada por TASK-262. |
| TASK-054 | `signUp` no entrega el ticket de registro (cookie `__Secure-signup-ticket`) ni lo guarda en `signup_ticket`. | Reemplazada por TASK-265. |
| TASK-055 | `confirm(token, currentSessionId?)` cierra la sesión de otro usuario y crea la sesión; responde `{ next: 'onboarding' }`. Hoy `confirm` solo confirma (`{ status: 'confirmed' }`) y la sesión la abre `confirmation/status`. | Reemplazada por TASK-265. |
| TASK-056 | Ante un fallo de inicio de sesión "encola `login_alert`"; el escenario espera "un solo `login_alert`". | Reemplazada por TASK-262. |
| TASK-057 | `reset` no invalida el ticket del registro anterior (EC-M1-14). | Reemplazada por TASK-265. |
| TASK-063 | Las purgas de `maintenance` no incluyen los `signup_ticket` vencidos. | Reemplazada por TASK-265. |
| TASK-065 | `ConfirmLink` navega a `/bienvenida` con la sesión abierta y `CheckEmail` no espera la confirmación. Hoy el enlace solo muestra "Correo confirmado" y la app que espera continúa sola. | Reemplazada por TASK-266. |

## 5. Pasos manuales

1. Revisar este informe y marcar qué diferencias se corrigen.
2. Los cambios de documento (D-02, D-04, D-05) van en commits `docs:` aparte.
3. Los cambios de código (D-01, D-03) van en tareas nuevas de `tasks.md`.

## 6. Seguimiento de las diferencias

Todas las diferencias de §3 quedaron resueltas en la Fase 27. La tabla de §3 se conserva como estaba al revisar.

| # | Resuelta en | Commit |
|---|---|---|
| D-01 | TASK-273: `CheckEmail` descarta los borradores de la sesión anterior al confirmar (EC-M1-11, EC-M2-01) | `40a08a7` |
| D-02 | `plan.md` §5.5 cita `spec.md` v1.5 | `e3c8aab` |
| D-03 | TASK-274: RNF-19 citado en una prueba unitaria y una de integración, con un caso nuevo de tasa, moneda base y zona horaria | `b3268c3` |
| D-04 | Matriz de `plan.md` §5.5: EC-M3-06 antes de EC-M3-07 | `e3c8aab` |
| D-05 | Nota "Reemplazada por…" en las 8 tareas cerradas de §4 | `e3c8aab` |
