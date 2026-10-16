# Especificación Funcional — App de Finanzas Personales

**Versión:** 1.0 · **Fecha:** 2026-10-15 · **Alcance:** V1 completa (V1.0, V1.1, V1.2)
**Documentos relacionados:** `docs/constitution.md` (principios innegociables) · `plan.md` y `tasks.md` (en esta misma carpeta)

Este documento define el **qué** y el **porqué**. No define el cómo técnico.

---

## 1. Visión general, actores y exclusiones

### 1.1 Visión
Aplicación web responsive para que una persona en Bolivia lleve sus finanzas personales en bolivianos y dólares, con el tipo de cambio paralelo y el oficial. La app gira alrededor de un ciclo corto:

**registrar un movimiento → ver cómo va el mes → corregir o planificar.**

**Metas medibles del producto:**
- Registrar un movimiento en menos de 10 segundos desde que se abre la app.
- Al abrir el Inicio, ver ingresos, gastos, balance y avance del mes sin navegar a otra pantalla.
- Que cada usuario configure sus cuentas, monedas, categorías, presupuestos, metas y avisos.
- Reflejar la realidad boliviana: bolivianos y dólares, paralelo y oficial, valor manual.

### 1.2 Entregas

| Entrega | Módulos |
|---|---|
| **V1.0** | M1 Acceso y cuenta · M2 Navegación · M3 Monedas y tipo de cambio · M4 Cuentas · M5 Categorías · M6 Transacciones · M7 Registrar · M8 Inicio (dashboard) · M9 Ajustes · M10 Onboarding |
| **V1.1** | M11 Presupuestos · M12 Metas de ahorro · M13 Deudas y préstamos · bandeja básica de avisos (parte de M15) |
| **V1.2** | M14 Recurrentes · M15 Recordatorios y avisos completo |

- Cada entrega DEBE quedar usable a diario antes de empezar la siguiente.
- Los módulos de entregas no liberadas NO aparecen en la interfaz.

### 1.3 Matriz de roles

| Actor | Descripción | Puede |
|---|---|---|
| **Visitante** | Persona sin sesión | Registrarse, iniciar sesión, pedir la recuperación de su contraseña, abrir los enlaces de confirmación y recuperación |
| **Usuario sin confirmar** | Se registró pero no confirmó su correo | Ver la pantalla "Revisa tu correo", reenviar la confirmación, cerrar sesión. Nada más |
| **Usuario** | Persona con sesión y correo confirmado | Todo lo descrito en este documento, SOLO sobre sus propios datos |
| **Sistema** | Procesos automáticos, sin intervención humana | Actualizar el tipo de cambio, ejecutar los recurrentes, cerrar los períodos de presupuesto, generar avisos, omitir pendientes vencidos, descartar registros sin confirmar |
| **Fuentes externas** | Mercado paralelo (paralelo.bo), Banco Central de Bolivia y servicio de correo | Proveer tasas y entregar los correos de la cuenta. Pueden fallar, y el sistema DEBE tolerarlo |

- No existen roles de administración, cuentas compartidas ni acceso de un usuario a los datos de otro.

### 1.4 Fuera de alcance (Out-of-Scope)
- Reportes (flujo de caja, comparativos, exportación a PDF).
- Inteligencia artificial: categorización, asistente, OCR, proyecciones, gastos hormiga.
- Conexión con bancos u open banking. Importación de extractos.
- Etiquetas y fotos de recibos.
- Cuentas compartidas, roles y administración.
- App nativa o instalable, notificaciones push y modo sin conexión.
- Inicio de sesión con Google y verificación en dos pasos.
- Correos de avisos o recordatorios. Solo existen los correos de la cuenta.
- Aviso de "cambio fuerte del dólar".
- Cambio del correo de la cuenta.
- Papelera de movimientos eliminados.
- Calculadora en el campo de monto y atajos de teclado propios.
- Frecuencias recurrentes "cada N" o quincenal.
- Generación de ocurrencias recurrentes pasadas al crear una regla.
- Historial de ediciones de cada movimiento (auditoría detallada).

### 1.5 Glosario
- **Moneda base:** moneda en la que se expresan los totales. BOB por defecto.
- **Referencia del dólar:** cotización que la app usa para convertir. Opciones: paralelo (compra, venta, mediana), oficial del BCB (compra, venta, promedio) o valor manual.
- **Tasa guardada:** tipo de cambio que un movimiento conserva desde que se registró. NUNCA cambia por movimientos del mercado.
- **Movimiento:** gasto, ingreso, transferencia o ajuste.
- **Movimiento vinculado:** movimiento creado por otro módulo (pago de deuda, apartado o retiro de meta, comisión). Su monto, cuenta y fecha se editan solo desde su origen.
- **Apartado:** dinero de una cuenta reservado para una meta. Sigue en la cuenta.
- **Saldo libre:** saldo de una cuenta menos sus apartados.
- **Cuenta dedicada:** cuenta cuyo saldo completo pertenece a una meta.
- **Período (de presupuesto):** lapso de un mes que empieza en el día de inicio elegido para ese presupuesto.
- **Arrastre:** saldo corrido, positivo o negativo, que un presupuesto acumula entre períodos.
- **Disponible (de presupuesto):** monto del período más (o menos) el arrastre acumulado.
- **Pendiente:** ocurrencia recurrente que espera confirmación. No cuenta en saldos ni totales.

### 1.6 Reglas de negocio transversales (RN)
Estas reglas aplican a todos los módulos y prevalecen sobre cualquier regla de módulo.

- **RN-01:** El saldo de una cuenta = saldo inicial + entradas − salidas, contando solo los movimientos con fecha igual o posterior a la del saldo inicial. NUNCA se edita a mano: se corrige con un ajuste.
- **RN-02:** NO cuentan como ingreso ni como gasto (en el Inicio ni en los presupuestos):
  - las transferencias;
  - los ajustes;
  - los pendientes;
  - los movimientos con la categoría del sistema "Deudas y préstamos". La excepción es su subcategoría "Intereses", que SÍ cuenta.
- **RN-03:** La moneda de un movimiento es SIEMPRE la de su cuenta.
- **RN-04:** Todo movimiento guarda las tasas vigentes en su fecha (la de su moneda frente al boliviano y la boliviano-dólar). Sus valores en cualquier moneda base se derivan de esas tasas guardadas y no cambian después.
- **RN-05:**
  - Los saldos y totales actuales (cuentas, deudas, metas) se convierten con la referencia vigente.
  - Los ingresos y gastos de un período se convierten con la tasa guardada en cada movimiento.
- **RN-06:** Los montos se muestran con 2 decimales. Las conversiones se redondean a 2 decimales con la mitad hacia arriba.
- **RN-07:** Un movimiento tiene fecha de hoy o anterior, nunca futura. Su fecha es el día local según la zona horaria del perfil del usuario.
- **RN-08:** Lo que tiene historia se archiva, no se elimina: cuentas y categorías con movimientos.
- **RN-09:** Cada usuario accede solo a sus propios datos. Un recurso ajeno se comporta como inexistente.
- **RN-10:** Un mismo evento nunca genera dos avisos. Una misma acción repetida (doble toque, reintento) nunca genera dos registros.

---

## 2. Desglose por módulos

---

### 2.1 M1 — Acceso y cuenta de usuario (V1.0)

#### 2.1.1 Flujos de usuario
**Registro**
1. El visitante abre "Crear cuenta" e ingresa su nombre (1-60 caracteres), su correo y una contraseña (mínimo 8 caracteres).
2. Marca la casilla obligatoria "Acepto los términos y la política de privacidad".
3. Al enviar, ve siempre el mismo mensaje: "Si el correo es válido, te enviamos un enlace para confirmar tu cuenta".
4. Si el correo es nuevo, recibe un enlace de confirmación válido por 24 h. Si el correo ya tenía cuenta, el dueño recibe un aviso: "Alguien intentó registrarse con tu correo. ¿Querías iniciar sesión?".
5. Hasta confirmar, el usuario solo ve "Revisa tu correo", con la opción de reenviar.
6. Al abrir el enlace, la cuenta queda Activa, se inicia la sesión y comienza el Onboarding (M10).

**Inicio de sesión**
1. El visitante ingresa su correo y su contraseña.
2. Si son correctos y el correo está confirmado, entra al Inicio, o al Onboarding si no lo terminó.
3. Si el correo no está confirmado, ve "Revisa tu correo".
4. Si son incorrectos, ve "Correo o contraseña incorrectos", sin indicar cuál de los dos falló.

**Recuperación de contraseña**
1. El visitante toca "Olvidé mi contraseña" e ingresa su correo. Ve el mensaje neutro.
2. Si el correo existe, recibe un enlace válido por 1 h y de un solo uso.
3. Al abrirlo, define una contraseña nueva. Se cierran todas sus sesiones, queda iniciada la sesión en el dispositivo actual y recibe un correo de confirmación del cambio.

**Perfil**
1. El usuario edita su nombre, su zona horaria y su idioma. El idioma tiene en la V1 una sola opción: "Español (Bolivia)".
2. Para cambiar la contraseña, ingresa la actual y la nueva. Al guardar, se cierran sus demás sesiones y recibe un correo de aviso.
3. El correo se muestra pero no se edita. Junto a él se explica cómo cambiarlo: exportar los datos, eliminar la cuenta y registrarse de nuevo.
4. "Cerrar sesión" cierra el dispositivo actual. "Cerrar sesión en todos los dispositivos" cierra todos.

**Exportar mis datos**
1. El usuario toca "Exportar mis datos".
2. Descarga al instante un archivo comprimido con un archivo CSV por tipo de dato: cuentas, categorías, movimientos, presupuestos, metas, deudas, recurrentes y atajos. Incluye los elementos archivados.

**Eliminar mi cuenta**
1. El usuario toca "Eliminar cuenta". Una pantalla explica qué se borra y ofrece exportar antes.
2. Para confirmar, ingresa su contraseña y escribe la palabra ELIMINAR.
3. Todos sus datos se borran al instante, se cierran todas sus sesiones y recibe un correo de confirmación. No se puede deshacer.

#### 2.1.2 Ciclo de vida y estados

**Cuenta de usuario**

| Desde | Hacia | Disparador |
|---|---|---|
| — | Sin confirmar | Registro |
| Sin confirmar | Activa | Abre un enlace de confirmación vigente |
| Sin confirmar | Descartada | Pasan 7 días sin confirmar. El correo queda libre |
| Activa | Eliminada | Eliminación confirmada |

- Prohibido: cualquier transición desde Descartada o Eliminada. Una cuenta Sin confirmar no accede a ningún dato.

**Sesión**

| Desde | Hacia | Disparador |
|---|---|---|
| — | Activa | Inicio de sesión, confirmación o recuperación |
| Activa | Activa (renovada) | Cada uso renueva el plazo de 30 días |
| Activa | Vencida | 30 días sin uso |
| Activa | Cerrada | Cerrar sesión en ese dispositivo |
| Activa | Revocada | Cerrar sesión en todos, cambio de contraseña (salvo el dispositivo actual) o eliminación de la cuenta |

**Enlace de confirmación o recuperación:** Vigente → Usado | Vencido | Invalidado (al pedir uno nuevo).

#### 2.1.3 Requerimientos funcionales
- **RF-M1-01:** El sistema DEBE exigir nombre (1-60 caracteres), correo con formato válido, contraseña de al menos 8 caracteres y la aceptación de los términos.
- **RF-M1-02:** El sistema DEBE tratar el correo sin espacios al inicio ni al final y sin distinguir mayúsculas.
- **RF-M1-03:** El sistema DEBE responder con el mismo mensaje neutro al registrarse o pedir la recuperación, exista o no el correo.
- **RF-M1-04:** El sistema DEBE impedir todo acceso a los datos hasta que el correo esté confirmado.
- **RF-M1-05:** El sistema DEBE permitir reenviar la confirmación una vez cada 60 segundos y como máximo 5 veces por hora. Cada reenvío invalida el enlace anterior.
- **RF-M1-06:** El sistema DEBE descartar los registros sin confirmar a los 7 días.
- **RF-M1-07:** El sistema DEBE mantener la sesión durante 30 días desde el último uso y permitir sesiones simultáneas en varios dispositivos.
- **RF-M1-08:** Tras 5 intentos fallidos seguidos con un mismo correo, el sistema DEBE exigir 1 minuto de espera, y tras 10, 15 minutos. Debe mostrar el tiempo restante y enviar un correo de aviso al dueño. El sistema NUNCA bloquea la cuenta de forma permanente.
- **RF-M1-09:** El enlace de recuperación DEBE vencer en 1 hora y servir una sola vez. Pedir uno nuevo invalida el anterior.
- **RF-M1-10:** Al cambiar o recuperar la contraseña, el sistema DEBE revocar todas las demás sesiones y enviar un correo de confirmación.
- **RF-M1-11:** El sistema DEBE detectar la zona horaria del dispositivo al registrarse (Bolivia, si no puede detectarla) y permitir cambiarla en el perfil.
- **RF-M1-12:** Cambiar la zona horaria NO DEBE alterar la fecha de los movimientos ya registrados.
- **RF-M1-13:** El sistema NO DEBE permitir cambiar el correo de la cuenta.
- **RF-M1-14:** La exportación DEBE incluir todos los datos del usuario, archivados incluidos, y descargarse al instante.
- **RF-M1-15:** La eliminación de la cuenta DEBE exigir la contraseña y la palabra ELIMINAR. Debe borrar todos los datos del usuario de inmediato, revocar todas las sesiones y enviar un correo de confirmación.
- **RF-M1-16:** Los únicos correos que envía el sistema son: confirmación, intento de registro con un correo existente, recuperación, cambio de contraseña, intentos fallidos y eliminación de la cuenta.

#### 2.1.4 Casos borde y excepciones
- **EC-M1-01:** Se abre un enlace de confirmación vencido o invalidado. El sistema muestra "Este enlace ya no es válido" y ofrece reenviar.
- **EC-M1-02:** Se abre un enlace de confirmación ya usado con la cuenta activa. El sistema lleva al inicio de sesión.
- **EC-M1-03:** Alguien se registra con un correo cuyo registro sin confirmar fue descartado. Se trata como un registro nuevo.
- **EC-M1-04:** Se intenta iniciar sesión durante el tiempo de espera, aunque sea con la contraseña correcta. Se rechaza y se muestra el tiempo restante.
- **EC-M1-05:** Se cambia la contraseña en el dispositivo A mientras B está abierto. B pierde la sesión en su siguiente acción y ve el inicio de sesión.
- **EC-M1-06:** Se elimina la cuenta en A mientras B está abierto. B pierde la sesión en su siguiente acción.
- **EC-M1-07:** El servicio de correo falla. El registro o la recuperación muestran el mismo mensaje neutro, y el usuario puede reenviar respetando los límites.
- **EC-M1-08:** La contraseña de la eliminación es incorrecta, o la palabra no es exactamente ELIMINAR. No se elimina nada y se explica el motivo.

#### 2.1.5 Criterios de aceptación
```gherkin
Escenario: Registro con correo ya existente no revela la cuenta
  Dado que existe una cuenta con "ana@mail.com"
  Cuando un visitante se registra con "ANA@mail.com "
  Entonces ve "Si el correo es válido, te enviamos un enlace"
  Y el dueño de la cuenta recibe un aviso de intento de registro
  Y no se crea una segunda cuenta

Escenario: Usuario sin confirmar no accede
  Dado un usuario registrado sin confirmar su correo
  Cuando inicia sesión con datos correctos
  Entonces ve "Revisa tu correo" con la opción de reenviar
  Y no ve ningún dato financiero

Escenario: Espera progresiva tras intentos fallidos
  Dado que hubo 5 intentos fallidos seguidos para "ana@mail.com"
  Cuando se intenta de nuevo antes de 1 minuto
  Entonces el intento se rechaza mostrando el tiempo restante
  Y la dueña recibe un correo de aviso

Escenario: Recuperar la contraseña cierra las demás sesiones
  Dado que Ana tiene sesión en su celular y en su computadora
  Cuando recupera su contraseña desde la computadora
  Entonces la sesión del celular queda revocada
  Y la computadora queda con la sesión iniciada

Escenario: Eliminar la cuenta
  Dado que Ana está en "Eliminar cuenta"
  Cuando ingresa su contraseña correcta y escribe "ELIMINAR"
  Entonces todos sus datos se borran
  Y todas sus sesiones se cierran
  Y recibe un correo de confirmación
```

---

### 2.2 M2 — Navegación y estructura (V1.0)

#### 2.2.1 Flujos de usuario
**Celular (menos de 1024 px de ancho)**
1. La barra inferior muestra cinco pestañas: Inicio · Movimientos · **Registrar** (centro) · Cuentas · Más.
2. Registrar es una pestaña como cualquier otra.
3. "Más" abre una pantalla completa con tres secciones:
   - PLANIFICAR: Presupuestos, Metas de ahorro, Deudas y préstamos, Recurrentes;
   - ORGANIZAR: Categorías, Tipo de cambio (con la tasa en uso);
   - CUENTA: Perfil, Ajustes, Cerrar sesión.

**Escritorio (1024 px o más)**
1. Una barra lateral muestra todos los módulos y no existe "Más".
2. El orden es: Inicio, Movimientos, Registrar, Cuentas, y luego las secciones PLANIFICAR, ORGANIZAR y CUENTA.
3. La barra lateral se puede contraer a solo íconos. Con el puntero encima o con el foco del teclado se ve el nombre.

**Cabecera (todos los tamaños)**
- El título de la pantalla.
- Una ficha con el dólar en uso (por ejemplo "$ 10,25"), que lleva al panel de Tipo de cambio.
- Desde la V1.1, la campana con el número de avisos sin leer.

#### 2.2.2 Ciclo de vida y estados

| Estado de la app | Qué ve el usuario | Sale cuando |
|---|---|---|
| Normal | La app completa | — |
| Sin conexión | Una pantalla de bloqueo "Sin conexión" tapa la app. Lo escrito en Registrar se conserva debajo | Vuelve la conexión: el bloqueo desaparece solo y los datos se actualizan |
| Sesión vencida | "Tu sesión venció, vuelve a entrar" con el inicio de sesión | Inicia sesión: vuelve a la misma pantalla con su borrador |

#### 2.2.3 Requerimientos funcionales
- **RF-M2-01:** Por debajo de 1024 px, el sistema DEBE usar la barra inferior de 5 pestañas con Registrar en el centro. Desde 1024 px, la barra lateral con todos los módulos.
- **RF-M2-02:** "Más" DEBE existir solo en el formato de barra inferior.
- **RF-M2-03:** El sistema DEBE mostrar únicamente los módulos de las entregas liberadas.
- **RF-M2-04:** Cada pestaña DEBE recordar su estado (mes, filtros, posición, detalle abierto) al cambiar de pestaña.
- **RF-M2-05:** Tocar la pestaña activa DEBE llevar al inicio de esa pestaña.
- **RF-M2-06:** El botón Atrás del navegador o del celular DEBE funcionar en todas las pantallas.
- **RF-M2-07:** Sin conexión, el sistema DEBE bloquear la app con una pantalla de aviso y liberarla sola al reconectar, actualizando los datos.
- **RF-M2-08:** Con la sesión vencida, el sistema DEBE pedir que el usuario inicie sesión y, tras hacerlo, volver a la misma pantalla con los borradores intactos.
- **RF-M2-09:** El estado contraído de la barra lateral DEBE guardarse en la cuenta del usuario (M9).

#### 2.2.4 Casos borde y excepciones
- **EC-M2-01:** Otra persona inicia sesión tras el vencimiento de la sesión en el mismo dispositivo. El borrador del usuario anterior se descarta.
- **EC-M2-02:** La conexión se pierde a mitad de un guardado. Aparece el bloqueo. Al reconectar, el usuario ve si el movimiento se guardó o no, y nunca se guarda dos veces (RN-10).
- **EC-M2-03:** El ancho de la pantalla cambia al girar la tablet. La navegación cambia de formato sin perder el estado.

#### 2.2.5 Criterios de aceptación
```gherkin
Escenario: Registrar en el centro de la barra en el celular
  Dado un usuario en un celular de 360 px de ancho
  Cuando abre la app
  Entonces ve la barra inferior "Inicio · Movimientos · Registrar · Cuentas · Más"
  Y Registrar ocupa la posición central

Escenario: Sin "Más" en escritorio
  Dado un usuario en una pantalla de 1280 px
  Cuando abre la app
  Entonces ve la barra lateral con todos los módulos
  Y no existe la opción "Más"

Escenario: Bloqueo sin conexión conserva el borrador
  Dado que el usuario escribió "35" en Registrar
  Cuando pierde la conexión
  Entonces una pantalla de bloqueo tapa la app
  Y al volver la conexión encuentra "35" en Registrar
```

---

### 2.3 M3 — Monedas y tipo de cambio (V1.0)

#### 2.3.1 Flujos de usuario
**Elegir la referencia del dólar**
1. En el panel de Tipo de cambio (o en Ajustes), el usuario elige la referencia: paralelo (compra, venta o mediana), oficial (compra, venta o promedio) o valor manual.
2. Al guardar, los saldos y totales actuales se recalculan. Los movimientos registrados no cambian.

**Cargar un valor manual**
1. El usuario escribe un valor (por ejemplo, 10,10 Bs por dólar) y lo activa.
2. Ese valor tiene prioridad sobre cualquier referencia automática hasta que el usuario lo desactive.
3. Mientras está activo, se ve un aviso fijo: "Usando tu valor manual (10,10 Bs) desde hace N días".

**Agregar una moneda**
1. El usuario agrega una moneda con su código de 3 letras, su símbolo y su valor en bolivianos (por ejemplo, 1 EUR = 11,20 Bs).
2. Esa tasa es siempre manual y el usuario la actualiza cuando quiera.

**Cambiar la moneda base**
1. El usuario elige cualquier moneda activa como base.
2. Los totales y la historia se reexpresan con las tasas guardadas en cada movimiento, nunca con las de hoy.

**Consultar el panel**
1. El usuario abre Tipo de cambio desde la cabecera o el menú.
2. Ve:
   - la tasa actual de cada referencia y cuál está en uso;
   - la brecha entre el paralelo y el oficial, en % y en Bs;
   - "actualizado hace X" con su fuente (paralelo.bo, BCB);
   - un gráfico de evolución con un punto por día, en rangos de 7 días, 30 días, 90 días y 1 año.

#### 2.3.2 Ciclo de vida y estados

**Moneda activa**

| Desde | Hacia | Condición |
|---|---|---|
| — | Activa | BOB y USD lo están siempre. Las demás, al agregarlas con su tasa manual |
| Activa | Inactiva | Solo monedas agregadas, que no sean la base y que no tengan cuentas activas. Su historia se conserva |
| Inactiva | Activa | Reactivación con una tasa manual vigente |

- Prohibido: desactivar BOB o USD, desactivar la moneda base, o desactivar una moneda con cuentas activas.

**Valor manual del dólar:** Inactivo ↔ Activo. Solo cambia por acción del usuario. Nunca vence solo.

#### 2.3.3 Requerimientos funcionales
- **RF-M3-01:** BOB y USD DEBEN estar siempre activas. Toda moneda usa 2 decimales.
- **RF-M3-02:** El código de una moneda DEBE tener 3 letras y ser único para el usuario. Las monedas agregadas DEBEN tener una tasa manual en bolivianos.
- **RF-M3-03:** La referencia por defecto DEBE ser la mediana del paralelo. El valor manual activo tiene prioridad sobre cualquier referencia.
- **RF-M3-04:** El sistema DEBE actualizar las tasas automáticas:
  - al abrir la app, si el valor guardado tiene más de 1 minuto;
  - el paralelo, cada hora en segundo plano;
  - el oficial, una vez al día en segundo plano.
- **RF-M3-05:** El sistema DEBE mostrar junto a toda tasa "actualizado hace X" y su fuente. NO muestra avisos de desactualización.
- **RF-M3-06:** Un gasto o ingreso en una moneda distinta de la base DEBE guardar la tasa de la referencia elegida vigente al cierre del día del movimiento. Si ese día había un valor manual activo, guarda ese valor. Si no hay registro de ese día, guarda la tasa actual.
- **RF-M3-07:** En una transferencia entre monedas distintas, el sistema DEBE precargar el campo "Tipo de cambio usado" con el paralelo según la dirección: venta si el usuario compra dólares, compra si los vende.
- **RF-M3-08:** En esa transferencia, el sistema DEBE calcular el monto que llega a partir del monto que sale y la tasa. Si el usuario edita el monto que llega, la tasa se recalcula.
- **RF-M3-09:** La tasa declarada en una transferencia DEBE ser la tasa histórica de ese movimiento.
- **RF-M3-10:** Al editar un movimiento, la tasa guardada DEBE conservarse salvo que cambie la fecha. En ese caso, toma la tasa de la nueva fecha (RF-M3-06). En una transferencia, la tasa declarada solo cambia si el usuario la edita.
- **RF-M3-11:** Cambiar la referencia o la moneda base DEBE recalcular los saldos y totales actuales sin modificar los movimientos registrados.
- **RF-M3-12:** La brecha DEBE calcularse como (paralelo en uso − oficial equivalente) ÷ oficial, en % y en Bs.

#### 2.3.4 Casos borde y excepciones
- **EC-M3-01:** La fuente no responde. Se usa el último valor guardado y la app sigue funcionando.
- **EC-M3-02:** La fuente no responde y no hay ningún valor guardado (usuario nuevo).
  - Los movimientos en bolivianos se registran sin restricción.
  - Al guardar un movimiento en otra moneda, se pregunta "No pudimos obtener el dólar. ¿A cuánto lo tomamos?". El valor ingresado queda como tasa de ese movimiento y como valor manual activo.
  - Mientras no exista ninguna tasa, no se muestran equivalentes en la otra moneda.
- **EC-M3-03:** Se registra un movimiento con fecha de un día sin registro de tasas (anterior al primer dato). Se usa la tasa actual.
- **EC-M3-04:** La fuente devuelve un valor inválido (cero, negativo o vacío). Se descarta y se conserva el último valor válido.
- **EC-M3-05:** El usuario intenta desactivar una moneda con cuentas activas. Se rechaza y se indican las cuentas que la usan.

#### 2.3.5 Criterios de aceptación
```gherkin
Escenario: La historia no se reescribe al cambiar la base
  Dado un gasto de 10,00 $ registrado el 1/10 con el dólar a 10,00 Bs
  Y la moneda base es BOB
  Cuando el dólar sube a 11,00 Bs y el usuario cambia la base a USD y luego vuelve a BOB
  Entonces ese gasto sigue valiendo 100,00 Bs en la historia

Escenario: Tasa precargada según la dirección
  Dado que el paralelo está en compra 10,10 y venta 10,30
  Cuando el usuario transfiere 1 000,00 Bs de una cuenta en Bs a una en $
  Entonces el campo "Tipo de cambio usado" muestra 10,30
  Y el monto que llega es 97,09 $

Escenario: Valor manual con prioridad
  Dado que el usuario activó un valor manual de 10,00 Bs
  Cuando el paralelo cambia a 10,40 Bs
  Entonces los totales siguen convirtiéndose con 10,00 Bs
  Y se ve "Usando tu valor manual (10,00 Bs) desde hace N días"

Escenario: Sin ninguna tasa disponible
  Dado un usuario nuevo y la fuente del dólar no responde
  Cuando guarda un gasto en su cuenta en dólares
  Entonces la app le pide "¿A cuánto lo tomamos?"
  Y el valor que ingresa queda como tasa del gasto y como valor manual activo
```

---

### 2.4 M4 — Cuentas (V1.0)

#### 2.4.1 Flujos de usuario
**Crear una cuenta**
1. El usuario elige el tipo: efectivo, banco, billetera digital, tarjeta de crédito, ahorro u otro.
2. Ingresa el nombre, la moneda, el saldo inicial y su fecha (hoy por defecto), el color y el ícono.
3. En una tarjeta, puede agregar el día de corte, el día de pago y el límite de crédito. El saldo inicial se ingresa como "deuda actual".

**Ajustar el saldo**
1. Desde el detalle de la cuenta, el usuario toca "Ajustar saldo" y escribe su saldo real.
2. El sistema crea un movimiento de tipo Ajuste por la diferencia, con una nota opcional.

**Pagar la tarjeta:** el usuario registra una transferencia desde el banco hacia la tarjeta.

**Archivar o restaurar**
1. El usuario archiva una cuenta. Si su saldo no es cero, el sistema pide confirmación y sugiere transferir el saldo antes.
2. Desde la lista de archivadas, la restaura.

**Consultar**
- La lista muestra el total neto y su desglose, con las cuentas agrupadas por tipo en el orden del usuario.
- El detalle muestra:
  - el saldo y su equivalente en la otra moneda;
  - un gráfico del saldo día a día;
  - los movimientos agrupados por día, con filtro de fechas;
  - en una tarjeta, además, el límite y el disponible;
  - en una cuenta con apartados, el saldo apartado y el saldo libre.

#### 2.4.2 Ciclo de vida y estados

| Desde | Hacia | Condición |
|---|---|---|
| — | Activa | Creación |
| Activa | Archivada | Confirmación (con aviso si el saldo no es cero). Prohibido si tiene apartados de metas o está dedicada a una meta |
| Archivada | Activa | Restauración. Si su nombre ya está en uso entre las activas, se pide renombrarla |
| Activa | Eliminada | Solo si no tiene ningún movimiento |

- Prohibido: eliminar una cuenta con movimientos, y archivar una cuenta con apartados o dedicada.

#### 2.4.3 Requerimientos funcionales
- **RF-M4-01:** El nombre DEBE tener de 1 a 40 caracteres y ser único entre las cuentas activas, sin distinguir mayúsculas.
- **RF-M4-02:** El saldo inicial DEBE cumplir según el tipo:
  - efectivo y billetera, mayor o igual a 0;
  - tarjeta, se ingresa como deuda (positiva) y se registra como saldo negativo;
  - banco, ahorro y otro, cualquier valor.

  Por defecto es 0.
- **RF-M4-03:** El saldo DEBE calcularse según RN-01. Un movimiento con fecha anterior a la del saldo inicial se permite, aparece en la historia con el aviso "anterior al saldo inicial" y no altera el saldo.
- **RF-M4-04:** En efectivo y billetera, el sistema DEBE rechazar toda acción que deje el saldo actual en negativo, y explicar cuál sería el saldo resultante. Incluye gastos, transferencias salientes, ediciones, eliminaciones de ingresos, deshacer y ajustes. Los saldos de días pasados no se validan.
- **RF-M4-05:** Un ajuste NO cuenta como ingreso ni como gasto. Se puede editar y eliminar.
- **RF-M4-06:** La moneda de una cuenta solo DEBE poder cambiarse si no tiene movimientos.
- **RF-M4-07:** El saldo inicial y su fecha DEBEN poder corregirse, con recálculo del saldo. El nombre, el tipo, el color y el ícono se editan siempre, respetando RF-M4-02.
- **RF-M4-08:** En una tarjeta:
  - el saldo DEBE mostrarse como "Debes X" o "A favor X";
  - con límite, se muestra el disponible (límite − deuda), y al superarlo aparece un aviso sin bloquear;
  - el día de corte y el día de pago son opcionales y generan avisos (M15).
- **RF-M4-09:** Una cuenta archivada NO DEBE aparecer en los selectores ni sumar en los totales, y DEBE conservar su historia.
- **RF-M4-10:** El total neto DEBE ser la suma de las cuentas activas (la deuda de tarjetas resta), en moneda base y su equivalente en la otra moneda, con la referencia vigente. El desglose incluye:
  - Disponible (efectivo, banco, billetera, otro);
  - Ahorro;
  - Deuda en tarjetas;
  - Apartado para metas (V1.1), que no altera el total.
- **RF-M4-11:** Las cuentas DEBEN poder reordenarse. La lista agrupa por tipo y respeta ese orden.
- **RF-M4-12:** Si se archiva la cuenta por defecto o la última usada en Registrar, Registrar DEBE pasar a otra cuenta activa.

#### 2.4.4 Casos borde y excepciones
- **EC-M4-01:** Se elimina un ingreso del efectivo y el saldo quedaría en −50. Se rechaza: "El efectivo quedaría en −50,00 Bs".
- **EC-M4-02:** Se corrige el saldo inicial del efectivo y el saldo actual quedaría negativo. Se rechaza con la misma explicación.
- **EC-M4-03:** Un recurrente automático dejaría el efectivo en negativo. No se registra y pasa a pendiente (M14).
- **EC-M4-04:** Se restaura una cuenta cuyo nombre está en uso. Se pide un nombre nuevo antes de restaurarla.
- **EC-M4-05:** La única cuenta activa se archiva. Registrar y el Inicio invitan a crear una cuenta.
- **EC-M4-06:** Un banco queda con saldo negativo. Se permite (sobregiro).

#### 2.4.5 Criterios de aceptación
```gherkin
Escenario: Movimiento anterior al saldo inicial no altera el saldo
  Dado una cuenta Efectivo creada el 10/10 con saldo inicial 500,00 Bs
  Cuando el usuario registra un gasto de 50,00 Bs con fecha 5/10
  Entonces el saldo sigue siendo 500,00 Bs
  Y el gasto aparece en la historia con el aviso "anterior al saldo inicial"

Escenario: Bloqueo de negativo en efectivo
  Dado una cuenta Efectivo con saldo 30,00 Bs
  Cuando el usuario intenta registrar un gasto de 35,00 Bs
  Entonces el gasto no se guarda
  Y ve "El efectivo quedaría en −5,00 Bs"

Escenario: Ajuste de saldo
  Dado una cuenta Banco con saldo 1 200,00 Bs
  Cuando el usuario indica que su saldo real es 1 250,00 Bs
  Entonces se crea un Ajuste de +50,00 Bs
  Y los ingresos del mes no cambian

Escenario: Pago de tarjeta no es gasto
  Dado una tarjeta con deuda de 1 000,00 Bs
  Cuando el usuario transfiere 1 000,00 Bs del Banco a la tarjeta
  Entonces la tarjeta muestra "Debes 0,00 Bs"
  Y los gastos del mes no cambian
```

---

### 2.5 M5 — Categorías (V1.0)

#### 2.5.1 Flujos de usuario
**Categorías precargadas**
- GASTOS:
  - Comida (Supermercado, Restaurantes)
  - Transporte (Micro/Trufi, Taxi/Apps, Combustible)
  - Vivienda (Alquiler, Anticrético)
  - Servicios (Luz, Agua, Gas, Internet, Celular, Comisiones bancarias)
  - Salud, Educación, Ocio, Ropa, Cuidado personal, Regalos, Mascotas, Otros gastos
- INGRESOS: Sueldo, Negocio/Ventas, Mesada, Trabajos independientes, Regalos recibidos, Otros ingresos.
- DEL SISTEMA: "Deudas y préstamos", en gasto y en ingreso, con la subcategoría "Intereses".

**Gestionar**
- El usuario crea, renombra, reordena (arrastrando), cambia el ícono y el color, archiva y restaura categorías de gasto o de ingreso.
- Puede agregar subcategorías (un nivel), mover una subcategoría a otro padre del mismo tipo o convertirla en principal.

**Fusionar**
1. El usuario elige "Fusionar A en B" (mismo tipo).
2. La app muestra cuántos movimientos se moverán y lo que pasará con los presupuestos.
3. Tras la confirmación, todo pasa de A a B y A queda eliminada.

#### 2.5.2 Ciclo de vida y estados

| Desde | Hacia | Condición |
|---|---|---|
| — | Activa | Creación o precarga |
| Activa | Archivada | Si es padre, sus subcategorías se archivan también, con una confirmación que las lista |
| Archivada | Activa | Restauración. Si es padre, el usuario elige qué subcategorías vuelven |
| Activa | Eliminada | Solo sin movimientos, o como origen de una fusión |

- Prohibido: eliminar una categoría con movimientos; cambiar su tipo; convertir en subcategoría una categoría que tiene subcategorías; renombrar, archivar, eliminar o fusionar la categoría del sistema.

#### 2.5.3 Requerimientos funcionales
- **RF-M5-01:** Gastos e ingresos DEBEN tener categorías separadas. El tipo de una categoría nunca cambia.
- **RF-M5-02:** El nombre DEBE tener de 1 a 30 caracteres y ser único dentro del mismo tipo y el mismo padre, sin distinguir mayúsculas.
- **RF-M5-03:** Un movimiento PUEDE asignarse a una categoría padre o a una subcategoría. El total de un padre incluye el de sus subcategorías.
- **RF-M5-04:** El ícono DEBE elegirse de una galería fija (unos 60) y el color de una paleta de 12 colores con contraste AA en tema claro y oscuro. Las subcategorías heredan el color del padre por defecto.
- **RF-M5-05:** La categoría del sistema "Deudas y préstamos" (gasto e ingreso) y su subcategoría "Intereses" DEBEN estar protegidas. Solo cambian su color y su ícono. Se pueden usar a mano y llevan el distintivo "del sistema".
- **RF-M5-06:** Una categoría archivada NO DEBE ofrecerse al registrar y DEBE conservar su historia.
- **RF-M5-07:** Antes de archivar una categoría en uso, el sistema DEBE listar lo afectado y aplicar:
  - el presupuesto sigue vigente hasta el fin del período actual y pasa a Finalizado;
  - los recurrentes se pausan, con un aviso para elegir otra categoría;
  - los atajos se ocultan y reaparecen si la categoría se restaura.
- **RF-M5-08:** La fusión de A en B DEBE cumplir:
  - solo entre categorías del mismo tipo, y A sin subcategorías;
  - mueve a B los movimientos, recurrentes y atajos de A;
  - el presupuesto de A pasa a B si B no tenía; si ambas tenían, se conserva el de B y se elimina el de A, con aviso;
  - A queda eliminada y la fusión no se puede deshacer.

#### 2.5.4 Casos borde y excepciones
- **EC-M5-01:** Se crea "comida" existiendo "Comida" en gastos. Se rechaza por duplicado.
- **EC-M5-02:** Se intenta fusionar una categoría con subcategorías. Se pide fusionar o mover primero las subcategorías.
- **EC-M5-03:** Se mueve una subcategoría con presupuesto a otro padre. El gasto del presupuesto del padre anterior deja de incluirla desde ese momento, y la historia de sus períodos cerrados no cambia.
- **EC-M5-04:** Al restaurar una categoría, su nombre ya está en uso en el mismo nivel. Se pide renombrarla.

#### 2.5.5 Criterios de aceptación
```gherkin
Escenario: Archivar una categoría con presupuesto y recurrente
  Dado "Ocio" con un presupuesto activo y un recurrente "Netflix"
  Cuando el usuario archiva "Ocio" y confirma
  Entonces el presupuesto sigue hasta el fin del período y pasa a Finalizado
  Y el recurrente "Netflix" queda pausado con un aviso para elegir otra categoría

Escenario: Fusionar duplicados
  Dado "Taxis" con 12 movimientos y "Taxi/Apps" con 40
  Cuando el usuario fusiona "Taxis" en "Taxi/Apps"
  Entonces "Taxi/Apps" tiene 52 movimientos
  Y "Taxis" deja de existir

Escenario: Categoría del sistema protegida
  Cuando el usuario intenta archivar "Deudas y préstamos"
  Entonces la acción no está disponible
```

---

### 2.6 M6 — Transacciones (V1.0)

#### 2.6.1 Flujos de usuario
**Registrar** (el flujo rápido está en M7)
- Gasto o ingreso: monto, cuenta, categoría, fecha y nota opcional.
- Transferencia: cuenta de origen, cuenta de destino, monto, fecha, nota y comisión opcional.
  - Si las monedas difieren: monto que sale, tipo de cambio usado y monto que llega (M3).
  - La comisión crea un gasto vinculado en la cuenta de origen, con la categoría "Servicios › Comisiones bancarias".

**Revisar**
1. La lista abre en el mes actual, con selector de mes. Agrupa por día con el neto de cada día y muestra arriba los totales del filtro activo.
2. Filtros: fecha o rango, cuenta, categoría (incluye sus subcategorías) y tipo.
3. Búsqueda por nota o monto, sin distinguir mayúsculas ni tildes.
4. Al bajar se cargan más movimientos.

**Editar:** desde el detalle, el usuario cambia el monto, la cuenta, la categoría, la fecha o la nota, según las reglas de abajo.

**Eliminar:** el movimiento deja de contar al instante y aparece "Deshacer" durante 10 segundos.

**Acciones en lote**
1. Con una pulsación larga (o casillas en escritorio), el usuario selecciona varios movimientos.
2. Puede recategorizarlos o eliminarlos con un solo "Deshacer".

#### 2.6.2 Ciclo de vida y estados

| Desde | Hacia | Disparador |
|---|---|---|
| — | Registrado | Guardado manual, o recurrente automático (M14) |
| — | Pendiente | Recurrente en modo confirmación, o automático bloqueado (M14) |
| Pendiente | Registrado | El usuario confirma (puede ajustar el monto, la fecha y la tasa) |
| Pendiente | Omitido | El usuario omite, o pasan 30 días sin decisión |
| Registrado | Eliminado (deshacible) | Eliminación |
| Eliminado (deshacible) | Registrado | "Deshacer" dentro de los 10 segundos |
| Eliminado (deshacible) | Eliminado definitivo | Pasan 10 segundos o el usuario cambia de pantalla |

- Estados finales: Omitido y Eliminado definitivo.
- Prohibido: cambiar el tipo de un movimiento, y deshacer después de los 10 segundos.

#### 2.6.3 Requerimientos funcionales
- **RF-M6-01:** El monto DEBE estar entre 0,01 y 999.999.999,99, con 2 decimales como máximo.
- **RF-M6-02:** La fecha DEBE ser hoy o anterior (RN-07), sin hora. Dentro de un día, la lista ordena por momento de registro, del más reciente al más antiguo.
- **RF-M6-03:** La nota DEBE ser opcional y de hasta 140 caracteres.
- **RF-M6-04:** El origen y el destino de una transferencia DEBEN ser cuentas activas y distintas.
- **RF-M6-05:** La comisión de una transferencia DEBE crear un gasto vinculado en la cuenta de origen. Se edita desde la transferencia y se elimina con ella. Si su categoría está archivada, se pide elegir otra.
- **RF-M6-06:** El tipo de un movimiento NO DEBE cambiar.
- **RF-M6-07:** La cuenta PUEDE cambiarse:
  - a otra de la misma moneda, libremente;
  - a otra de distinta moneda, confirmando el monto en la nueva moneda y tomando la tasa de esa fecha.
- **RF-M6-08:** Toda edición, eliminación o deshacer DEBE respetar el bloqueo de negativos (M4), la protección de apartados (M12) y las reglas de tasa (M3).
- **RF-M6-09:** En los movimientos vinculados (pagos de deuda, movimientos de metas, comisiones), el monto, la cuenta y la fecha DEBEN editarse solo desde su origen, y el detalle ofrece "Ir a…". La nota y la categoría se editan desde la lista, salvo la categoría del sistema.
- **RF-M6-10:** Los movimientos creados por un recurrente DEBEN ser movimientos normales, editables y eliminables, con el distintivo "De recurrente: X".
- **RF-M6-11:** Los pendientes NO DEBEN aparecer en la lista de movimientos ni contar en saldos o totales.
- **RF-M6-12:** El neto diario y los totales de la lista DEBEN excluir los movimientos que indica RN-02.
- **RF-M6-13:** Las acciones en lote DEBEN omitir los vinculados y los que violarían el bloqueo de negativos o de apartados, y avisar cuántos quedaron fuera.
- **RF-M6-14:** Un doble toque o un reintento NUNCA DEBE crear dos movimientos (RN-10). No existe aviso de posible duplicado.

#### 2.6.4 Casos borde y excepciones
- **EC-M6-01:** El mismo movimiento se edita en dos dispositivos. Gana la última edición guardada.
- **EC-M6-02:** Se guarda la edición de un movimiento eliminado en otro dispositivo. Se informa "Este movimiento ya no existe" y no se guarda nada.
- **EC-M6-03:** Se intenta deshacer una eliminación cuyo resultado violaría el bloqueo de negativos. Se rechaza con la explicación.
- **EC-M6-04:** Se cambia la fecha de un gasto en dólares. Toma la tasa de la nueva fecha (RF-M3-10).
- **EC-M6-05:** Se elimina una transferencia con comisión. Se eliminan ambas, con un único "Deshacer".
- **EC-M6-06:** El usuario cambia de pantalla durante los 10 segundos de "Deshacer". La eliminación queda definitiva.

#### 2.6.5 Criterios de aceptación
```gherkin
Escenario: Eliminar y deshacer
  Dado un gasto de 35,00 Bs en Efectivo
  Cuando el usuario lo elimina
  Entonces el saldo de Efectivo sube 35,00 Bs al instante
  Y ve "Movimiento eliminado · Deshacer" durante 10 segundos
  Cuando toca "Deshacer"
  Entonces el gasto vuelve y el saldo se restablece

Escenario: Transferencia con comisión
  Dado que el usuario transfiere 500,00 Bs del Banco a Efectivo con comisión 5,00 Bs
  Entonces el Banco baja 505,00 Bs y el Efectivo sube 500,00 Bs
  Y se crea un gasto de 5,00 Bs en "Comisiones bancarias"
  Y la transferencia no cuenta como ingreso ni como gasto

Escenario: Doble toque no duplica
  Dado que el usuario toca "Guardar" dos veces seguidas
  Entonces se crea un solo movimiento

Escenario: Vinculado solo se edita en su origen
  Dado un pago de deuda a Juan de 200,00 Bs
  Cuando el usuario abre ese movimiento desde la lista
  Entonces el monto, la cuenta y la fecha no son editables
  Y ve la opción "Ir a la deuda"
```

---

### 2.7 M7 — Registrar (pestaña) (V1.0)

#### 2.7.1 Flujos de usuario
**Registrar un gasto (flujo de menos de 10 segundos)**
1. El usuario toca la pestaña Registrar. Viene seleccionado Gasto y el cursor está en el monto, con teclado numérico.
2. Escribe el monto. La cuenta y la fecha ("Hoy") ya están preseleccionadas.
3. Toca una de las 8 categorías de la grilla.
4. Toca "Guardar".
5. Aparece "Gasto de 35,00 Bs guardado · Deshacer" durante 10 segundos. El formulario se limpia, la app se queda en Registrar lista para el siguiente, y debajo se ven los últimos 3 movimientos registrados hoy.

**Usar un atajo**
1. El usuario toca la ficha de un atajo (por ejemplo, "Almuerzo") y el formulario se rellena.
2. Revisa (si el atajo no tiene monto, el cursor queda en el monto) y toca "Guardar".

**Segundo nivel:** desde el mismo formulario, el usuario agrega una nota, elige otra fecha u otra cuenta, agrega una comisión (en transferencias) o toca "Guardar como atajo".

**Transferencia**
1. El usuario cambia el selector a Transferencia y elige el origen y el destino (viene el último par usado).
2. Ingresa el monto. Si las monedas difieren, ajusta el tipo de cambio usado o el monto que llega (M3).

#### 2.7.2 Ciclo de vida y estados

**Formulario**

| Estado | Qué significa |
|---|---|
| Vacío | Recién abierto o limpio |
| Con borrador | Hay datos escritos. Se conservan al cambiar de pestaña, al vencer la sesión o al quedar bloqueado sin conexión |
| Listo | Cumple los requisitos para guardar |
| Guardado | Se limpia y vuelve a Vacío |

- El borrador se descarta con "Limpiar", al cerrar la app o la sesión, o si entra otro usuario.

**Atajo:** Visible ↔ Oculto (su cuenta o categoría está archivada) → Eliminado.

#### 2.7.3 Requerimientos funcionales
- **RF-M7-01:** Registrar DEBE ser una pestaña normal: centro de la barra inferior en celular, entrada de la barra lateral en escritorio.
- **RF-M7-02:** Al entrar, el tipo DEBE ser siempre Gasto y el foco DEBE estar en el monto. El monto acepta solo números, sin operaciones.
- **RF-M7-03:** La cuenta preseleccionada DEBE ser la cuenta por defecto de Ajustes, si existe. Si no, la última usada para ese tipo (gasto o ingreso por separado). En transferencias, el último par origen-destino.
- **RF-M7-04:** La grilla DEBE mostrar 8 categorías del tipo actual:
  - primero, las favoritas fijadas en Ajustes, en su orden;
  - después, las más usadas de los últimos 60 días, mezclando padres y subcategorías;
  - un usuario nuevo ve las primeras precargadas;
  - nunca aparecen categorías archivadas.

  "Ver todas" abre la lista completa con los padres desplegables.
- **RF-M7-05:** La fecha DEBE ofrecer las fichas "Hoy" (marcada), "Ayer" y "Calendario", sin fechas futuras.
- **RF-M7-06:** "Guardar" DEBE habilitarse con monto mayor que 0 y categoría (gasto o ingreso), o con origen y destino distintos (transferencia).
- **RF-M7-07:** Al guardar, el sistema DEBE limpiar el formulario y permanecer en Registrar. Debe mostrar "Deshacer" durante 10 segundos y los últimos 3 movimientos de hoy.
- **RF-M7-08:** El borrador DEBE conservarse al cambiar de pestaña en el mismo dispositivo mientras la app siga abierta, y también tras volver a iniciar sesión el mismo usuario.
- **RF-M7-09:** Los atajos DEBEN guardar nombre, tipo, monto (opcional), cuenta, categoría y nota. Son como máximo 12 y aparecen como fichas del tipo correspondiente. Al tocarlos rellenan el formulario y no guardan directamente.
- **RF-M7-10:** Los atajos se crean con "Guardar como atajo" y se editan, reordenan y eliminan en Ajustes › Registrar.
- **RF-M7-11:** La ficha de cuenta DEBE mostrar el saldo libre de la cuenta.
- **RF-M7-12:** En escritorio, el formulario DEBE poder usarse completo con Tab y Enter. No hay atajos de teclado propios.
- **RF-M7-13:** El ajuste "Mostrar la nota siempre" DEBE poner la nota en el primer nivel.

#### 2.7.4 Casos borde y excepciones
- **EC-M7-01:** No hay cuentas. Registrar muestra "Crea tu primera cuenta" con un formulario mínimo (nombre, tipo, moneda, saldo) en la misma pantalla.
- **EC-M7-02:** El gasto dejaría el efectivo en negativo. Se muestra el error en la pantalla y el formulario no se limpia.
- **EC-M7-03:** El gasto usa dinero apartado para metas. Aparece la confirmación de M12. Si se cancela, el formulario queda intacto.
- **EC-M7-04:** No hay ninguna tasa y la cuenta está en dólares. Se pide el valor en ese momento (EC-M3-02).
- **EC-M7-05:** La cuenta por defecto se archiva. El ajuste se limpia y se usa la última cuenta usada.
- **EC-M7-06:** Ya existen 12 atajos. "Guardar como atajo" informa el límite y ofrece gestionar los atajos.

#### 2.7.5 Criterios de aceptación
```gherkin
Escenario: Registro rápido en menos de 10 segundos
  Dado un usuario con la cuenta Efectivo como última usada
  Cuando toca Registrar, escribe "35", toca "Supermercado" y toca "Guardar"
  Entonces el gasto queda registrado en Efectivo con fecha de hoy
  Y el formulario queda vacío en la pestaña Registrar
  Y el Inicio refleja el gasto

Escenario: Borrador al cambiar de pestaña
  Dado que el usuario escribió "120" en Registrar
  Cuando va a Cuentas y vuelve a Registrar
  Entonces encuentra "120" en el monto

Escenario: Atajo rellena sin guardar
  Dado el atajo "Almuerzo, 35 Bs, Efectivo, Restaurantes"
  Cuando el usuario lo toca
  Entonces el formulario queda completo
  Y el movimiento no se guarda hasta tocar "Guardar"
```

---

### 2.8 M8 — Inicio (dashboard) (V1.0)

#### 2.8.1 Flujos de usuario
**Revisar el mes**
1. El usuario abre la app y ve el mes actual.
2. Cambia de mes con el selector y compara.
3. Toca la tarjeta de Gastos (o una categoría) y llega a Movimientos filtrado por ese tipo (o esa categoría) y ese mes.
4. Edita o elimina un movimiento y el Inicio se recalcula al volver.

**Bloques, en el orden por defecto**
1. Selector de mes (fijo).
2. Cuatro tarjetas: Ingresos, Gastos, Balance y Tasa de ahorro (fijas).
3. Presupuesto del mes (V1.1).
4. Gasto por categoría.
5. Ritmo del gasto.
6. Próximos pagos y deudas (V1.1).
7. Saldos por cuenta.
8. Últimos 5 movimientos.

#### 2.8.2 Ciclo de vida y estados
Cada bloque tiene uno de estos estados:
- **Con datos.**
- **Vacío:** muestra un mensaje y una acción sugerida, por ejemplo "Aún no tienes gastos este mes · Registrar".
- **No disponible:** su entrega no está liberada, así que el bloque no aparece.
- **Oculto:** el usuario lo ocultó en Ajustes.

#### 2.8.3 Requerimientos funcionales
- **RF-M8-01:** El mes DEBE ser el mes calendario. El selector va desde el mes del primer movimiento o del primer saldo inicial hasta el mes actual, sin meses futuros.
- **RF-M8-02:** Los ingresos y gastos DEBEN excluir los movimientos que indica RN-02 y convertirse con la tasa guardada en cada movimiento (RN-05).
- **RF-M8-03:** Balance = ingresos − gastos. Tasa de ahorro = balance ÷ ingresos, en porcentaje entero. La tasa de ahorro DEBE ocultarse si no hay ingresos o si el balance es negativo.
- **RF-M8-04:** Cada tarjeta DEBE mostrar su variación contra el mes anterior:
  - en el mes en curso, contra el mismo tramo de días del mes anterior (o hasta su último día, si es más corto);
  - en un mes cerrado, contra el mes anterior completo;
  - si el valor anterior es 0, se muestra "—".

  Los gastos que suben se marcan en rojo y los ingresos que suben, en verde.
- **RF-M8-05:** "Gasto por categoría" DEBE mostrar barras horizontales con las 5 categorías principales de mayor gasto (subcategorías sumadas), con monto y %, más "Otras".
- **RF-M8-06:** "Ritmo del gasto" DEBE comparar el gasto acumulado día a día del mes elegido (hasta hoy, si es el actual) contra el del mes anterior completo.
- **RF-M8-07:** "Saldos por cuenta" DEBE mostrar el total neto en Bs y en $ y las 5 primeras cuentas según el orden del usuario, con "Ver todas". Siempre son los saldos de hoy, con la leyenda "Saldos al día de hoy".
- **RF-M8-08:** "Presupuesto del mes" (V1.1) DEBE mostrar una barra por presupuesto activo, con su período visible.
- **RF-M8-09:** "Próximos pagos y deudas" (V1.1) DEBE listar los vencimientos de los próximos 7 días: deudas, tarjetas y, desde la V1.2, recurrentes.
- **RF-M8-10:** Cada bloque DEBE llevar a su módulo. Los bloques 3 a 8 se reordenan y ocultan en Ajustes.
- **RF-M8-11:** El Inicio DEBE reflejar todo cambio de datos al volver a él.

#### 2.8.4 Casos borde y excepciones
- **EC-M8-01:** Usuario sin cuentas. El Inicio invita a crear la primera cuenta.
- **EC-M8-02:** Mes sin movimientos. Las tarjetas muestran 0, la tasa de ahorro se oculta y los gráficos muestran su estado vacío.
- **EC-M8-03:** Mes actual el día 31 contra un mes anterior de 30 días. Se compara con el mes anterior completo.
- **EC-M8-04:** No hay ninguna tasa. Los saldos en otra moneda no se convierten y se indica "Sin tipo de cambio".

#### 2.8.5 Criterios de aceptación
```gherkin
Escenario: Préstamos no inflan los ingresos
  Dado que el usuario recibió un préstamo de 5 000,00 Bs registrado en "Deudas y préstamos"
  Cuando mira el Inicio del mes
  Entonces la tarjeta Ingresos no incluye esos 5 000,00 Bs
  Y el saldo de la cuenta sí los incluye

Escenario: Comparación por el mismo tramo
  Dado que hoy es 15 de octubre
  Y del 1 al 15 de septiembre se gastaron 1 000,00 Bs
  Y del 1 al 15 de octubre se gastaron 1 200,00 Bs
  Entonces la tarjeta Gastos muestra "+20 %" en rojo

Escenario: Tasa de ahorro oculta
  Dado un mes con ingresos 3 000,00 Bs y gastos 3 500,00 Bs
  Entonces la tarjeta Tasa de ahorro no se muestra
```

---

### 2.9 M9 — Ajustes y personalización (V1.0)

#### 2.9.1 Flujos de usuario
1. El usuario abre Ajustes y elige una sección:
   - **General:**
     - formato de números: "Bs 1.234,56" (por defecto) o "1,234.56";
     - formato de fecha: DD/MM/AAAA (por defecto), AAAA-MM-DD o "15 oct 2026";
     - primer día de la semana: lunes (por defecto) o domingo;
     - tema: sistema (por defecto), claro u oscuro.
   - **Monedas y tipo de cambio:** monedas activas, moneda base, referencia y valor manual (M3).
   - **Registrar:** cuenta por defecto, categorías favoritas, atajos y "Mostrar la nota siempre" (M7).
   - **Inicio:** orden y visibilidad de los bloques 3 a 8 (M8).
   - **Recordatorios** (V1.2): M15.
2. Cada cambio se guarda al instante, sin botón "Guardar".
3. "Restablecer valores por defecto" (por sección, con confirmación) devuelve los ajustes de esa sección a sus valores iniciales.

#### 2.9.2 Ciclo de vida y estados
Cada ajuste está en su valor por defecto o en un valor personalizado. "Restablecer" lo devuelve al valor por defecto. No hay otros estados.

#### 2.9.3 Requerimientos funcionales
- **RF-M9-01:** TODOS los ajustes, incluidos el tema y la barra lateral contraída, DEBEN guardarse en la cuenta y verse iguales en todos los dispositivos.
- **RF-M9-02:** El símbolo de la moneda DEBE ir antes del monto. Al escribir montos se acepta el separador decimal elegido.
- **RF-M9-03:** Todas las fechas y montos de la app DEBEN respetar los formatos elegidos. Las listas usan expresiones relativas ("Hoy", "Ayer", "Lun 13").
- **RF-M9-04:** El primer día de la semana DEBE aplicarse al calendario y a los recurrentes semanales.
- **RF-M9-05:** "Restablecer" NO DEBE tocar datos: cuentas, movimientos, categorías ni atajos.
- **RF-M9-06:** NO existen valores globales de presupuestos. Cada presupuesto se configura por separado (M11).

#### 2.9.4 Casos borde y excepciones
- **EC-M9-01:** Se cambia un ajuste en dos dispositivos a la vez. Gana el último guardado, y el otro dispositivo lo refleja al actualizar.
- **EC-M9-02:** Se elige como cuenta por defecto una cuenta que luego se archiva. Se aplica EC-M7-05.

#### 2.9.5 Criterios de aceptación
```gherkin
Escenario: Ajustes sincronizados
  Dado que el usuario cambia el tema a oscuro en su celular
  Cuando abre la app en su computadora
  Entonces la ve en tema oscuro

Escenario: Formato de números
  Dado el formato "1,234.56"
  Cuando el usuario escribe "35.50" en Registrar
  Entonces el monto registrado es treinta y cinco con cincuenta
```

---

### 2.10 M10 — Onboarding (V1.0)

#### 2.10.1 Flujos de usuario
1. Tras confirmar su correo, el usuario entra al Onboarding: 3 pasos con el indicador "Paso N de 3", "Saltar paso" y "Saltar todo".
2. **Paso 1, moneda base:**
   - elige su moneda base (BOB por defecto) y confirma que trabajará con BOB y USD;
   - la app informa "Usaremos el dólar paralelo: 10,25 Bs (puedes cambiarlo en Ajustes)".
3. **Paso 2, cuentas:**
   - fichas marcables: "Efectivo (Bs)" ✓, "Banco (Bs)" ✓ y "Dólares en efectivo ($)" sin marcar;
   - cada una tiene un nombre editable y el campo "saldo de hoy" (0 por defecto);
   - "+ Otra cuenta" abre un formulario corto.
4. **Paso 3, categorías:**
   - la lista precargada con casillas, todas marcadas;
   - desmarcar una categoría la quita, y desmarcar un padre quita sus subcategorías;
   - "+ Agregar" crea una categoría nueva.
5. Al terminar, el usuario llega al Inicio del mes actual.

#### 2.10.2 Ciclo de vida y estados

| Desde | Hacia | Disparador |
|---|---|---|
| — | En paso 1 | Primer acceso tras la confirmación |
| En paso N | En paso N+1 | Continuar o saltar el paso |
| En paso N | Terminado | Completar el paso 3 o "Saltar todo" |

- Prohibido: volver a mostrar el Onboarding una vez Terminado.

#### 2.10.3 Requerimientos funcionales
- **RF-M10-01:** El progreso DEBE guardarse en la cuenta en cada paso. Si se interrumpe, retoma en el paso pendiente, en cualquier dispositivo, sin repreguntar lo ya confirmado.
- **RF-M10-02:** Saltar el paso 1 DEBE dejar BOB como moneda base.
- **RF-M10-03:** Saltar el paso 2 NO DEBE crear ninguna cuenta.
- **RF-M10-04:** Los saldos del paso 2 DEBEN cumplir las reglas de saldo inicial (RF-M4-02), con fecha de hoy.
- **RF-M10-05:** En el paso 3, la categoría del sistema "Deudas y préstamos" NO DEBE poder desmarcarse.
- **RF-M10-06:** Saltar el paso 3 DEBE conservar todas las categorías precargadas.

#### 2.10.4 Casos borde y excepciones
- **EC-M10-01:** Se ingresa un saldo negativo para el efectivo. Se rechaza con la explicación.
- **EC-M10-02:** Se renombran dos cuentas con el mismo nombre. Se rechaza por duplicado (RF-M4-01).
- **EC-M10-03:** Se desmarcan todas las categorías de gasto. Se permite. Registrar mostrará "Ver todas" vacío con la acción "Crear categoría".

#### 2.10.5 Criterios de aceptación
```gherkin
Escenario: Saltar todo
  Dado un usuario recién confirmado
  Cuando toca "Saltar todo"
  Entonces su moneda base es BOB
  Y no tiene cuentas
  Y conserva todas las categorías precargadas
  Y el Inicio lo invita a crear su primera cuenta

Escenario: Retomar en otro dispositivo
  Dado que el usuario completó el paso 1 en su celular y cerró la app
  Cuando inicia sesión en su computadora
  Entonces el Onboarding continúa en el paso 2
```

---

### 2.11 M11 — Presupuestos (V1.1)

#### 2.11.1 Flujos de usuario
**Crear un presupuesto**
1. En Presupuestos, el usuario toca "Nuevo presupuesto".
2. Elige el alcance: una categoría, una subcategoría de gasto o "General" (todos los gastos).
3. Define:
   - el monto mensual y la moneda;
   - el día de inicio del período (1 por defecto);
   - la acción por defecto al cierre: descartar (por defecto) o arrastrar;
   - hasta 3 umbrales de alerta (80 % y 100 % por defecto).
4. Guarda. Ve la barra con el gasto que ya existe en el período actual.

**Seguir el período:** el detalle muestra:
- la barra (gastado / disponible) con la marca "hoy deberías llevar X";
- lo gastado y lo que queda;
- "Puedes gastar X/día durante N días", "Vas X por encima del ritmo" o "Superado por X";
- el desglose "Monto ± arrastre = disponible";
- el historial de los últimos 12 períodos.

**Decidir el cierre de un período**
1. Al cerrar un período llega un aviso a la bandeja y aparece una tarjeta en el presupuesto: "Comida cerró octubre: sobraron 150,00 Bs" (o "te pasaste por 100,00 Bs").
2. Si sobró, el usuario reparte el sobrante entre:
   - "Arrastrar al período siguiente";
   - "Enviar a meta", eligiendo la meta y la cuenta de la que se aparta;
   - "Descartar".

   La suma debe dar exactamente el sobrante.
3. Si se pasó, elige entre "Arrastrar" (resta del período siguiente) y "Absorber" (se perdona).
4. Aplica. Si no decide en 7 días, se aplica la acción por defecto del presupuesto.

#### 2.11.2 Ciclo de vida y estados

**Presupuesto**

| Desde | Hacia | Condición |
|---|---|---|
| — | Activo | Creación |
| Activo | Pausado | Acción del usuario. No se renueva, no alerta y el arrastre queda congelado |
| Pausado | Activo | Reanudar, desde el período actual |
| Activo o Pausado | Finalizado | Su categoría se archivó. Termina al cierre del período actual |
| Cualquiera (salvo Eliminado) | Eliminado | Acción del usuario con confirmación. Desaparece con su historia |

- Estados finales: Finalizado y Eliminado.

**Cierre de período:** Pendiente de decisión → Decidido (por el usuario) | Decidido por defecto (a los 7 días).

#### 2.11.3 Requerimientos funcionales
- **RF-M11-01:** DEBE existir como máximo un presupuesto activo o pausado por categoría o subcategoría de gasto, más uno general opcional.
- **RF-M11-02:** Los presupuestos se anidan. Un gasto cuenta en el presupuesto de su subcategoría, en el de su padre y en el general. Si los hijos suman más que el padre, se avisa sin bloquear.
- **RF-M11-03:** El gasto de un presupuesto DEBE sumar los gastos de su alcance dentro del período, excluyendo lo que indica RN-02, convertidos a la moneda del presupuesto con la tasa guardada de cada movimiento.
- **RF-M11-04:** El período DEBE empezar el día elegido. Si un mes no tiene ese día, empieza el último día del mes.
- **RF-M11-05:** Disponible = monto del período + arrastre acumulado (positivo o negativo). Un período puede empezar ya superado.
- **RF-M11-06:** El monto, la acción por defecto y los umbrales DEBEN aplicarse al período actual al editarlos. Los períodos pasados conservan su monto.
- **RF-M11-07:** El día de inicio DEBE aplicarse desde el próximo período, avisando la fecha. La moneda NO DEBE cambiar.
- **RF-M11-08:** En el cierre, el sobrante DEBE repartirse entre arrastrar, enviar a meta y descartar, con suma exacta. El exceso DEBE arrastrarse o absorberse.
- **RF-M11-09:** "Enviar a meta" DEBE:
  - crear un apartado en la cuenta que elija el usuario, dentro de su saldo libre (M12);
  - si la meta tiene cuenta dedicada, ofrecer como alternativa una transferencia real hacia ella;
  - estar disponible solo en el presupuesto general o, si no existe, en los presupuestos de categorías principales. Las subcategorías solo arrastran o descartan.
- **RF-M11-10:** Si en 7 días no hay decisión, el sistema DEBE aplicar la acción por defecto del presupuesto.
- **RF-M11-11:** Los movimientos tardíos (cargados, editados o eliminados con fecha de un período ya cerrado) NO DEBEN reabrir la decisión. La diferencia va al arrastre del período en curso, explicada como "Ajuste por movimientos tardíos de [período]".
- **RF-M11-12:** "Reiniciar arrastre" DEBE poner el acumulado en 0, con una confirmación que muestra el monto.
- **RF-M11-13:** Los umbrales (de 0 a 3, entre 1 % y 150 %) DEBEN medirse sobre el disponible:
  - cada uno avisa una sola vez por período (RN-10);
  - si un presupuesto se crea, o un período empieza, ya por encima de umbrales, solo se avisa el más alto cruzado;
  - un presupuesto pausado no alerta.
- **RF-M11-14:** Un presupuesto superado DEBE seguir contando gastos y mostrarse como superado.

#### 2.11.4 Casos borde y excepciones
- **EC-M11-01:** El arrastre negativo supera el monto del período. El período empieza superado y la barra lo muestra.
- **EC-M11-02:** En el cierre se envía a una meta más que el saldo libre de la cuenta elegida. Se rechaza y se pide otra cuenta o un monto menor.
- **EC-M11-03:** Se elimina la meta elegida mientras el cierre está pendiente. Esa opción desaparece de la tarjeta.
- **EC-M11-04:** Se archiva la categoría con una decisión de cierre pendiente. La decisión sigue disponible hasta los 7 días.
- **EC-M11-05:** Se elimina un gasto de un período cerrado. El arrastre del período en curso sube por ese monto (RF-M11-11).
- **EC-M11-06:** Se intenta crear un segundo presupuesto para la misma categoría. Se rechaza y se ofrece editar el existente.

#### 2.11.5 Criterios de aceptación
```gherkin
Escenario: Repartir un sobrante
  Dado el presupuesto "Comida" de 800,00 Bs que cerró octubre con 650,00 Bs gastados
  Cuando el usuario arrastra 50,00 y envía 100,00 a la meta "Viaje" desde el Banco
  Entonces noviembre tiene disponible 850,00 Bs
  Y la meta "Viaje" suma un apartado de 100,00 Bs en el Banco

Escenario: Exceso arrastrado
  Dado el presupuesto "Ocio" de 300,00 Bs que cerró con 400,00 Bs gastados
  Cuando el usuario elige "Arrastrar"
  Entonces el período siguiente tiene disponible 200,00 Bs

Escenario: Decisión por defecto
  Dado un cierre pendiente con acción por defecto "Descartar"
  Cuando pasan 7 días sin decisión
  Entonces el resultado se descarta
  Y el período en curso no tiene arrastre de ese cierre

Escenario: Umbral avisa una sola vez
  Dado un presupuesto con umbral 80 % ya cruzado este período
  Cuando el usuario elimina un gasto, baja del 80 % y luego lo vuelve a cruzar
  Entonces no se genera un segundo aviso del 80 %
```

---

### 2.12 M12 — Metas de ahorro (V1.1)

#### 2.12.1 Flujos de usuario
**Crear una meta**
1. El usuario toca "Nueva meta" e ingresa:
   - el nombre;
   - el monto objetivo y la moneda;
   - la fecha objetivo (opcional);
   - el ícono y el color.
2. Opcionalmente, dedica a la meta una cuenta. Todo su saldo actual cuenta desde ese momento.
3. La app muestra el aporte mensual sugerido.

**Aportar con un apartado**
1. Desde la meta, el usuario toca "Apartar", elige una cuenta y un monto (hasta el saldo libre).
2. El dinero sigue en la cuenta pero queda reservado. La cuenta muestra Saldo · Apartado para metas · Libre.

**Aportar a la cuenta dedicada:** cualquier ingreso o transferencia hacia la cuenta dedicada suma automáticamente.

**Retirar:** el usuario libera un apartado (total o parcial). En la cuenta dedicada, toda salida resta automáticamente.

**Usar y cerrar**
1. Al usar el dinero, el usuario toca "Usar y cerrar". Se liberan todos los apartados, la cuenta dedicada vuelve a ser normal y la meta pasa a Archivada.
2. El usuario registra el gasto real como un gasto normal.

#### 2.12.2 Ciclo de vida y estados

| Desde | Hacia | Condición |
|---|---|---|
| — | En curso | Creación |
| En curso | Cumplida | Progreso ≥ objetivo (la celebración se muestra solo la primera vez) |
| Cumplida | En curso | El progreso baja del objetivo (por retiros, ediciones o el tipo de cambio) y la fecha no pasó |
| Cumplida | Vencida | El progreso baja del objetivo y la fecha objetivo ya pasó |
| En curso | Vencida | Pasa la fecha objetivo sin cumplirse |
| Vencida | En curso | Se extiende la fecha objetivo |
| Vencida | Cumplida | Progreso ≥ objetivo |
| Cualquiera (sin apartados ni cuenta dedicada) | Archivada | Acción del usuario |
| Cualquiera | Archivada | "Usar y cerrar" (libera todo) |
| Archivada | En curso / Cumplida / Vencida | Restaurar (según el progreso; sin apartados previos) |

- El estado SIGUE al progreso, incluido el efecto del tipo de cambio.
- Prohibido: archivar o eliminar una meta con apartados o cuenta dedicada, salvo con "Usar y cerrar". Una meta vacía sí se elimina, junto con su historia.

#### 2.12.3 Requerimientos funcionales
- **RF-M12-01:** El nombre DEBE tener de 1 a 40 caracteres, el objetivo DEBE ser mayor que 0 y la fecha objetivo, si existe, DEBE ser hoy o futura. La moneda es cualquiera activa y se puede editar.
- **RF-M12-02:** El progreso DEBE ser el saldo de su cuenta dedicada (si tiene, con mínimo 0) más sus apartados en otras cuentas, convertido a la moneda de la meta con la tasa vigente. No existen aportes sin cuenta.
- **RF-M12-03:** Una meta DEBE tener como máximo una cuenta dedicada. Una cuenta dedicada pertenece a una sola meta y no tiene apartados de otras metas.
- **RF-M12-04:** Una cuenta normal PUEDE tener apartados de varias metas. Solo se aparta dentro del saldo libre.
- **RF-M12-05:** El sistema DEBE pedir confirmación antes de guardar todo gasto, transferencia o edición que deje el saldo de una cuenta por debajo de lo apartado, o que saque dinero de una cuenta dedicada:
  - la confirmación muestra "Este gasto usa X apartados" y las metas afectadas;
  - viene una propuesta precargada (primero la meta con la fecha más lejana o sin fecha) que el usuario puede cambiar;
  - si confirma, se guarda y los apartados se reducen, registrado como retiro en cada meta;
  - si cancela, no se guarda nada.
- **RF-M12-06:** Aporte mensual sugerido = (objetivo − progreso) ÷ meses calendario restantes, incluido el actual. Además:
  - si la fecha es este mes, se muestra "Faltan X este mes";
  - sin fecha, una calculadora "Aportando X/mes llegas en [mes]";
  - si está vencida, "Elige una nueva fecha".
- **RF-M12-07:** El detalle DEBE mostrar el progreso por cuenta, la historia de apartados y retiros con su origen (manual, presupuesto, cuenta dedicada, gasto confirmado) y el sugerido.
- **RF-M12-08:** El total neto de Cuentas NO DEBE cambiar por los apartados. El desglose suma la línea "Apartado para metas".
- **RF-M12-09:** "Usar y cerrar" DEBE liberar todos los apartados, convertir la cuenta dedicada en normal y archivar la meta con su historia.

#### 2.12.4 Casos borde y excepciones
- **EC-M12-01:** Se intenta apartar más que el saldo libre. Se rechaza indicando el saldo libre.
- **EC-M12-02:** Se intenta archivar una cuenta con apartados. Se rechaza indicando qué metas debe liberar primero.
- **EC-M12-03:** Una meta en USD con apartados en BOB baja del 100 % porque el dólar subió. Pasa a En curso.
- **EC-M12-04:** La cuenta dedicada queda en negativo (un banco con sobregiro). Aporta 0 a la meta, nunca un valor negativo.
- **EC-M12-05:** Un recurrente automático tocaría dinero apartado. No se registra y pasa a pendiente (M14).
- **EC-M12-06:** Se dedica a una meta una cuenta que ya tiene apartados de otras metas. Se rechaza: primero hay que liberar esos apartados.

#### 2.12.5 Criterios de aceptación
```gherkin
Escenario: Progreso combinado
  Dado la meta "Viaje" con cuenta dedicada "Ahorro" de saldo 850,00 Bs
  Y apartados de 200,00 Bs en el Banco y 150,00 Bs en Efectivo
  Entonces el progreso de "Viaje" es 1 200,00 Bs

Escenario: Gasto que toca dinero apartado
  Dado el Banco con saldo 4 800,00 Bs y 300,00 Bs apartados
  Cuando el usuario registra un gasto de 4 600,00 Bs desde el Banco
  Entonces la app pregunta de qué metas tomar 100,00 Bs
  Cuando confirma
  Entonces el gasto se guarda y los apartados del Banco quedan en 200,00 Bs

Escenario: Usar y cerrar
  Dado la meta "Laptop" cumplida con apartados en dos cuentas
  Cuando el usuario toca "Usar y cerrar"
  Entonces los apartados se liberan
  Y la meta queda Archivada con su historia
```

---

### 2.13 M13 — Deudas y préstamos (V1.1)

#### 2.13.1 Flujos de usuario
**Registrar una deuda**
1. El usuario toca "Nueva deuda" y elige la dirección: "Debo" o "Me deben".
2. Completa:
   - la persona (texto con autocompletado);
   - el monto, la moneda y la fecha de inicio;
   - la fecha límite y la nota (opcionales);
   - el interés simple (opcional): un porcentaje mensual o anual.
3. Opcionalmente indica la cuenta por la que se movió el dinero:
   - en "Debo", entra a la cuenta como ingreso de "Deudas y préstamos";
   - en "Me deben", sale de la cuenta como gasto de "Deudas y préstamos".
4. La deuda aparece en la lista con su saldo pendiente y, si tiene fecha límite, en los próximos vencimientos del Inicio.

**Registrar un pago**
1. Desde la deuda, el usuario toca "Registrar pago" y escribe el monto.
2. La app propone el desglose, primero el interés acumulado y luego el capital, y el usuario puede cambiarlo.
3. Elige la cuenta (opcional) y la fecha. Si la cuenta tiene otra moneda, indica el tipo de cambio usado.
4. Guarda. Si eligió una cuenta, se crean los movimientos vinculados:
   - la parte de capital en "Deudas y préstamos";
   - la parte de interés en "Deudas y préstamos › Intereses".

   En "Debo" son gastos; en "Me deben", ingresos.

**Condonar:** el usuario toca "Condonar saldo" y la deuda pasa a Condonada sin mover dinero.

**Consultar**
- Arriba de la lista, el resumen "Debes X · Te deben Y" en moneda base.
- La lista se ve por deuda (por defecto) o agrupada por persona, con el neto de cada una.

#### 2.13.2 Ciclo de vida y estados

| Desde | Hacia | Condición |
|---|---|---|
| — | Activa | Creación |
| Activa | Vencida | Pasa la fecha límite con saldo pendiente |
| Vencida | Activa | Se extiende la fecha límite |
| Activa o Vencida | Pagada | Capital pendiente = 0 e interés pendiente = 0 |
| Activa o Vencida | Condonada | "Condonar saldo" |
| Cualquiera | Eliminada | Con confirmación (ver RF-M13-11) |

- Estados finales: Pagada, Condonada y Eliminada.
- Prohibido: pagos sobre una deuda Pagada o Condonada.

#### 2.13.3 Requerimientos funcionales
- **RF-M13-01:** La persona DEBE tener de 1 a 40 caracteres, con autocompletado sobre las personas ya usadas. El monto es mayor que 0.
- **RF-M13-02:** El interés simple DEBE acumularse día a día sobre el capital pendiente, desde la fecha de inicio, y seguir corriendo después de la fecha límite hasta que el capital llegue a 0. Se muestra aparte del capital.
- **RF-M13-03:** La tasa y el período de interés DEBEN quedar fijos al crear la deuda.
- **RF-M13-04:** El interés ya acumulado NUNCA DEBE recalcularse. Un pago con fecha pasada reduce el capital, y el interés corre sobre el nuevo capital desde el momento en que se registra.
- **RF-M13-05:** En cada pago, el desglose DEBE venir precargado (interés primero) y ser editable, cumpliendo:
  - interés ≤ interés acumulado;
  - capital ≤ capital pendiente;
  - interés + capital = monto del pago.
- **RF-M13-06:** Saldo pendiente = capital pendiente + interés acumulado no pagado. Nunca es negativo, y un pago no puede superarlo.
- **RF-M13-07:** La fecha de un pago DEBE estar entre la fecha de inicio y hoy.
- **RF-M13-08:** La parte de interés de un pago DEBE contar como gasto ("Debo") o como ingreso ("Me deben"). La parte de capital y el movimiento inicial NO cuentan (RN-02).
- **RF-M13-09:** Un pago desde una cuenta de otra moneda DEBE pedir el tipo de cambio usado, precargado con el paralelo y editable, y guardarlo.
- **RF-M13-10:** La edición DEBE cumplir:
  - persona, nota y fecha límite: siempre;
  - monto original: solo si queda mayor o igual al capital ya pagado;
  - dirección, moneda, tasa y período: fijos.

  La cuenta y el movimiento inicial se editan desde la deuda.
- **RF-M13-11:** Al eliminar una deuda con pagos, el usuario DEBE elegir entre "Eliminar también los N movimientos asociados" y "Conservarlos como movimientos normales". Ambas opciones respetan el bloqueo de negativos y los apartados. Una deuda sin pagos se elimina directamente.
- **RF-M13-12:** "Condonar saldo" DEBE cerrar la deuda en Condonada, mostrar el monto condonado y no crear movimientos.
- **RF-M13-13:** El resumen DEBE mostrar el total que se debe y el total que deben al usuario, en moneda base con la referencia vigente. La vista por persona muestra el neto de cada persona.
- **RF-M13-14:** Los avisos de vencimiento (desde la V1.1) DEBEN llegar 3 días antes, el día del vencimiento y el día siguiente si la deuda quedó vencida. Después no insisten.

#### 2.13.4 Casos borde y excepciones
- **EC-M13-01:** Un pago supera el saldo pendiente. Se rechaza indicando el saldo.
- **EC-M13-02:** El capital llega a 0 pero queda interés acumulado sin pagar. La deuda sigue Activa (o Vencida) hasta saldarlo, y ya no se acumula más interés.
- **EC-M13-03:** El pago sale del efectivo y lo dejaría en negativo. Se rechaza (M4).
- **EC-M13-04:** El pago sale de una cuenta con apartados. Se aplica la confirmación de M12.
- **EC-M13-05:** Se edita un pago y su nuevo desglose supera el interés acumulado a su fecha de registro. Se rechaza con la explicación.
- **EC-M13-06:** La misma persona aparece en "Debo" y en "Me deben". La vista por persona muestra el neto.

#### 2.13.5 Criterios de aceptación
```gherkin
Escenario: Interés sobre el capital pendiente
  Dado una deuda "Debo" de 2 000,00 Bs al 2 % mensual
  Y un pago de capital de 1 000,00 Bs
  Entonces desde ese momento el interés se acumula sobre 1 000,00 Bs
  Y el interés acumulado antes del pago no cambia

Escenario: Desglose precargado
  Dado una deuda con interés acumulado 42,30 Bs y capital pendiente 2 000,00 Bs
  Cuando el usuario registra un pago de 500,00 Bs
  Entonces el desglose propuesto es interés 42,30 y capital 457,70
  Y al guardar desde el Banco, 42,30 Bs cuentan como gasto en "Intereses"

Escenario: Condonar
  Dado una deuda "Me deben" con saldo pendiente 300,00 Bs
  Cuando el usuario condona el saldo
  Entonces la deuda queda Condonada
  Y no se crea ningún movimiento
```

---

### 2.14 M14 — Recurrentes (V1.2)

#### 2.14.1 Flujos de usuario
**Crear una regla**
1. En Recurrentes, el usuario toca "Nueva regla" y elige el tipo: gasto, ingreso o transferencia.
2. Define:
   - el monto, la cuenta (o el origen y el destino), la categoría y la nota;
   - la frecuencia: diaria, semanal (eligiendo el día), mensual (día fijo) o anual (fecha fija);
   - la fecha de inicio (hoy o futura);
   - el fin: sin fin, hasta una fecha o después de N veces;
   - el modo: automático o con confirmación.
3. Guarda. La regla muestra sus próximas fechas.

**En la fecha de una ocurrencia**
- En modo automático, el movimiento se registra a las 00:00 en la zona horaria del usuario.
- En modo confirmación, se crea un pendiente. Se ve en la bandeja (si el aviso está activo) y siempre en la sección "Pendientes de confirmar" de Recurrentes.
- El usuario confirma (ajustando el monto, la fecha o la tasa) u omite.

**Pausar y reanudar**
1. El usuario pausa la regla.
2. Al reanudarla, la app pregunta si registrar las ocurrencias que cayeron durante la pausa.

#### 2.14.2 Ciclo de vida y estados

**Regla**

| Desde | Hacia | Condición |
|---|---|---|
| — | Activa | Creación |
| Activa | Pausada | Por el usuario, o automáticamente si se archiva su categoría o su cuenta (con aviso) |
| Pausada | Activa | Reanudar (con la pregunta por las ocurrencias saltadas) |
| Activa | Finalizada | Se alcanza la fecha de fin o las N veces |
| Finalizada | Activa | Se extiende el fin |
| Cualquiera | Eliminada | Por el usuario |

- Estado final: Eliminada.

**Ocurrencia:** ver el ciclo de Pendiente en M6.

#### 2.14.3 Requerimientos funcionales
- **RF-M14-01:** Las frecuencias DEBEN ser diaria, semanal, mensual con día fijo y anual. Una regla semanal respeta el día elegido.
- **RF-M14-02:** Si el día elegido no existe en un mes, la ocurrencia DEBE caer el último día del mes. El 29 de febrero pasa al 28 en los años no bisiestos.
- **RF-M14-03:** La fecha de inicio DEBE ser hoy o futura. El sistema NUNCA genera ocurrencias anteriores a la creación de la regla.
- **RF-M14-04:** Las ocurrencias DEBEN ejecutarse a las 00:00 en la zona horaria del usuario.
- **RF-M14-05:** Una ocurrencia automática DEBE quedar como pendiente si dejaría una cuenta en negativo (M4) o si tocaría dinero apartado (M12).
- **RF-M14-06:** En una transferencia recurrente entre monedas distintas, el modo automático DEBE usar la tasa del día. En modo confirmación, el usuario ajusta la tasa al confirmar.
- **RF-M14-07:** Un pendiente sin decisión DEBE pasar a Omitido a los 30 días, con un aviso. Las ocurrencias siguientes se generan aunque haya pendientes anteriores.
- **RF-M14-08:** Un pendiente se confirma con su fecha original o con otra, sin fechas futuras.
- **RF-M14-09:** Al reanudar una regla, el sistema DEBE preguntar si registrar las ocurrencias saltadas, respetando los bloqueos de M4 y M12. Las registradas cuentan para el total de N veces.
- **RF-M14-10:** Editar una regla DEBE afectar solo a las ocurrencias futuras. Los pendientes y los movimientos ya creados no cambian.
- **RF-M14-11:** Eliminar una regla DEBE conservar los movimientos creados y borrar sus pendientes.
- **RF-M14-12:** NUNCA DEBE existir más de una ocurrencia de la misma regla para la misma fecha. Si el sistema estuvo caído, recupera las ocurrencias de esos días sin duplicarlas.
- **RF-M14-13:** La pantalla DEBE mostrar:
  - las reglas con su próxima fecha;
  - "Pendientes de confirmar";
  - "Próximos vencimientos" de 30 días;
  - por regla, las siguientes 3 fechas y "Cuota X de N" si el fin es por cantidad.

#### 2.14.4 Casos borde y excepciones
- **EC-M14-01:** Una regla mensual con el día 31 en noviembre. La ocurrencia cae el 30 de noviembre.
- **EC-M14-02:** Se archiva la cuenta de la regla. La regla se pausa con un aviso para elegir otra cuenta.
- **EC-M14-03:** El sistema estuvo caído 2 días. Al volver, crea las ocurrencias de esos días una sola vez.
- **EC-M14-04:** Se elimina una regla con un pendiente. El pendiente desaparece.
- **EC-M14-05:** Se reanuda una regla de "12 veces" que ya registró 12. No genera más y pasa a Finalizada.

#### 2.14.5 Criterios de aceptación
```gherkin
Escenario: Automático bloqueado pasa a pendiente
  Dado una regla automática "Pasaje" de 50,00 Bs desde Efectivo
  Y el Efectivo tiene 30,00 Bs
  Cuando llega la fecha de la ocurrencia
  Entonces no se registra el gasto
  Y se crea un pendiente visible en "Pendientes de confirmar"

Escenario: Pendiente vence
  Dado un pendiente creado hace 30 días sin decisión
  Entonces pasa a Omitido
  Y se genera un aviso

Escenario: Reanudar con ocurrencias saltadas
  Dado una regla semanal pausada durante 3 semanas
  Cuando el usuario la reanuda
  Entonces la app pregunta si registrar las 3 ocurrencias saltadas
```

---

### 2.15 M15 — Recordatorios y avisos (bandeja básica en V1.1, completo en V1.2)

#### 2.15.1 Flujos de usuario
**Bandeja**
1. La campana de la cabecera muestra el número de avisos sin leer.
2. El usuario abre la bandeja. Tocar un aviso lo marca como leído y lleva a su pantalla.
3. Los avisos que piden decisión (cierre de presupuesto, pendiente de recurrente) tienen sus botones en la misma bandeja.
4. El usuario puede marcar todo como leído o deslizar un aviso para eliminarlo.

**Configurar** (V1.2): en Ajustes › Recordatorios, el usuario activa o desactiva cada tipo y ajusta su hora, los días de anticipación (de 0 a 7) o los días de la semana, según el tipo.

#### 2.15.2 Ciclo de vida y estados

| Desde | Hacia | Condición |
|---|---|---|
| — | No leído | Se genera el aviso |
| No leído | Leído | El usuario lo toca, o usa "Marcar todo como leído" |
| No leído o Leído | Eliminado | El usuario lo desliza, o pasan 90 días |
| Esperando decisión | Resuelto | El usuario decide, o el sistema aplica el valor por defecto (7 días para un cierre, 30 días para un pendiente) |

- Prohibido: borrar por antigüedad un aviso que espera una decisión.

#### 2.15.3 Requerimientos funcionales
- **RF-M15-01:** Todos los avisos DEBEN llegar solo dentro de la app, sin correo de avisos ni notificaciones push.
- **RF-M15-02:** Los tipos y sus valores por defecto DEBEN ser:

  | Tipo | Activo por defecto | Comportamiento |
  |---|---|---|
  | Pago próximo | Sí | Recurrentes, 1 día antes. Tarjetas, el día del corte y 3 días antes del pago. Deudas, 3 días antes, el día y el día siguiente si quedó vencida |
  | Alertas de presupuesto | Sí | Según los umbrales de cada presupuesto (M11) |
  | Cierre de período | Sí | Al cerrar cada período de presupuesto |
  | Pendiente de recurrente | Sí | Al generarse un pendiente y al omitirse por vencimiento |
  | Registrar el día | No | Siempre a la hora elegida (21:00 por defecto), en los días de la semana elegidos |
  | Avance de metas | No | Al cruzar el 25 %, 50 %, 75 % y 100 %. Además, el día 1 de cada mes, si el mes anterior se aportó menos que lo sugerido |

- **RF-M15-03:** Todos los tipos DEBEN poder desactivarse. Desactivar un tipo de decisión no oculta la decisión: los pendientes siguen en Recurrentes y la tarjeta de cierre en el presupuesto.
- **RF-M15-04:** Un mismo evento NUNCA DEBE generar dos avisos (RN-10). Cada hito de meta avisa una sola vez, aunque el tipo de cambio lo haga oscilar.
- **RF-M15-05:** Los avisos DEBEN borrarse solos a los 90 días, salvo los que esperan una decisión.
- **RF-M15-06:** El contador de la campana DEBE mostrar los avisos no leídos.
- **RF-M15-07:** En la V1.1 existen la campana, la bandeja y los avisos de alertas de presupuesto, cierre de período y vencimiento de deudas, todos activos y sin configuración. La V1.2 agrega los demás tipos y la configuración.
- **RF-M15-08:** El aviso de "cambio fuerte del dólar" NO existe.

#### 2.15.4 Casos borde y excepciones
- **EC-M15-01:** El usuario resuelve un pendiente desde Recurrentes. El aviso de la bandeja queda Resuelto.
- **EC-M15-02:** Se cambia el día de pago de una tarjeta después de generado su aviso. El aviso ya generado no se repite, y el próximo usa la nueva fecha.
- **EC-M15-03:** El aviso "Registrar el día" se genera aunque ya haya movimientos ese día, porque es el comportamiento elegido.

#### 2.15.5 Criterios de aceptación
```gherkin
Escenario: Aviso de vencimiento de deuda
  Dado una deuda "Debo" a Juan con fecha límite el 20/10
  Cuando es 17/10
  Entonces llega a la bandeja "Vence en 3 días: debes 1 200,00 Bs a Juan"

Escenario: Decisión visible con el aviso desactivado
  Dado que el usuario desactivó los avisos de pendientes de recurrentes
  Cuando se genera un pendiente
  Entonces no aparece en la bandeja
  Y sí aparece en "Pendientes de confirmar" de Recurrentes

Escenario: Sin duplicados
  Dado que ya se avisó el hito 50 % de la meta "Viaje"
  Cuando el progreso baja y vuelve a cruzar el 50 %
  Entonces no se genera otro aviso
```

---

## 3. Requerimientos no funcionales globales (RNF)

### 3.1 Tiempos límite
- **RNF-01:** Registrar un movimiento DEBE tomar menos de 10 segundos desde abrir la app (flujo M7).
- **RNF-02:** Guardar un movimiento DEBE tardar menos de 1 segundo en el 95 % de los casos.
- **RNF-03:** El Inicio DEBE cargar en menos de 2 segundos con 5 000 movimientos, en una conexión 4G.
- **RNF-04:** La actualización del tipo de cambio NUNCA DEBE bloquear ni demorar el uso de la app.

### 3.2 Compatibilidad y accesibilidad
- **RNF-05:** La app DEBE funcionar desde 360 px de ancho en las versiones actuales de Chrome, Safari y Firefox, con las mismas funciones en celular y escritorio.
- **RNF-06:** La app DEBE cumplir contraste AA y ser usable por completo con teclado.
- **RNF-07:** Todos los textos DEBEN estar en español de Bolivia y preparados para traducirse.

### 3.3 Concurrencia
- **RNF-08:** El mismo usuario PUEDE usar varios dispositivos a la vez. Ante ediciones simultáneas del mismo dato, gana la última guardada.
- **RNF-09:** Una acción sobre un dato eliminado en otro dispositivo DEBE informar que el dato ya no existe, sin guardar nada.
- **RNF-10:** Las validaciones de saldo (negativos y apartados) DEBEN evaluarse con el saldo vigente al momento de guardar, no con el que se veía en pantalla.

### 3.4 Idempotencia
- **RNF-11:** Un doble toque, un reintento o una reconexión NUNCA DEBEN duplicar movimientos, pagos, apartados ni decisiones.
- **RNF-12:** Un recurrente genera como máximo una ocurrencia por regla y fecha. Un cierre de presupuesto se decide una sola vez por presupuesto y período. Un aviso se genera una sola vez por evento.
- **RNF-13:** Los procesos automáticos que se interrumpan DEBEN retomarse sin duplicar ni omitir lo pendiente.

### 3.5 Privacidad y seguridad
- **RNF-14:** Cada usuario accede SOLO a sus datos. Un dato ajeno se comporta como inexistente.
- **RNF-15:** Los mensajes de registro, recuperación e inicio de sesión NO DEBEN revelar si un correo tiene cuenta ni cuál dato es incorrecto.
- **RNF-16:** El usuario DEBE poder exportar todos sus datos y eliminarlos por completo y de inmediato.
- **RNF-17:** La app NUNCA DEBE mostrar al usuario detalles internos en los mensajes de error.

### 3.6 Exactitud monetaria
- **RNF-18:** Los cálculos DEBEN ser exactos al centavo. Las conversiones se redondean a 2 decimales con la mitad hacia arriba, y no deben acumularse diferencias por redondeo.
- **RNF-19:** Los valores históricos (movimientos, períodos cerrados, interés acumulado) NUNCA DEBEN cambiar por movimientos del tipo de cambio ni por cambios de configuración.

### 3.7 Tiempo
- **RNF-20:** Todas las fechas de negocio (día de un movimiento, períodos, vencimientos, ejecución de recurrentes y avisos) DEBEN calcularse en la zona horaria del perfil del usuario.

### 3.8 Disponibilidad y tolerancia a fallos
- **RNF-21:** Si fallan las fuentes del tipo de cambio, la app DEBE seguir funcionando con el último valor guardado (M3).
- **RNF-22:** Si falla el servicio de correo, el usuario DEBE poder reenviar los correos de la cuenta respetando los límites (M1).
- **RNF-23:** Sin conexión, la app DEBE bloquearse sin perder los borradores (M2).

### 3.9 Auditoría y retención
- **RNF-24:** En la V1 no existe un historial de ediciones por movimiento.
- **RNF-25:** Los eventos de seguridad (intentos fallidos, cambio de contraseña, eliminación de la cuenta) DEBEN notificarse al dueño por correo.
- **RNF-26:** Retención:
  - avisos: 90 días (salvo los que esperan decisión);
  - registros sin confirmar: 7 días;
  - datos de una cuenta eliminada: se borran de inmediato.
- **RNF-27:** La fuente "paralelo.bo" DEBE mostrarse junto a sus datos, como exige su licencia de uso.
