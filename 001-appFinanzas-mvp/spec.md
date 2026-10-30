# Especificación Funcional — App de Finanzas Personales

**Versión:** 1.5 · **Fecha:** 2026-10-28 · **Alcance:** V1 completa (V1.0, V1.1, V1.2)
**Estado:** V1.0 Aprobada · V1.1 Aprobada · V1.2 Aprobada (2026-10-16)
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
| **Usuario sin confirmar** | Se registró pero no confirmó su correo. No tiene sesión | Ver la pantalla "Revisa tu correo" y reenviar la confirmación. Nada más |
| **Usuario** | Persona con sesión y correo confirmado | Todo lo descrito en este documento, SOLO sobre sus propios datos |
| **Sistema** | Procesos automáticos, sin intervención humana | Actualizar el tipo de cambio, ejecutar los recurrentes, cerrar los períodos de presupuesto, generar avisos, omitir pendientes vencidos, descartar registros sin confirmar |
| **Fuentes externas** | Mercado paralelo (paralelo.bo), Banco Central de Bolivia y servicio de correo | Proveer tasas y entregar los correos de la cuenta. Pueden fallar, y el sistema DEBE tolerarlo |

- No existen roles de administración, cuentas compartidas ni acceso de un usuario a los datos de otro.

### 1.4 Fuera de alcance (Out-of-Scope)
- Reportes: flujo de caja, comparativos de varios períodos y exportación a PDF. SÍ entran la variación contra el mes anterior y el ritmo del gasto del Inicio, y las proyecciones simples de presupuestos y metas ("X/día", "llegas en [mes]").
- Inteligencia artificial: categorización, asistente, OCR, proyecciones con IA, gastos hormiga.
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
- **Moneda base:** moneda en la que se expresan los totales. BOB por defecto. Puede ser cualquier moneda activa.
- **Otra moneda:** la de BOB y USD que no es la base. Si la base es otra moneda, BOB. Es la moneda de los equivalentes (total neto, detalle de cuenta).
- **Referencia del dólar:** cotización que la app usa para convertir. Opciones: paralelo (compra, venta o mediana), oficial del BCB (TCO, un solo valor) o valor manual. En el paralelo, "venta" es el mayor de los dos valores publicados (lo que paga quien compra dólares) y "compra" el menor, sin importar cómo los nombre la fuente.
- **Tasa guardada:** tipo de cambio que un movimiento guarda al guardarse. NUNCA cambia por movimientos del mercado ni al editar la fecha o la cuenta del movimiento. Solo cambia si el usuario la edita a mano (RF-M3-10).
- **Historial de tasas:** una tasa por moneda y por día: las referencias automáticas del dólar, el valor manual y las tasas de las monedas agregadas (RF-M3-13).
- **Movimiento:** gasto, ingreso, transferencia o ajuste.
- **Movimiento vinculado:** movimiento creado por otro módulo: movimiento inicial o pago de una deuda, comisión de una transferencia o transferencia de "Enviar a meta". Su monto, cuenta y fecha se editan solo desde su origen.
- **Apartado:** dinero de una cuenta reservado para una meta. Sigue en la cuenta. Apartar y retirar NO son movimientos.
- **Saldo libre:** saldo de una cuenta menos sus apartados.
- **Cuenta dedicada:** cuenta cuyo saldo completo pertenece a una meta.
- **Período (de presupuesto):** lapso de un mes que empieza en el día de inicio elegido para ese presupuesto (de 1 a 28).
- **Arrastre:** monto, positivo o negativo, que un cierre pasa al período siguiente. Cada cierre lo reemplaza: no se suma al arrastre anterior.
- **Disponible (de presupuesto):** monto del período más (o menos) el arrastre. El término "disponible" se usa solo en presupuestos.
- **Líquido:** en el desglose de Cuentas, la suma de efectivo, banco, billetera y otro.
- **Crédito disponible:** en una tarjeta con límite, límite − deuda.
- **Pendiente:** ocurrencia recurrente que espera confirmación. No cuenta en saldos ni totales.

### 1.6 Reglas de negocio transversales (RN)
Estas reglas aplican a todos los módulos y prevalecen sobre cualquier regla de módulo.

- **RN-01:** El saldo de una cuenta = saldo inicial + entradas − salidas, contando solo los movimientos con fecha igual o posterior a la del saldo inicial. El saldo NUNCA se edita a mano: se corrige con un ajuste. El saldo inicial y su fecha quedan fijos al crear la cuenta (RF-M4-07).
- **RN-02:** NO cuentan como ingreso ni como gasto (en el Inicio ni en los presupuestos):
  - las transferencias;
  - los ajustes;
  - los pendientes;
  - los movimientos con la categoría del sistema "Deudas y préstamos". La excepción es su subcategoría "Intereses", que SÍ cuenta.
- **RN-03:** La moneda de un movimiento es SIEMPRE la de su cuenta.
- **RN-04:** Todo movimiento, también si está en la moneda base, guarda al guardarse la tasa de su moneda frente al boliviano y la boliviano-dólar (RF-M3-06). Sus valores en cualquier moneda base se derivan de esas tasas guardadas y, para una moneda que el movimiento no guardó, del historial de tasas en su fecha. No cambian después, salvo que el usuario edite la tasa a mano.
- **RN-05:**
  - Los saldos y totales actuales (cuentas, deudas, metas) se convierten con la referencia vigente.
  - Los ingresos y gastos de un período se convierten con la tasa guardada en cada movimiento.
- **RN-06:** Los montos y las tasas de cambio se guardan y se muestran con 2 decimales. Las conversiones se redondean a 2 decimales con la mitad hacia arriba; en negativos, la mitad se aleja del cero (−0,005 → −0,01). Los totales son la suma de las conversiones ya redondeadas de cada movimiento.
- **RN-07:** Un movimiento tiene fecha de hoy o anterior, nunca futura. No hay fecha mínima. Su fecha es el día local según la zona horaria del perfil del usuario. Cambiar la zona horaria no altera la fecha de los movimientos ya registrados, aunque en la nueva zona quede como futura.
- **RN-08:** Lo que tiene historia se archiva, no se elimina: cuentas y categorías con movimientos.
- **RN-09:** Cada usuario accede solo a sus propios datos. Un recurso ajeno se comporta como inexistente.
- **RN-10:** Un mismo evento nunca genera dos avisos. Una misma acción repetida (doble toque, reintento) nunca genera dos registros.
- **RN-11:** Los valores históricos NUNCA cambian por el tipo de cambio ni por cambios de configuración. Solo las correcciones de datos del usuario alteran cifras de meses pasados: crear, editar o eliminar movimientos con fecha pasada (incluida una tasa editada a mano), eliminar el último pago de una deuda, y fusionar categorías o mover subcategorías (asignar una categoría es un dato, no configuración). Archivar una cuenta o una categoría NO las altera: sus movimientos siguen contando en los ingresos y gastos de su mes.
- **RN-12:** Un movimiento con fecha anterior al saldo inicial de su cuenta no altera el saldo (RN-01), pero SÍ cuenta como ingreso o gasto en el Inicio, en la lista y en los presupuestos.
- **RN-13:** Todo nombre de texto (usuario, cuenta, categoría, meta, persona, atajo) se valida después de quitarle los espacios del inicio y del final.

---

## 2. Desglose por módulos

---

### 2.1 M1 — Acceso y cuenta de usuario (V1.0)

#### 2.1.1 Flujos de usuario
**Registro**
1. El visitante abre "Crear cuenta" e ingresa su nombre (1-60 caracteres), su correo y una contraseña (de 8 a 128 caracteres).
2. Marca la casilla obligatoria "Acepto los términos y la política de privacidad".
3. Al enviar, ve siempre el mismo mensaje: "Si el correo es válido, te enviamos un enlace para confirmar tu cuenta".
4. Si el correo es nuevo, recibe un enlace de confirmación válido por 24 h. Si el correo tenía un registro Sin confirmar, se reemplazan el nombre y la contraseña, se invalida el enlace anterior y se envía uno nuevo. Si el correo ya tenía una cuenta Activa, el dueño recibe un aviso: "Alguien intentó registrarse con tu correo. ¿Querías iniciar sesión?".
5. Registrarse NUNCA abre sesión. En todos los casos ve "Revisa tu correo", con la opción de reenviar.
6. Al abrir el enlace, la cuenta queda Activa. El enlace solo confirma la cuenta: no abre sesión. La app donde el usuario se registró, si sigue abierta en "Revisa tu correo", detecta la confirmación, inicia la sesión y comienza sola el Onboarding (M10), aunque el enlace se haya abierto en otro dispositivo. Si en ese navegador había una sesión de otro usuario, esa se cierra y su borrador se descarta. Si ya no hay una app esperando, el usuario inicia sesión con su correo y su contraseña.

**Inicio de sesión**
1. El visitante ingresa su correo y su contraseña.
2. Si son correctos y el correo está confirmado, entra al Inicio, o al Onboarding si no lo terminó.
3. Si son correctos pero el correo no está confirmado, ve "Revisa tu correo", sin que se abra la sesión.
4. Si son incorrectos, ve "Correo o contraseña incorrectos", sin indicar cuál de los dos falló.

**Recuperación de contraseña**
1. El visitante toca "Olvidé mi contraseña" e ingresa su correo. Ve el mensaje neutro.
2. Si el correo existe, recibe un enlace válido por 1 h y de un solo uso.
3. Al abrirlo, define una contraseña nueva. Se cierran todas sus sesiones, queda iniciada la sesión en el dispositivo actual y recibe un correo de confirmación del cambio. Si la cuenta estaba Sin confirmar, queda Activa: abrir el enlace prueba que el correo es suyo.

**Perfil**
1. El usuario edita su nombre, su zona horaria y su idioma. El idioma tiene en la V1 una sola opción: "Español (Bolivia)".
2. Para cambiar la contraseña, ingresa la actual y la nueva. Al guardar, se cierran sus demás sesiones y recibe un correo de aviso.
3. El correo se muestra pero no se edita. Junto a él se explica cómo cambiarlo: exportar los datos, eliminar la cuenta y registrarse de nuevo.
4. "Cerrar sesión" cierra el dispositivo actual. "Cerrar sesión en todos los dispositivos" cierra todos.

**Exportar mis datos**
1. El usuario toca "Exportar mis datos".
2. Descarga un archivo comprimido, generado en el momento, con un archivo CSV por tipo de dato: perfil y ajustes, monedas e historial de tasas manuales, cuentas, categorías, movimientos, apartados y retiros, presupuestos y sus períodos, metas, deudas y pagos, recurrentes y pendientes, atajos y avisos. Incluye los elementos archivados. No incluye CSV de módulos de entregas no liberadas. Si tarda, se muestra el progreso.

**Eliminar mi cuenta**
1. El usuario toca "Eliminar cuenta". Una pantalla explica qué se borra y ofrece exportar antes.
2. Para confirmar, ingresa su contraseña y escribe la palabra ELIMINAR.
3. Todos sus datos se borran al instante, se cierran todas sus sesiones y recibe un correo de confirmación. No se puede deshacer.

#### 2.1.2 Ciclo de vida y estados

**Cuenta de usuario**

| Desde | Hacia | Disparador |
|---|---|---|
| — | Sin confirmar | Registro |
| Sin confirmar | Sin confirmar | Nuevo registro con el mismo correo: reemplaza nombre y contraseña, y envía un enlace nuevo |
| Sin confirmar | Activa | Abre un enlace de confirmación vigente, o recupera su contraseña |
| Sin confirmar | Descartada | Pasan 7 días desde el último registro sin confirmar. El correo queda libre |
| Activa | Eliminada | Eliminación confirmada |

- Prohibido: cualquier transición desde Descartada o Eliminada. Una cuenta Sin confirmar no tiene sesión ni accede a ningún dato.

**Sesión**

| Desde | Hacia | Disparador |
|---|---|---|
| — | Activa | Inicio de sesión con el correo confirmado, confirmación o recuperación |
| Activa | Activa (renovada) | Cada acción del usuario renueva el plazo de 30 días. Las peticiones en segundo plano no lo renuevan |
| Activa | Vencida | 30 días sin acciones del usuario |
| Activa | Cerrada | Cerrar sesión en ese dispositivo |
| Activa | Revocada | Cerrar sesión en todos, cambio de contraseña (salvo el dispositivo actual) o eliminación de la cuenta |

**Enlace de confirmación o recuperación:** Vigente → Usado | Vencido | Invalidado (al pedir uno nuevo).

#### 2.1.3 Requerimientos funcionales
- **RF-M1-01:** El sistema DEBE exigir nombre (1-60 caracteres), correo con formato válido, contraseña de 8 a 128 caracteres y la aceptación de los términos.
- **RF-M1-02:** El sistema DEBE tratar el correo sin espacios al inicio ni al final y sin distinguir mayúsculas.
- **RF-M1-03:** El sistema DEBE responder con el mismo mensaje neutro al registrarse o pedir la recuperación, exista o no el correo.
- **RF-M1-04:** El sistema DEBE impedir todo acceso a los datos hasta que el correo esté confirmado. Registrarse o iniciar sesión sin haber confirmado NO abre sesión.
- **RF-M1-05:** El sistema DEBE permitir reenviar la confirmación una vez cada 60 segundos y como máximo 5 veces por hora. Cada reenvío invalida el enlace anterior.
- **RF-M1-06:** El sistema DEBE descartar los registros sin confirmar a los 7 días del último registro con ese correo. Un nuevo registro reinicia el plazo.
- **RF-M1-07:** El sistema DEBE mantener la sesión durante 30 días desde la última acción del usuario (las peticiones en segundo plano no cuentan) y permitir sesiones simultáneas en varios dispositivos.
- **RF-M1-08:** El sistema DEBE contar los intentos fallidos por correo, exista o no una cuenta con ese correo. Tras 5 fallos seguidos exige 1 minuto de espera; tras 10, 15 minutos, y desde ahí cada nuevo fallo vuelve a exigir 15 minutos. El contador se reinicia con un inicio de sesión exitoso o tras 1 hora sin intentos. Debe mostrar el tiempo restante. No envía ningún correo por los intentos fallidos. El sistema NUNCA bloquea la cuenta de forma permanente.
- **RF-M1-09:** El enlace de recuperación DEBE vencer en 1 hora y servir una sola vez. Pedir uno nuevo invalida el anterior.
- **RF-M1-10:** Al cambiar o recuperar la contraseña, el sistema DEBE revocar todas las demás sesiones y enviar un correo de confirmación.
- **RF-M1-11:** El sistema DEBE detectar la zona horaria del dispositivo al registrarse (Bolivia, si no puede detectarla) y permitir cambiarla en el perfil.
- **RF-M1-12:** Cambiar la zona horaria NO DEBE alterar la fecha de los movimientos ya registrados.
- **RF-M1-13:** El sistema NO DEBE permitir cambiar el correo de la cuenta.
- **RF-M1-14:** La exportación DEBE incluir todos los datos del usuario, archivados incluidos, y generarse en el momento, sin pasar por el correo. Los CSV DEBEN estar en UTF-8, con coma como separador y números con punto decimal y sin separador de miles (1234.56). Toda celda que empiece con `=`, `+`, `-` o `@` DEBE neutralizarse para que no se ejecute como fórmula.
- **RF-M1-15:** La eliminación de la cuenta DEBE exigir la contraseña y la palabra ELIMINAR. Debe borrar todos los datos del usuario de inmediato, revocar todas las sesiones y enviar un correo de confirmación. Si hay un proceso automático del usuario en curso (recurrente, cierre de período), se cancela y nada se crea después de la eliminación.
- **RF-M1-16:** Los únicos correos que envía el sistema son: confirmación, intento de registro con un correo existente, recuperación, cambio de contraseña y eliminación de la cuenta.
- **RF-M1-17:** El aviso de intento de registro con un correo existente DEBE enviarse como máximo una vez por hora por cuenta.
- **RF-M1-18:** El enlace de confirmación DEBE servir solo para confirmar la cuenta: no abre sesión ni lleva al Onboarding. La app donde el usuario se registró, mientras siga abierta en "Revisa tu correo" (en la misma pestaña, en otra del navegador o tras recuperar el foco), DEBE detectar la confirmación, abrir la sesión y continuar sola al Onboarding, aunque el enlace se haya abierto en otro dispositivo u otro navegador. Si ya no hay una app esperando, la página del enlace DEBE indicar que la cuenta quedó confirmada y ofrecer iniciar sesión.

#### 2.1.4 Casos borde y excepciones
- **EC-M1-01:** Se abre un enlace de confirmación vencido o invalidado. El sistema muestra "Este enlace ya no es válido" y ofrece reenviar.
- **EC-M1-02:** Se abre un enlace de confirmación ya usado con la cuenta activa. El sistema lleva al inicio de sesión.
- **EC-M1-03:** Alguien se registra con un correo cuyo registro sin confirmar fue descartado. Se trata como un registro nuevo.
- **EC-M1-04:** Se intenta iniciar sesión durante el tiempo de espera, aunque sea con la contraseña correcta. Se rechaza y se muestra el tiempo restante.
- **EC-M1-05:** Se cambia la contraseña en el dispositivo A mientras B está abierto. B pierde la sesión en su siguiente acción y ve el inicio de sesión.
- **EC-M1-06:** Se elimina la cuenta en A mientras B está abierto. B pierde la sesión en su siguiente acción.
- **EC-M1-07:** El servicio de correo falla. El registro o la recuperación muestran el mismo mensaje neutro, y el usuario puede reenviar respetando los límites.
- **EC-M1-08:** La contraseña de la eliminación es incorrecta, o la palabra no es exactamente ELIMINAR. No se elimina nada y se explica el motivo.
- **EC-M1-09:** Alguien se registra con un correo que tiene un registro Sin confirmar (aún no descartado). Se reemplazan el nombre y la contraseña, se invalida el enlace anterior, se envía uno nuevo y el plazo de 7 días vuelve a empezar.
- **EC-M1-10:** Se recupera la contraseña de una cuenta Sin confirmar. Al definir la contraseña nueva, la cuenta queda Activa.
- **EC-M1-11:** Se confirma el correo de A mientras la app que lo espera está en un navegador con la sesión de B abierta. Se cierra la sesión de B, su borrador se descarta y se inicia la de A.
- **EC-M1-12:** Hay intentos fallidos con un correo sin cuenta. Se aplica la misma espera que a uno con cuenta, para no revelar si existe.
- **EC-M1-13:** El usuario cierra la app donde se registró antes de confirmar. Al abrir el enlace, nada continúa solo: la página del enlace dice que la cuenta quedó confirmada y el usuario inicia sesión con su correo y su contraseña.
- **EC-M1-14:** Una cuenta Sin confirmar recupera su contraseña (EC-M1-10), o alguien se registra de nuevo con su correo (EC-M1-09). La app que esperaba desde el registro anterior deja de continuar sola: solo el enlace de ese mismo registro puede abrirle la sesión.

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
  Y no se abre ninguna sesión
  Y no ve ningún dato financiero

Escenario: Espera progresiva tras intentos fallidos
  Dado que hubo 5 intentos fallidos seguidos para "ana@mail.com"
  Cuando se intenta de nuevo antes de 1 minuto
  Entonces el intento se rechaza mostrando el tiempo restante
  Y no se envía ningún correo de aviso

Escenario: La pestaña de registro continúa sola al confirmar el correo
  Dado que Ana se registró y espera en "Revisa tu correo"
  Cuando abre el enlace de confirmación desde su correo, en otra pestaña o en otro dispositivo
  Entonces la página del enlace solo le dice que la cuenta quedó confirmada
  Y la pestaña donde se registró continúa sola al Onboarding con la sesión iniciada

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
4. Las secciones sin módulos liberados se ocultan (en la V1.0, PLANIFICAR no aparece).

**Escritorio (1024 px o más)**
1. Una barra lateral muestra todos los módulos y no existe "Más".
2. El orden es: Inicio, Movimientos, Registrar, Cuentas, y luego las secciones PLANIFICAR, ORGANIZAR y CUENTA.
3. La barra lateral se puede contraer a solo íconos. Con el puntero encima o con el foco del teclado se ve el nombre.

**Cabecera (todos los tamaños)**
- En las pantallas internas (las que no son la raíz de una pestaña), un botón "Volver" antes del título.
- El logo de la app, antes del título.
- El título de la pantalla.
- Una ficha con el dólar en Bs de la referencia en uso (por ejemplo "$ 10,25"), con un distintivo si es el valor manual, o "$ —" si no hay ninguna tasa. Lleva al panel de Tipo de cambio.
- Desde la V1.1, la campana con el número de avisos sin leer.

#### 2.2.2 Ciclo de vida y estados

| Estado de la app | Qué ve el usuario | Sale cuando |
|---|---|---|
| Normal | La app completa | — |
| Sin conexión | Una pantalla de bloqueo "Sin conexión" tapa toda la app, incluido Registrar. Los borradores de todos los formularios se conservan debajo | Vuelve la conexión: el bloqueo desaparece solo y los datos se actualizan |
| Sesión vencida | "Tu sesión venció, vuelve a entrar" con el inicio de sesión | Inicia sesión: vuelve a la misma pantalla con sus borradores |

#### 2.2.3 Requerimientos funcionales
- **RF-M2-01:** Por debajo de 1024 px, el sistema DEBE usar la barra inferior de 5 pestañas con Registrar en el centro. Desde 1024 px, la barra lateral con todos los módulos.
- **RF-M2-02:** "Más" DEBE existir solo en el formato de barra inferior.
- **RF-M2-03:** El sistema DEBE mostrar únicamente los módulos de las entregas liberadas.
- **RF-M2-04:** Cada pestaña DEBE recordar su estado (mes, filtros, posición, detalle abierto) al cambiar de pestaña. Ese estado vive en el dispositivo mientras la app esté abierta y no se sincroniza entre dispositivos.
- **RF-M2-05:** Tocar la pestaña activa DEBE llevar al inicio de esa pestaña. En Registrar no borra el borrador.
- **RF-M2-06:** El botón Atrás del navegador o del celular DEBE funcionar en todas las pantallas.
- **RF-M2-07:** Sin conexión, el sistema DEBE bloquear toda la app, incluido Registrar, con una pantalla de aviso y liberarla sola al reconectar, actualizando los datos. Es una excepción aceptada al principio rector: no existe modo sin conexión.
- **RF-M2-08:** Con la sesión vencida, el sistema DEBE pedir que el usuario inicie sesión y, tras hacerlo, volver a la misma pantalla con los borradores intactos.
- **RF-M2-09:** El estado contraído de la barra lateral DEBE guardarse en la cuenta del usuario (M9).
- **RF-M2-10:** Todo formulario con datos sin guardar DEBE conservarlos como borrador en el mismo dispositivo al cambiar de pestaña, al vencer la sesión o al quedar bloqueado sin conexión. El borrador se descarta con "Limpiar" o "Cancelar", al cerrar la app o la sesión, o si entra otro usuario.
- **RF-M2-11:** Al restaurar un borrador, o al aplicar un atajo, cuya cuenta o categoría ya no está activa, ese campo DEBE vaciarse y marcarse para elegir otra.
- **RF-M2-12:** Las secciones de "Más" y de la barra lateral sin módulos liberados DEBEN ocultarse.
- **RF-M2-13:** Toda pantalla que no sea la raíz de una pestaña DEBE mostrar en la cabecera un botón "Volver", antes del título. Lleva a la pantalla anterior de la app; si el usuario llegó directo por un enlace, a la pantalla de la que cuelga. En el formato de barra inferior, las pantallas de "Más" (Presupuestos, Metas, Deudas, Recurrentes, Categorías, Tipo de cambio, Perfil y Ajustes) cuelgan de "Más" y también lo llevan; en la barra lateral son raíces y no lo llevan. Volver NO descarta los borradores (RF-M2-10).
- **RF-M2-14:** La app DEBE mostrar su logo como ícono de la pestaña del navegador, en las pantallas de acceso y registro, y en la cabecera de cada pantalla, antes del título. El diseño y la disposición exacta se registran en `docs/design-direction.md` al incorporar el logo.

#### 2.2.4 Casos borde y excepciones
- **EC-M2-01:** Otra persona inicia sesión tras el vencimiento de la sesión en el mismo dispositivo. El borrador del usuario anterior se descarta.
- **EC-M2-02:** La conexión se pierde a mitad de un guardado. Aparece el bloqueo. Al reconectar, el usuario ve si el movimiento se guardó o no, y nunca se guarda dos veces (RN-10).
- **EC-M2-03:** El ancho de la pantalla cambia al girar la tablet. La navegación cambia de formato sin perder el estado.
- **EC-M2-04:** Se abre una pantalla interna desde un enlace directo, sin pantallas previas en la app. "Volver" lleva a la pantalla de la que cuelga y no saca al usuario de la app.

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

Escenario: Volver desde una pantalla interna
  Dado un usuario en el detalle de una cuenta, a la que llegó desde la lista de Cuentas
  Cuando toca "Volver" en la cabecera
  Entonces regresa a la lista de Cuentas
  Y la lista conserva su posición

Escenario: El logo acompaña a la app
  Dado un usuario con la app abierta
  Entonces la pestaña del navegador muestra el logo de la app
  Y la cabecera de cada pantalla muestra el logo antes del título
```

---

### 2.3 M3 — Monedas y tipo de cambio (V1.0)

#### 2.3.1 Flujos de usuario
**Elegir la referencia del dólar**
1. En el panel de Tipo de cambio (o en Ajustes), el usuario elige la referencia: paralelo (compra, venta o mediana), oficial (TCO) o valor manual.
2. Al guardar, los saldos y totales actuales se recalculan. Los movimientos registrados no cambian.

**Cargar un valor manual**
1. El usuario escribe un valor (por ejemplo, Bs 10,10 por dólar) y lo activa.
2. Ese valor tiene prioridad sobre cualquier referencia automática hasta que el usuario lo desactive.
3. Mientras está activo, el panel de Tipo de cambio muestra un aviso fijo: "Usando tu valor manual (Bs 10,10) desde hace N días", y la ficha del dólar de la cabecera lleva un distintivo.

**Agregar una moneda**
1. El usuario agrega una moneda con su código de 3 letras, su símbolo y su valor en bolivianos (por ejemplo, 1 EUR = Bs 11,20).
2. Esa tasa es siempre manual y el usuario la actualiza cuando quiera. Cada cambio queda en el historial de tasas.

**Cambiar la moneda base**
1. El usuario elige cualquier moneda activa como base.
2. Los totales y la historia se reexpresan con las tasas guardadas en cada movimiento y, para una moneda que el movimiento no guardó, con el historial de tasas en su fecha. Nunca con las de hoy.

**Consultar el panel**
1. El usuario abre Tipo de cambio desde la cabecera o el menú.
2. Ve:
   - la tasa actual de cada referencia y cuál está en uso;
   - la brecha entre el paralelo y el oficial, en % y en Bs (RF-M3-12);
   - "actualizado hace X" con su fuente (paralelo.bo, BCB);
   - un gráfico de evolución con un punto por día, en rangos de 7 días, 30 días, 90 días y 1 año.

#### 2.3.2 Ciclo de vida y estados

**Moneda activa**

| Desde | Hacia | Condición |
|---|---|---|
| — | Activa | BOB y USD lo están siempre. Las demás, al agregarlas con su tasa manual |
| Activa | Inactiva | Solo monedas agregadas, que no sean la base y que nada activo use: cuentas activas, metas no archivadas, presupuestos activos o pausados, deudas activas o vencidas, ni reglas recurrentes no eliminadas. Las cuentas archivadas no lo impiden. Su historia se conserva |
| Inactiva | Activa | Reactivación con una tasa manual vigente |

- Prohibido: desactivar BOB o USD, desactivar la moneda base, o desactivar una moneda en uso por algo activo.

**Valor manual del dólar:** Inactivo ↔ Activo. Solo cambia por acción del usuario. Nunca vence solo.

#### 2.3.3 Requerimientos funcionales
- **RF-M3-01:** BOB y USD DEBEN estar siempre activas. Toda moneda usa 2 decimales, y las tasas de cambio también se guardan con 2 decimales.
- **RF-M3-02:** El código de una moneda DEBE tener 3 letras y ser único para el usuario. Las monedas agregadas DEBEN tener una tasa manual en bolivianos, de Bs 0,01 como mínimo: no se admiten monedas que valgan menos.
- **RF-M3-03:** La referencia por defecto DEBE ser la mediana del paralelo, tal como la publica paralelo.bo. El valor manual activo tiene prioridad sobre cualquier referencia, también en las precargas de transferencias y pagos de deuda.
- **RF-M3-04:** El sistema DEBE actualizar las tasas automáticas:
  - al abrir la app, si el valor guardado tiene más de 1 minuto;
  - el paralelo, cada hora en segundo plano;
  - el oficial, una vez al día en segundo plano.

  Las tasas automáticas son las mismas para todos los usuarios. El valor manual y las tasas de las monedas agregadas son de cada usuario.

- **RF-M3-05:** El sistema DEBE mostrar junto a toda tasa "actualizado hace X" y su fuente. NO muestra avisos de desactualización.
- **RF-M3-06:** Todo movimiento, esté o no en la moneda base, DEBE guardar al guardarse la tasa de su moneda frente al boliviano y la tasa boliviano-dólar. Si la fecha es hoy, guarda las vigentes en ese momento, con la referencia en uso (el valor manual, si está activo). Si es pasada, guarda las del historial en esa fecha, con la referencia y el valor manual que el usuario tenía en uso ese día (RF-M3-13). La tasa guardada nunca se actualiza sola: solo el usuario puede editarla a mano (RF-M3-10).
- **RF-M3-07:** En una transferencia entre monedas distintas, el sistema DEBE precargar el campo "Tipo de cambio usado":
  - con el valor manual del dólar, si está activo;
  - si no, con el paralelo según la dirección: venta si el usuario compra dólares, compra si los vende;
  - si no interviene el dólar, con la tasa manual de la moneda agregada o, entre dos monedas agregadas, con la tasa cruzada a través de BOB.

  Para una fecha pasada se precargan los valores de ese día: el valor manual si estaba activo, o el paralelo de ese día (RF-M3-06, RF-M3-13).

- **RF-M3-08:** En esa transferencia, el sistema DEBE calcular el monto que llega a partir del monto que sale y la tasa. Si el usuario edita el monto que llega, la tasa se recalcula. Ese monto manda y se guarda tal cual; como la tasa tiene 2 decimales, puede no reproducirlo exactamente (diferencia máxima de 0,01).
- **RF-M3-09:** La tasa declarada en una transferencia DEBE ser la tasa histórica de ese movimiento.
- **RF-M3-10:** Al editar un movimiento, la tasa guardada DEBE conservarse siempre, aunque cambien su fecha o su cuenta. Solo cambia si el usuario la edita a mano desde el detalle del movimiento. En una transferencia, la tasa declarada solo cambia si el usuario la edita.
- **RF-M3-11:** Cambiar la referencia o la moneda base DEBE recalcular los saldos y totales actuales sin modificar los movimientos registrados.
- **RF-M3-12:** La brecha DEBE calcularse como (paralelo − oficial) ÷ oficial, en % y en Bs, comparando con el oficial (TCO) la referencia del paralelo en uso o el valor manual. Si la referencia en uso es el oficial, se muestra la mediana del paralelo contra el oficial.
- **RF-M3-13:** El sistema DEBE guardar un historial diario de tasas por moneda: las referencias automáticas del dólar, el valor manual, las tasas de las monedas agregadas y la referencia elegida por el usuario (cada cambio del usuario). El día de una tasa de mercado es el día calendario de Bolivia. La tasa de un día es la última vigente ese día. Para un día sin compra o venta del paralelo se usa la mediana de ese día. Para un día sin dato se usa la del día anterior más cercano y, antes del primer dato, el primer valor conocido.

#### 2.3.4 Casos borde y excepciones
- **EC-M3-01:** La fuente no responde. Se usa el último valor guardado y la app sigue funcionando.
- **EC-M3-02:** La fuente no responde y no hay ningún valor guardado (usuario nuevo).
  - Los movimientos en bolivianos se registran sin restricción.
  - Al guardar un movimiento en otra moneda, se pregunta "No pudimos obtener el dólar. ¿A cuánto lo tomamos?". El valor ingresado queda como tasa de ese movimiento y como valor manual activo.
  - Mientras no exista ninguna tasa, no se muestran equivalentes en la otra moneda.
- **EC-M3-03:** Se registra un movimiento con fecha de un día sin registro de tasas. Se usa la del día anterior más cercano y, si es anterior al primer dato, el primer valor conocido (RF-M3-13).
- **EC-M3-04:** La fuente devuelve un valor inválido (cero, negativo o vacío). Se descarta y se conserva el último valor válido. Cualquier valor positivo se acepta, aunque sea un salto grande.
- **EC-M3-05:** El usuario intenta desactivar una moneda en uso. Se rechaza y se indica qué la usa (cuentas, metas, presupuestos, deudas o reglas).
- **EC-M3-07:** Se agrega una moneda con una tasa menor a Bs 0,01 (por ejemplo, el peso argentino o el chileno). Se rechaza explicando que no se admiten monedas de valor tan bajo.
- **EC-M3-06:** Con el valor manual activo, se transfiere de una cuenta en Bs a una en $. Se precarga el valor manual, no el paralelo.

#### 2.3.5 Criterios de aceptación
```gherkin
Escenario: La historia no se reescribe al cambiar la base
  Dado un gasto de $ 10,00 registrado el 1/10 con el dólar a Bs 10,00
  Y la moneda base es BOB
  Cuando el dólar sube a Bs 11,00 y el usuario cambia la base a USD y luego vuelve a BOB
  Entonces ese gasto sigue valiendo Bs 100,00 en la historia

Escenario: Tasa precargada según la dirección
  Dado que el paralelo está en compra 10,10 y venta 10,30
  Cuando el usuario transfiere Bs 1.000,00 de una cuenta en Bs a una en $
  Entonces el campo "Tipo de cambio usado" muestra 10,30
  Y el monto que llega es $ 97,09

Escenario: Valor manual con prioridad
  Dado que el usuario activó un valor manual de Bs 10,00
  Cuando el paralelo cambia a Bs 10,40
  Entonces los totales siguen convirtiéndose con Bs 10,00
  Y el panel de Tipo de cambio muestra "Usando tu valor manual (Bs 10,00) desde hace N días"

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
3. En una tarjeta, puede agregar el día de corte, el día de pago y el límite de crédito. El saldo inicial se ingresa como deuda actual o como saldo a favor.

**Ajustar el saldo**
1. Desde el detalle de la cuenta, el usuario toca "Ajustar saldo" y escribe su saldo real.
2. El sistema crea un movimiento de tipo Ajuste por la diferencia, con una nota opcional. Si el saldo real coincide, no crea nada e informa "El saldo ya coincide". En una tarjeta, el usuario escribe su deuda real.

**Pagar la tarjeta:** el usuario registra una transferencia desde el banco hacia la tarjeta.

**Archivar o restaurar**
1. El usuario archiva una cuenta. Si su saldo no es cero, el sistema pide confirmación y sugiere transferir el saldo antes.
2. Desde la lista de archivadas, la restaura.

**Consultar**
- La lista muestra el total neto y su desglose, con las cuentas agrupadas por tipo en el orden del usuario.
- El detalle muestra:
  - el saldo y su equivalente en la otra moneda;
  - un gráfico del saldo día a día y los movimientos agrupados por día, los dos con el mismo filtro de fechas (por defecto, el mes actual);
  - en una tarjeta, además, el límite, el crédito disponible y los días de corte y de pago;
  - en una cuenta con apartados, el saldo apartado y el saldo libre.

#### 2.4.2 Ciclo de vida y estados

| Desde | Hacia | Condición |
|---|---|---|
| — | Activa | Creación |
| Activa | Archivada | Confirmación (con aviso si el saldo no es cero). Prohibido si tiene apartados de metas o está dedicada a una meta |
| Archivada | Activa | Restauración. Si su nombre ya está en uso entre las activas, se pide renombrarla. Si su moneda está inactiva, se pide reactivarla |
| Activa | Eliminada | Solo si no tiene ningún movimiento (el saldo inicial no cuenta como movimiento) y no está dedicada a una meta |

- Prohibido: eliminar una cuenta con movimientos, y archivar una cuenta con apartados o dedicada.

#### 2.4.3 Requerimientos funcionales
- **RF-M4-01:** El nombre DEBE tener de 1 a 40 caracteres y ser único entre las cuentas activas, sin distinguir mayúsculas.
- **RF-M4-02:** El saldo inicial DEBE cumplir según el tipo:
  - efectivo y billetera, mayor o igual a 0;
  - tarjeta, se ingresa como deuda actual (se registra como saldo negativo) o como saldo a favor (se registra como saldo positivo);
  - banco, ahorro y otro, cualquier valor.

  Por defecto es 0. En valor absoluto llega hasta 999.999.999,99, con 2 decimales como máximo.
- **RF-M4-03:** El saldo DEBE calcularse según RN-01. Un movimiento con fecha anterior a la del saldo inicial se permite, aparece en la historia con el aviso "anterior al saldo inicial" y no altera el saldo, pero sí cuenta como ingreso o gasto (RN-12).
- **RF-M4-04:** En efectivo y billetera, el sistema DEBE rechazar toda acción que deje el saldo actual en negativo, y explicar cuál sería el saldo resultante. Incluye gastos, transferencias salientes (monto y comisión juntos), ediciones, eliminaciones de ingresos, deshacer y ajustes. Los saldos de días pasados no se validan.
- **RF-M4-05:** Un ajuste NO cuenta como ingreso ni como gasto. Se puede editar y eliminar. Si la diferencia es 0, no se crea. En una cuenta dedicada a una meta, el ajuste cambia el progreso y queda en la historia de la meta con el origen "ajuste".
- **RF-M4-06:** La moneda de una cuenta solo DEBE poder cambiarse si no tiene movimientos.
- **RF-M4-07:** El saldo inicial y su fecha NO DEBEN editarse después de crear la cuenta: cualquier diferencia se corrige con "Ajustar saldo". El nombre, el color y el ícono se editan siempre. El tipo se puede cambiar si el saldo inicial cumple RF-M4-02 para el nuevo tipo, si el saldo actual no queda negativo en efectivo o billetera (RF-M4-04) y si no se convierte en tarjeta una cuenta dedicada o con apartados. Al dejar de ser tarjeta, se borran el día de corte, el día de pago y el límite.
- **RF-M4-08:** En una tarjeta:
  - el saldo DEBE mostrarse como "Debes X" o "A favor X";
  - con límite, se muestra el crédito disponible (límite − deuda), y al superarlo aparece un aviso sin bloquear;
  - el día de corte y el día de pago son opcionales. Si un mes no tiene ese día, cae el último día del mes. En la V1.0 solo se guardan y se muestran en el detalle; desde la V1.1 aparecen en "Próximos pagos" del Inicio y desde la V1.2 generan avisos (M15);
  - una tarjeta no puede dedicarse a una meta ni tener apartados (M12).
- **RF-M4-09:** Una cuenta archivada NO DEBE aparecer en los selectores ni sumar en los saldos y totales actuales, y DEBE conservar su historia. Sus movimientos siguen contando en los ingresos y gastos de su mes (RN-11).
- **RF-M4-10:** El total neto DEBE ser la suma de las cuentas activas (la deuda de tarjetas resta), en moneda base y su equivalente en la otra moneda, con la referencia vigente. El desglose incluye:
  - Líquido (efectivo, banco, billetera, otro);
  - Ahorro;
  - Deuda en tarjetas: la suma de los saldos de todas las tarjetas (un saldo a favor reduce la deuda);
  - Apartado para metas (V1.1): los apartados más el saldo positivo de las cuentas dedicadas. No altera el total.
- **RF-M4-11:** Las cuentas DEBEN poder reordenarse. La lista agrupa por tipo y respeta ese orden.
- **RF-M4-12:** Si se archiva la cuenta por defecto o la última usada en Registrar, Registrar DEBE pasar a la cuenta que indica RF-M7-03.
- **RF-M4-13:** Al eliminar una cuenta sin movimientos, el sistema DEBE quitarla como cuenta por defecto y eliminar sus atajos. Si una regla recurrente usa la cuenta, se rechaza la eliminación y se sugiere archivarla (al archivarla, sus reglas se pausan con un aviso, EC-M14-02).

#### 2.4.4 Casos borde y excepciones
- **EC-M4-01:** Se elimina un ingreso del efectivo y el saldo quedaría en −50. Se rechaza: "El efectivo quedaría en Bs −50,00".
- **EC-M4-02:** El usuario quiere corregir el saldo inicial de una cuenta. No es editable; se ofrece "Ajustar saldo".
- **EC-M4-03:** Un recurrente automático dejaría el efectivo en negativo. No se registra y pasa a pendiente (M14).
- **EC-M4-04:** Se restaura una cuenta cuyo nombre está en uso. Se pide un nombre nuevo antes de restaurarla.
- **EC-M4-05:** La única cuenta activa se archiva. Registrar y el Inicio invitan a crear una cuenta.
- **EC-M4-06:** Un banco queda con saldo negativo. Se permite (sobregiro).
- **EC-M4-07:** Se restaura una cuenta cuya moneda está inactiva. Se pide reactivar la moneda primero.
- **EC-M4-08:** Se ajusta el saldo al mismo valor que ya tiene. No se crea ningún ajuste y se informa "El saldo ya coincide".

#### 2.4.5 Criterios de aceptación
```gherkin
Escenario: Movimiento anterior al saldo inicial no altera el saldo
  Dado una cuenta Efectivo creada el 10/10 con saldo inicial Bs 500,00
  Cuando el usuario registra un gasto de Bs 50,00 con fecha 5/10
  Entonces el saldo sigue siendo Bs 500,00
  Y el gasto aparece en la historia con el aviso "anterior al saldo inicial"

Escenario: Bloqueo de negativo en efectivo
  Dado una cuenta Efectivo con saldo Bs 30,00
  Cuando el usuario intenta registrar un gasto de Bs 35,00
  Entonces el gasto no se guarda
  Y ve "El efectivo quedaría en Bs −5,00"

Escenario: Ajuste de saldo
  Dado una cuenta Banco con saldo Bs 1.200,00
  Cuando el usuario indica que su saldo real es Bs 1.250,00
  Entonces se crea un Ajuste de Bs +50,00
  Y los ingresos del mes no cambian

Escenario: Pago de tarjeta no es gasto
  Dado una tarjeta con deuda de Bs 1.000,00
  Cuando el usuario transfiere Bs 1.000,00 del Banco a la tarjeta
  Entonces la tarjeta muestra "Debes Bs 0,00"
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
| Archivada | Activa | Restauración. Si es padre, el usuario elige qué subcategorías vuelven. Si es una subcategoría con el padre archivado, hay que restaurar el padre o moverla a otro padre activo |
| Activa | Eliminada | Solo sin movimientos y sin presupuesto ni regla recurrente que la use (si no, se pide archivarla); sus atajos se borran con ella. También como origen de una fusión |

- Prohibido: eliminar una categoría con movimientos; cambiar su tipo; convertir en subcategoría una categoría que tiene subcategorías; mover una subcategoría a un padre archivado; renombrar, archivar, eliminar o fusionar (como origen o como destino) la categoría del sistema.

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
  - solo entre categorías del mismo tipo, con A sin subcategorías y B activa. A y B pueden estar en niveles distintos;
  - ninguna de las dos puede ser la categoría del sistema;
  - si A tiene un cierre de presupuesto pendiente, hay que decidirlo antes de fusionar;
  - mueve a B los movimientos, recurrentes y atajos de A;
  - el presupuesto de A pasa a B si B no tenía; si ambas tenían, se conserva el de B y se elimina el de A, con aviso;
  - A queda eliminada y la fusión no se puede deshacer.
- **RF-M5-09:** Fusionar categorías o mover una subcategoría a otro padre DEBE cambiar el gasto por categoría de los meses pasados en el Inicio y en la lista (RN-11). Los períodos cerrados de los presupuestos no cambian.

#### 2.5.4 Casos borde y excepciones
- **EC-M5-01:** Se crea "comida" existiendo "Comida" en gastos. Se rechaza por duplicado.
- **EC-M5-02:** Se intenta fusionar una categoría con subcategorías. Se pide fusionar o mover primero las subcategorías.
- **EC-M5-03:** Se mueve una subcategoría con presupuesto a otro padre. El gasto del presupuesto del padre anterior deja de incluirla desde ese momento, y la historia de sus períodos cerrados no cambia.
- **EC-M5-04:** Al restaurar una categoría, su nombre ya está en uso en el mismo nivel. Se pide renombrarla.
- **EC-M5-05:** Se convierte una subcategoría en principal y ya existe una principal con ese nombre. Se pide renombrarla antes.
- **EC-M5-06:** Se restaura una subcategoría cuyo padre está archivado. Se pide restaurar el padre o elegir otro padre activo.
- **EC-M5-07:** Se intenta eliminar una categoría sin movimientos que usa un presupuesto o una regla recurrente. Se rechaza y se sugiere archivarla.

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
  - La comisión crea un gasto vinculado en la cuenta de origen, con la categoría "Servicios › Comisiones bancarias". Si esa categoría no existe o está archivada, se pide elegir otra categoría de gasto.

**Revisar**
1. La lista abre en el mes actual, con selector de mes. Agrupa por día con el neto de cada día y muestra arriba los totales del filtro activo.
2. Filtros: fecha o rango, cuenta, categoría (incluye sus subcategorías) y tipo.
3. Búsqueda por nota, sin distinguir mayúsculas ni tildes, o por monto exacto en su moneda original, con coma o punto como decimal ("35" encuentra 35,00 pero no 135).
4. Al bajar se cargan más movimientos.

**Editar:** desde el detalle, el usuario cambia el monto, la cuenta, la categoría, la fecha, la nota o la tasa, según las reglas de abajo.

**Eliminar:** el movimiento se elimina al instante (queda guardado en el servidor) y aparece "Deshacer" durante 10 segundos, que lo restaura.

**Acciones en lote**
1. Con una pulsación larga (o casillas en escritorio), el usuario selecciona varios de los movimientos ya cargados. No existe "seleccionar todo".
2. Puede eliminarlos, o recategorizarlos si son todos gastos o todos ingresos. Un solo "Deshacer" revierte cualquiera de las dos acciones.

#### 2.6.2 Ciclo de vida y estados

| Desde | Hacia | Disparador |
|---|---|---|
| — | Registrado | Guardado manual, o recurrente automático (M14) |
| — | Pendiente | Recurrente en modo confirmación, o automático bloqueado (M14) |
| Pendiente | Registrado | El usuario confirma (puede ajustar el monto, la fecha y la tasa; si su cuenta o categoría está archivada, elige otra) |
| Pendiente | Omitido | El usuario omite, o pasan 30 días sin decisión |
| Registrado | Eliminado (deshacible) | Eliminación |
| Eliminado (deshacible) | Registrado | "Deshacer" dentro de los 10 segundos |
| Eliminado (deshacible) | Eliminado definitivo | Pasan 10 segundos o el usuario cambia de pantalla |

- Estados finales: Omitido y Eliminado definitivo.
- El "Deshacer" que aparece al guardar en Registrar elimina el movimiento recién creado, con las mismas validaciones que una eliminación (RF-M7-07).
- Sin conexión no se ofrece "Deshacer": la app está bloqueada (M2).
- Prohibido: cambiar el tipo de un movimiento, y deshacer después de los 10 segundos.

#### 2.6.3 Requerimientos funcionales
- **RF-M6-01:** El monto DEBE estar entre 0,01 y 999.999.999,99, con 2 decimales como máximo.
- **RF-M6-02:** La fecha DEBE ser hoy o anterior (RN-07), sin hora y sin fecha mínima. Dentro de un día, la lista ordena por momento de registro, del más reciente al más antiguo.
- **RF-M6-03:** La nota DEBE ser opcional y de hasta 140 caracteres.
- **RF-M6-04:** El origen y el destino de una transferencia DEBEN ser cuentas activas y distintas.
- **RF-M6-05:** La comisión de una transferencia DEBE crear un gasto vinculado en la cuenta de origen. Se edita desde la transferencia y se elimina con ella: acompaña la fecha y la cuenta de origen de la transferencia, y su monto no se edita en V1 (para cambiarlo, se elimina la transferencia y se vuelve a crear). Si su categoría no existe o está archivada, se pide elegir otra. El monto y la comisión se validan juntos contra el bloqueo de negativos (M4). La comisión puede ser mayor que el monto.
- **RF-M6-06:** El tipo de un movimiento NO DEBE cambiar.
- **RF-M6-07:** La cuenta PUEDE cambiarse:
  - a otra de la misma moneda, libremente;
  - a otra de distinta moneda: el monto en la nueva moneda se precarga convertido con la tasa guardada (o, si el movimiento no guardó la tasa de esa moneda, con el historial en su fecha), y el usuario lo confirma o edita la tasa a mano (RF-M3-10). Si la conversión supera el máximo de RF-M6-01, se rechaza con la explicación.
  - En una transferencia, el origen y el destino PUEDEN cambiarse, cada uno solo a otra cuenta de la misma moneda que la que reemplaza y respetando RF-M6-04. Para pasar a otra moneda, se elimina la transferencia y se vuelve a crear.
- **RF-M6-08:** Toda edición, eliminación o deshacer DEBE respetar el bloqueo de negativos (M4), la protección de apartados (M12) y las reglas de tasa (M3).
- **RF-M6-09:** En los movimientos vinculados (glosario), el monto, la cuenta y la fecha DEBEN editarse solo desde su origen, y el detalle ofrece "Ir a…". La nota y la categoría se editan desde la lista, salvo la categoría del sistema.
- **RF-M6-10:** Los movimientos creados por un recurrente DEBEN ser movimientos normales, editables y eliminables, con el distintivo "De recurrente: X", donde X es el nombre de la regla.
- **RF-M6-11:** Los pendientes NO DEBEN aparecer en la lista de movimientos ni contar en saldos o totales.
- **RF-M6-12:** El neto diario y los totales de la lista DEBEN excluir los movimientos que indica RN-02.
- **RF-M6-13:** Las acciones en lote DEBEN omitir los movimientos que violarían el bloqueo de negativos o de apartados. Al eliminar, omiten además todos los vinculados; al recategorizar, las transferencias, los ajustes y los vinculados con la categoría del sistema. Deben avisar cuántos quedaron fuera.
- **RF-M6-14:** Un doble toque o un reintento NUNCA DEBE crear dos movimientos (RN-10). No existe aviso de posible duplicado.

#### 2.6.4 Casos borde y excepciones
- **EC-M6-01:** El mismo movimiento se edita en dos dispositivos. Gana la última edición guardada.
- **EC-M6-02:** Se guarda la edición de un movimiento eliminado en otro dispositivo. Se informa "Este movimiento ya no existe" y no se guarda nada.
- **EC-M6-03:** Se intenta deshacer una eliminación cuyo resultado violaría el bloqueo de negativos. Se rechaza con la explicación.
- **EC-M6-04:** Se cambia la fecha de un gasto en dólares. Conserva su tasa guardada; el usuario puede editarla a mano (RF-M3-10).
- **EC-M6-05:** Se elimina una transferencia con comisión. Se eliminan ambas, con un único "Deshacer".
- **EC-M6-06:** El usuario cambia de pantalla durante los 10 segundos de "Deshacer". La eliminación queda definitiva.
- **EC-M6-07:** Se pasa un movimiento a una cuenta de otra moneda y el monto convertido superaría 999.999.999,99. Se rechaza con la explicación. Los saldos y totales sí pueden superar ese tope.
- **EC-M6-08:** Se carga una comisión y "Comisiones bancarias" fue eliminada en el Onboarding. Se pide elegir otra categoría de gasto.

#### 2.6.5 Criterios de aceptación
```gherkin
Escenario: Eliminar y deshacer
  Dado un gasto de Bs 35,00 en Efectivo
  Cuando el usuario lo elimina
  Entonces el saldo de Efectivo sube Bs 35,00 al instante
  Y ve "Movimiento eliminado · Deshacer" durante 10 segundos
  Cuando toca "Deshacer"
  Entonces el gasto vuelve y el saldo se restablece

Escenario: Transferencia con comisión
  Dado que el usuario transfiere Bs 500,00 del Banco a Efectivo con comisión Bs 5,00
  Entonces el Banco baja Bs 505,00 y el Efectivo sube Bs 500,00
  Y se crea un gasto de Bs 5,00 en "Comisiones bancarias"
  Y la transferencia no cuenta como ingreso ni como gasto

Escenario: Doble toque no duplica
  Dado que el usuario toca "Guardar" dos veces seguidas
  Entonces se crea un solo movimiento

Escenario: Vinculado solo se edita en su origen
  Dado un pago de deuda a Juan de Bs 200,00
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
5. Aparece "Gasto de Bs 35,00 guardado · Deshacer" durante 10 segundos. El formulario se limpia, la app se queda en Registrar lista para el siguiente, y debajo se ven los últimos 3 movimientos creados hoy, sea cual sea su fecha.

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

**Atajo:** Visible ↔ Oculto (su cuenta o categoría está archivada) → Eliminado (por el usuario, o al eliminarse su cuenta).

#### 2.7.3 Requerimientos funcionales
- **RF-M7-01:** Registrar DEBE ser una pestaña normal: centro de la barra inferior en celular, entrada de la barra lateral en escritorio.
- **RF-M7-02:** Al entrar con el formulario vacío, el tipo DEBE ser Gasto y el foco DEBE estar en el monto. Si hay un borrador, se restaura tal cual, con su tipo. El monto acepta solo números y un separador decimal: un punto o una coma seguidos de 1 o 2 dígitos al final se toman como decimal, sea cual sea el formato elegido. No acepta separador de miles ni operaciones.
- **RF-M7-03:** La cuenta preseleccionada DEBE ser la cuenta por defecto de Ajustes (una sola, para gastos e ingresos), si existe. Si no, la última usada para ese tipo que siga activa; si no hay, la primera cuenta activa según el orden del usuario. En transferencias, el último par origen-destino, si ambas siguen activas. La cuenta por defecto puede ser una cuenta dedicada a una meta (RF-M7-14).
- **RF-M7-04:** La grilla DEBE mostrar 8 categorías del tipo actual:
  - primero, las favoritas fijadas en Ajustes (como máximo 8), en su orden;
  - después, las más usadas de los últimos 60 días, mezclando padres y subcategorías. Usar una subcategoría no suma uso a su padre. Los empates se resuelven por el uso más reciente;
  - si faltan, se completa con las precargadas en su orden (un usuario nuevo ve las primeras precargadas);
  - nunca aparecen categorías archivadas.

  "Ver todas" abre la lista completa con los padres desplegables.
- **RF-M7-05:** La fecha DEBE ofrecer las fichas "Hoy" (marcada), "Ayer" y "Calendario", sin fechas futuras.
- **RF-M7-06:** "Guardar" DEBE habilitarse con monto mayor que 0 y categoría (gasto o ingreso), o con origen y destino distintos (transferencia).
- **RF-M7-07:** Al guardar, el sistema DEBE limpiar el formulario y permanecer en Registrar. Debe mostrar "Deshacer" durante 10 segundos, que elimina el movimiento recién creado con las mismas validaciones que una eliminación y sigue disponible al cambiar de pestaña hasta cumplir los 10 segundos. Debe mostrar también los últimos 3 movimientos creados hoy, sea cual sea su fecha.
- **RF-M7-08:** El borrador DEBE conservarse según RF-M2-10, también tras volver a iniciar sesión el mismo usuario.
- **RF-M7-09:** Los atajos DEBEN guardar nombre (de 1 a 30 caracteres), tipo (gasto, ingreso o transferencia), monto (opcional), cuenta (o par origen-destino en una transferencia), categoría (salvo en una transferencia) y nota. Son como máximo 12 en total, contando los ocultos, y aparecen como fichas del tipo correspondiente. Al tocarlos rellenan el formulario y no guardan directamente.
- **RF-M7-10:** Los atajos se crean con "Guardar como atajo" y se editan, reordenan y eliminan en Ajustes › Registrar.
- **RF-M7-11:** La ficha de cuenta DEBE mostrar el saldo libre de la cuenta. En una tarjeta, muestra el crédito disponible (si tiene límite) o la deuda.
- **RF-M7-12:** En escritorio, el formulario DEBE poder usarse completo con Tab y Enter. No hay atajos de teclado propios.
- **RF-M7-13:** El ajuste "Mostrar la nota siempre" DEBE poner la nota en el primer nivel.
- **RF-M7-14:** Al registrar una salida de una cuenta dedicada a una meta, DEBE mostrarse el aviso no bloqueante "Esto resta a tu meta X" (M12).

#### 2.7.4 Casos borde y excepciones
- **EC-M7-01:** No hay cuentas. Registrar muestra "Crea tu primera cuenta" con un formulario mínimo (nombre, tipo, moneda, saldo) en la misma pantalla.
- **EC-M7-02:** El gasto dejaría el efectivo en negativo. Se muestra el error en la pantalla y el formulario no se limpia.
- **EC-M7-03:** El gasto usa dinero apartado para metas. Aparece la confirmación de M12. Si se cancela, el formulario queda intacto.
- **EC-M7-04:** No hay ninguna tasa y la cuenta está en dólares. Se pide el valor en ese momento (EC-M3-02).
- **EC-M7-05:** La cuenta por defecto se archiva. El ajuste se limpia y se aplica RF-M7-03.
- **EC-M7-06:** Ya existen 12 atajos. "Guardar como atajo" informa el límite y ofrece gestionar los atajos.
- **EC-M7-07:** No hay categorías del tipo elegido (gasto o ingreso). "Ver todas" aparece vacío con la acción "Crear categoría".
- **EC-M7-08:** El borrador apunta a una cuenta archivada desde otro dispositivo. El campo de cuenta se vacía y se marca para elegir otra (RF-M2-11).

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
  Dado el atajo "Almuerzo, Bs 35, Efectivo, Restaurantes"
  Cuando el usuario lo toca
  Entonces el formulario queda completo
  Y el movimiento no se guarda hasta tocar "Guardar"

Escenario: El borrador conserva su tipo
  Dado que el usuario dejó un ingreso de "500" a medio escribir en Registrar
  Cuando va a Cuentas y vuelve a Registrar
  Entonces encuentra el ingreso de "500", no un gasto vacío

Escenario: Deshacer después de guardar
  Dado que el usuario guardó un gasto de Bs 35,00
  Cuando toca "Deshacer" dentro de los 10 segundos
  Entonces el gasto se elimina y el saldo se restablece
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
- **RF-M8-03:** Balance = ingresos − gastos. Tasa de ahorro = balance ÷ ingresos, en porcentaje entero redondeado con la mitad hacia arriba. La tasa de ahorro DEBE ocultarse si no hay ingresos o si el balance es negativo.
- **RF-M8-04:** Cada tarjeta DEBE mostrar su variación contra el mes anterior:
  - en el mes en curso, contra el mismo tramo de días del mes anterior (o hasta su último día, si es más corto);
  - en un mes cerrado, contra el mes anterior completo;
  - Ingresos y Gastos muestran la variación en %, redondeada a entero con la mitad hacia arriba; si el valor anterior es 0, se muestra "—";
  - Balance muestra la variación en moneda;
  - Tasa de ahorro muestra la variación en puntos porcentuales ("+3 pp").

  Los gastos que suben se marcan en rojo; los ingresos, el balance y la tasa de ahorro que suben, en verde.
- **RF-M8-05:** "Gasto por categoría" DEBE mostrar barras horizontales con las 5 categorías principales de mayor gasto (subcategorías sumadas), con monto y %, más "Otras".
- **RF-M8-06:** "Ritmo del gasto" DEBE comparar el gasto acumulado día a día del mes elegido (hasta hoy, si es el actual) contra el del mes anterior completo.
- **RF-M8-07:** "Saldos por cuenta" DEBE mostrar el total neto en moneda base y en la otra moneda (glosario) y las 5 primeras cuentas según el orden del usuario, con "Ver todas". Siempre son los saldos de hoy, con la leyenda "Saldos al día de hoy".
- **RF-M8-08:** "Presupuesto del mes" (V1.1) DEBE mostrar una barra por presupuesto activo, con su período visible. En un mes pasado, muestra los períodos que terminaron dentro de ese mes.
- **RF-M8-09:** "Próximos pagos y deudas" (V1.1) DEBE listar los vencimientos de los próximos 7 días: deudas (en ambas direcciones), tarjetas y, desde la V1.2, recurrentes. En un mes pasado, el bloque se oculta.
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
  Dado que el usuario recibió un préstamo de Bs 5.000,00 registrado en "Deudas y préstamos"
  Cuando mira el Inicio del mes
  Entonces la tarjeta Ingresos no incluye esos Bs 5.000,00
  Y el saldo de la cuenta sí los incluye

Escenario: Comparación por el mismo tramo
  Dado que hoy es 15 de octubre
  Y del 1 al 15 de septiembre se gastaron Bs 1.000,00
  Y del 1 al 15 de octubre se gastaron Bs 1.200,00
  Entonces la tarjeta Gastos muestra "+20 %" en rojo

Escenario: Tasa de ahorro oculta
  Dado un mes con ingresos Bs 3.000,00 y gastos Bs 3.500,00
  Entonces la tarjeta Tasa de ahorro no se muestra
```

---

### 2.9 M9 — Ajustes y personalización (V1.0)

#### 2.9.1 Flujos de usuario
1. El usuario abre Ajustes y elige una sección:
   - **General:**
     - formato de números: "Bs 1.234,56" (por defecto) o "Bs 1,234.56";
     - formato de fecha: DD/MM/AAAA (por defecto), AAAA-MM-DD o "15 oct 2026";
     - primer día de la semana: lunes (por defecto) o domingo;
     - tema: sistema (por defecto), claro u oscuro.
   - **Monedas y tipo de cambio:** monedas activas, moneda base, referencia y valor manual (M3).
   - **Registrar:** cuenta por defecto, categorías favoritas (hasta 8), atajos y "Mostrar la nota siempre" (M7).
   - **Inicio:** orden y visibilidad de los bloques 3 a 8 (M8).
   - **Recordatorios** (V1.2): M15.
2. Cada cambio se guarda al instante, sin botón "Guardar".
3. "Restablecer valores por defecto" (por sección, con confirmación) devuelve los ajustes de esa sección a sus valores iniciales.

#### 2.9.2 Ciclo de vida y estados
Cada ajuste está en su valor por defecto o en un valor personalizado. "Restablecer" lo devuelve al valor por defecto. No hay otros estados.

#### 2.9.3 Requerimientos funcionales
- **RF-M9-01:** TODOS los ajustes, incluidos el tema y la barra lateral contraída, DEBEN guardarse en la cuenta y verse iguales en todos los dispositivos.
- **RF-M9-02:** El símbolo de la moneda DEBE ir antes del monto, separado por un espacio ("Bs 35,00", "$ 97,09"). Al escribir montos se aplica RF-M7-02.
- **RF-M9-03:** Todas las fechas y montos de la app DEBEN respetar los formatos elegidos. Las listas usan expresiones relativas ("Hoy", "Ayer", "Lun 13").
- **RF-M9-04:** El primer día de la semana DEBE aplicarse al calendario.
- **RF-M9-05:** "Restablecer" NO DEBE tocar datos: cuentas, movimientos, categorías, atajos, monedas ni moneda base. En "Monedas y tipo de cambio" solo devuelve la referencia a la mediana del paralelo y desactiva el valor manual.
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
  Dado el formato "Bs 1,234.56"
  Cuando el usuario escribe "35.50" en Registrar
  Entonces el monto registrado es treinta y cinco con cincuenta

Escenario: Punto decimal con el formato por defecto
  Dado el formato "Bs 1.234,56"
  Cuando el usuario escribe "35.50" en Registrar
  Entonces el monto registrado es treinta y cinco con cincuenta
```

---

### 2.10 M10 — Onboarding (V1.0)

#### 2.10.1 Flujos de usuario
1. Tras confirmar su correo, el usuario entra al Onboarding: 3 pasos con el indicador "Paso N de 3", "Saltar paso" y "Saltar todo".
2. **Paso 1, moneda base:**
   - elige su moneda base (BOB por defecto). La app informa que siempre trabajará con BOB y USD;
   - la app informa "Usaremos el dólar paralelo: Bs 10,25 (puedes cambiarlo en Ajustes)". Si no hay ninguna tasa, informa "Aún no pudimos obtener el dólar; te lo pediremos al registrar algo en dólares".
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
- **EC-M10-03:** Se desmarcan todas las categorías de gasto, o todas las de ingreso. Se permite. Registrar mostrará "Ver todas" vacío para ese tipo, con la acción "Crear categoría" (EC-M7-07).

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
2. Elige el alcance: una categoría o una subcategoría de gasto, o "General" (todos los gastos). No se puede presupuestar "Deudas y préstamos"; sí su subcategoría "Intereses".
3. Define:
   - el monto mensual y la moneda;
   - el día de inicio del período, de 1 a 28 (1 por defecto);
   - la acción por defecto al cierre: descartar (por defecto) o arrastrar;
   - hasta 3 umbrales de alerta (80 % y 100 % por defecto).
4. Guarda. Ve la barra con el gasto que ya existe en el período actual.

**Seguir el período:** el detalle muestra:
- la barra (gastado / disponible) con la marca "hoy deberías llevar X";
- lo gastado y lo que queda;
- "Puedes gastar X/día durante N días" (no se muestra si el disponible es 0 o negativo), "Vas X por encima del ritmo" o "Superado por X";
- el desglose "Monto ± arrastre = disponible";
- el historial de los últimos 12 períodos.

**Decidir el cierre de un período**
1. Al cerrar un período llega un aviso a la bandeja y aparece una tarjeta en el presupuesto: "Comida cerró octubre: sobraron Bs 150,00" (o "te pasaste por Bs 100,00"). El sobrante o exceso es disponible − gastado.
2. Si sobró, el usuario reparte el sobrante entre:
   - "Arrastrar al período siguiente";
   - "Enviar a meta", eligiendo la meta y la cuenta de la que se aparta;
   - "Descartar".

   La suma debe dar exactamente el sobrante.
3. Si se pasó, elige entre "Arrastrar" (resta del período siguiente) y "Absorber" (se perdona).
4. Aplica. Si no decide en 7 días, se aplica la acción por defecto del presupuesto. Ante un exceso, "descartar" equivale a "absorber".

#### 2.11.2 Ciclo de vida y estados

**Presupuesto**

| Desde | Hacia | Condición |
|---|---|---|
| — | Activo | Creación |
| Activo | Pausado | Acción del usuario. No tiene períodos: no se renueva, no alerta, los gastos de la pausa no cuentan y el arrastre queda congelado |
| Pausado | Activo | Reanudar. Empieza el período que contiene hoy, con el arrastre congelado y contando el gasto desde el inicio de ese período |
| Activo o Pausado | Finalizado | Su categoría se archivó. Termina al cierre del período actual. Ese último cierre tiene decisión, pero sin "Arrastrar" |
| Cualquiera (salvo Eliminado) | Eliminado | Acción del usuario con confirmación. Desaparece con su historia |

- Estados finales: Finalizado y Eliminado.

**Cierre de período:** Pendiente de decisión → Decidido (por el usuario) | Decidido por defecto (a los 7 días).

#### 2.11.3 Requerimientos funcionales
- **RF-M11-01:** DEBE existir como máximo un presupuesto activo o pausado por categoría o subcategoría de gasto, más uno general opcional.
- **RF-M11-02:** Los presupuestos se anidan. Un gasto cuenta en el presupuesto de su subcategoría, en el de su padre y en el general. Si los hijos suman más que el padre, se avisa sin bloquear.
- **RF-M11-03:** El gasto de un presupuesto DEBE sumar los gastos de su alcance dentro del período, excluyendo lo que indica RN-02, convertidos a la moneda del presupuesto con la tasa guardada de cada movimiento.
- **RF-M11-04:** El período DEBE empezar el día elegido, que va de 1 a 28.
- **RF-M11-05:** Disponible = monto del período + arrastre (positivo o negativo). Un período puede empezar ya superado: se muestra "Superado por X" desde el inicio.
- **RF-M11-06:** El monto, la acción por defecto y los umbrales DEBEN aplicarse al período actual al editarlos. Los períodos pasados conservan su monto.
- **RF-M11-07:** Un cambio del día de inicio DEBE aplicarse desde el próximo período: el período en curso se alarga hasta el día anterior al nuevo día de inicio, con el monto de un mes, y se avisa su fecha de fin. La moneda NO DEBE cambiar.
- **RF-M11-08:** En el cierre, sobrante o exceso = disponible − gastado. El sobrante DEBE repartirse entre arrastrar, enviar a meta y descartar, con suma exacta. El exceso DEBE arrastrarse o absorberse. Lo arrastrado es el arrastre completo del período siguiente: reemplaza al anterior, no se suma.
- **RF-M11-09:** "Enviar a meta" DEBE:
  - crear un apartado en la cuenta que elija el usuario, dentro de su saldo libre (M12). El monto se convierte de la moneda del presupuesto a la de la cuenta con la referencia vigente;
  - si la meta tiene cuenta dedicada, ofrecer como alternativa una transferencia real hacia ella;
  - estar disponible solo en el presupuesto general o, si no existe, en los presupuestos de categorías principales. Las subcategorías solo arrastran o descartan;
  - desaparecer de la tarjeta si la meta se elimina o se archiva con el cierre pendiente.
- **RF-M11-10:** Si en 7 días no hay decisión, el sistema DEBE aplicar la acción por defecto del presupuesto. Ante un exceso, "descartar" equivale a "absorber". Si el sistema estuvo caído al vencer un período, el cierre se genera al volver y sus 7 días cuentan desde ese momento.
- **RF-M11-11:** Los movimientos tardíos (cargados, editados o eliminados con fecha de un período ya cerrado, sin límite de antigüedad) NO DEBEN reabrir la decisión. Su efecto depende del cierre:
  - decisión pendiente: se recalcula el sobrante o exceso de la tarjeta;
  - la decisión incluyó arrastrar: la diferencia va al arrastre del período en curso, explicada como "Ajuste por movimientos tardíos de [período]";
  - se decidió solo descartar, absorber o enviar a meta: no tiene efecto;
  - presupuesto pausado, finalizado o eliminado: no tiene efecto.
- **RF-M11-12:** "Reiniciar arrastre" DEBE poner el acumulado en 0, con una confirmación que muestra el monto.
- **RF-M11-13:** Los umbrales (de 0 a 3, entre 1 % y 150 %) DEBEN medirse sobre el monto del período, no sobre el disponible:
  - cada uno avisa una sola vez por período (RN-10);
  - si un presupuesto se crea, o un período empieza, ya por encima de umbrales, solo se avisa el más alto cruzado;
  - un presupuesto pausado no alerta.
- **RF-M11-14:** Un presupuesto superado DEBE seguir contando gastos y mostrarse como superado.

#### 2.11.4 Casos borde y excepciones
- **EC-M11-01:** El arrastre negativo supera el monto del período. El período empieza superado y la barra lo muestra.
- **EC-M11-02:** En el cierre se envía a una meta más que el saldo libre de la cuenta elegida. Se rechaza y se pide otra cuenta o un monto menor.
- **EC-M11-03:** Se elimina o se archiva la meta elegida mientras el cierre está pendiente. Esa opción desaparece de la tarjeta.
- **EC-M11-04:** Se archiva la categoría con una decisión de cierre pendiente. La decisión sigue disponible hasta los 7 días.
- **EC-M11-05:** Se elimina un gasto de un período cerrado cuya decisión incluyó arrastrar. El arrastre del período en curso sube por ese monto (RF-M11-11). Si la decisión fue descartar, no cambia nada.
- **EC-M11-06:** Se intenta crear un segundo presupuesto para la misma categoría. Se rechaza y se ofrece editar el existente.
- **EC-M11-07:** Se cambia el día de inicio de 1 a 15 durante el período del 1 al 31 de octubre. Ese período se alarga hasta el 14 de noviembre con el monto de un mes, y el siguiente empieza el 15 de noviembre.
- **EC-M11-08:** Se reanuda a mitad de período un presupuesto pausado. El período que contiene hoy cuenta el gasto desde su inicio, con el arrastre congelado.
- **EC-M11-09:** Se archiva la categoría de un presupuesto. Al cerrar su último período, la decisión ofrece descartar o enviar a meta (o absorber, si hubo exceso), pero no arrastrar.

#### 2.11.5 Criterios de aceptación
```gherkin
Escenario: Repartir un sobrante
  Dado el presupuesto "Comida" de Bs 800,00 que cerró octubre con Bs 650,00 gastados
  Cuando el usuario arrastra 50,00 y envía 100,00 a la meta "Viaje" desde el Banco
  Entonces noviembre tiene disponible Bs 850,00
  Y la meta "Viaje" suma un apartado de Bs 100,00 en el Banco

Escenario: Exceso arrastrado
  Dado el presupuesto "Ocio" de Bs 300,00 que cerró con Bs 400,00 gastados
  Cuando el usuario elige "Arrastrar"
  Entonces el período siguiente tiene disponible Bs 200,00

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
2. Opcionalmente, dedica a la meta una cuenta de banco, ahorro, efectivo, billetera u otro (nunca una tarjeta). Todo su saldo actual cuenta desde ese momento.
3. La app muestra el aporte mensual sugerido.

**Aportar con un apartado**
1. Desde la meta, el usuario toca "Apartar", elige una cuenta y un monto (hasta el saldo libre).
2. El dinero sigue en la cuenta pero queda reservado. La cuenta muestra Saldo · Apartado para metas · Libre.

**Aportar a la cuenta dedicada:** cualquier ingreso o transferencia hacia la cuenta dedicada suma automáticamente, incluido el cobro de una deuda "Me deben".

**Retirar:** el usuario libera un apartado (total o parcial). En la cuenta dedicada, toda salida resta automáticamente, sin pedir confirmación; Registrar muestra el aviso "Esto resta a tu meta X".

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
- **RF-M12-01:** El nombre DEBE tener de 1 a 40 caracteres, el objetivo DEBE ser mayor que 0 y la fecha objetivo, si existe, DEBE ser hoy o futura. La moneda es cualquiera activa y se puede editar. Al cambiarla, los hitos ya avisados no se repiten.
- **RF-M12-02:** El progreso DEBE ser el saldo de su cuenta dedicada (si tiene, con mínimo 0) más sus apartados en otras cuentas, convertido a la moneda de la meta con la tasa vigente. No existen aportes sin cuenta.
- **RF-M12-03:** Una meta DEBE tener como máximo una cuenta dedicada, que no puede ser una tarjeta. Una cuenta dedicada pertenece a una sola meta y no tiene apartados de otras metas.
- **RF-M12-04:** Una cuenta normal que no sea tarjeta PUEDE tener apartados de varias metas. Solo se aparta dentro del saldo libre.
- **RF-M12-05:** El sistema DEBE pedir confirmación antes de guardar toda operación que deje el saldo de una cuenta por debajo de lo apartado: gastos, transferencias, ediciones, eliminaciones de ingresos, deshacer, ajustes, pagos de deuda y eliminación de una deuda con sus movimientos:
  - la confirmación muestra "Este gasto usa X apartados" y las metas afectadas;
  - viene una propuesta precargada (primero la meta con la fecha más lejana o sin fecha) que el usuario puede cambiar;
  - si confirma, se guarda y los apartados se reducen, registrado como retiro en cada meta;
  - si cancela, no se guarda nada.

  Las salidas de una cuenta dedicada NO piden confirmación: restan automáticamente y Registrar muestra el aviso "Esto resta a tu meta X".

- **RF-M12-06:** Aporte mensual sugerido = (objetivo − progreso) ÷ meses calendario restantes, incluido el actual. Además:
  - si la fecha es este mes, se muestra "Faltan X este mes";
  - sin fecha, una calculadora "Aportando X/mes llegas en [mes]";
  - si está vencida, "Elige una nueva fecha";
  - si el progreso ya alcanzó el objetivo, no se muestra.
- **RF-M12-07:** El detalle DEBE mostrar el progreso por cuenta, la historia de apartados y retiros con su origen (manual, presupuesto, cuenta dedicada, gasto confirmado) y el sugerido.
- **RF-M12-08:** El total neto de Cuentas NO DEBE cambiar por los apartados. El desglose suma la línea "Apartado para metas": los apartados más el saldo positivo de las cuentas dedicadas.
- **RF-M12-09:** "Usar y cerrar" DEBE liberar todos los apartados, convertir la cuenta dedicada en normal y archivar la meta con su historia.

#### 2.12.4 Casos borde y excepciones
- **EC-M12-01:** Se intenta apartar más que el saldo libre. Se rechaza indicando el saldo libre.
- **EC-M12-02:** Se intenta archivar una cuenta con apartados. Se rechaza indicando qué metas debe liberar primero.
- **EC-M12-03:** Una meta en USD con apartados en BOB baja del 100 % porque el dólar subió. Pasa a En curso.
- **EC-M12-04:** La cuenta dedicada queda en negativo (un banco con sobregiro). Aporta 0 a la meta, nunca un valor negativo.
- **EC-M12-05:** Un recurrente automático tocaría dinero apartado. No se registra y pasa a pendiente (M14).
- **EC-M12-06:** Se dedica a una meta una cuenta que ya tiene apartados de otras metas. Se rechaza: primero hay que liberar esos apartados.
- **EC-M12-07:** Se registra un ajuste negativo en un banco y su saldo quedaría por debajo de lo apartado. Se pide la confirmación de RF-M12-05.
- **EC-M12-08:** Se intenta dedicar una tarjeta a una meta. La opción no está disponible.

#### 2.12.5 Criterios de aceptación
```gherkin
Escenario: Progreso combinado
  Dado la meta "Viaje" con cuenta dedicada "Ahorro" de saldo Bs 850,00
  Y apartados de Bs 200,00 en el Banco y Bs 150,00 en Efectivo
  Entonces el progreso de "Viaje" es Bs 1.200,00

Escenario: Gasto que toca dinero apartado
  Dado el Banco con saldo Bs 4.800,00 y Bs 300,00 apartados
  Cuando el usuario registra un gasto de Bs 4.600,00 desde el Banco
  Entonces la app pregunta de qué metas tomar Bs 100,00
  Cuando confirma
  Entonces el gasto se guarda y los apartados del Banco quedan en Bs 200,00

Escenario: Usar y cerrar
  Dado la meta "Laptop" cumplida con apartados en dos cuentas
  Cuando el usuario toca "Usar y cerrar"
  Entonces los apartados se liberan
  Y la meta queda Archivada con su historia

Escenario: Salida de la cuenta dedicada sin confirmación
  Dado la meta "Viaje" con cuenta dedicada "Ahorro"
  Cuando el usuario registra un gasto desde "Ahorro"
  Entonces el gasto se guarda sin pedir confirmación
  Y ve el aviso "Esto resta a tu meta Viaje"
  Y el progreso de "Viaje" baja por ese monto
```

---

### 2.13 M13 — Deudas y préstamos (V1.1)

#### 2.13.1 Flujos de usuario
**Registrar una deuda**
1. El usuario toca "Nueva deuda" y elige la dirección: "Debo" o "Me deben".
2. Completa:
   - la persona (texto con autocompletado);
   - el monto, la moneda y la fecha de inicio (hoy o anterior);
   - la fecha límite y la nota (opcionales);
   - el interés simple (opcional): un porcentaje mensual o anual, de 0,01 % a 100 %.
3. Opcionalmente indica la cuenta por la que se movió el dinero:
   - en "Debo", entra a la cuenta como ingreso de "Deudas y préstamos";
   - en "Me deben", sale de la cuenta como gasto de "Deudas y préstamos".

   Si la cuenta tiene otra moneda, indica el tipo de cambio usado.

4. La deuda aparece en la lista con su saldo pendiente y, si tiene fecha límite, en los próximos vencimientos del Inicio.

**Registrar un pago**
1. Desde la deuda, el usuario toca "Registrar pago" y escribe el monto en la moneda de la deuda.
2. La app propone el desglose, primero el interés acumulado y luego el capital, y el usuario puede cambiarlo.
3. Elige la cuenta (opcional) y la fecha. Si la cuenta tiene otra moneda, indica el tipo de cambio usado y la app calcula el monto en la moneda de la cuenta.
4. Guarda. Si eligió una cuenta, se crean los movimientos vinculados:
   - la parte de capital en "Deudas y préstamos";
   - la parte de interés en "Deudas y préstamos › Intereses".

   En "Debo" son gastos; en "Me deben", ingresos.

**Eliminar el último pago:** desde la deuda, el usuario puede eliminar solo el último pago, salvo en una deuda Condonada. El capital y el interés que cubría ese pago se restablecen y, desde ese momento, el interés corre sobre el capital restablecido. Lo ya acumulado no se recalcula (RF-M13-04). De los pagos solo se edita la nota.

**Condonar:** el usuario toca "Condonar saldo" y la deuda pasa a Condonada sin mover dinero.

**Consultar**
- Arriba de la lista, el resumen "Debes X · Te deben Y" en moneda base.
- La lista se ve por deuda (por defecto) o agrupada por persona, con el neto de cada una en moneda base. Los nombres se agrupan sin distinguir mayúsculas ni tildes.

#### 2.13.2 Ciclo de vida y estados

| Desde | Hacia | Condición |
|---|---|---|
| — | Activa | Creación |
| Activa | Vencida | Pasa la fecha límite con saldo pendiente |
| Vencida | Activa | Se extiende la fecha límite |
| Activa o Vencida | Pagada | Capital pendiente = 0 e interés pendiente = 0 |
| Activa o Vencida | Condonada | "Condonar saldo" |
| Pagada | Activa o Vencida | Se elimina su último pago (Vencida si la fecha límite ya pasó) |
| Cualquiera | Eliminada | Con confirmación (ver RF-M13-11) |

- Estados finales: Condonada y Eliminada.
- Prohibido: pagos nuevos sobre una deuda Pagada o Condonada; editar un pago (salvo su nota); eliminar un pago que no sea el último; eliminar pagos de una deuda Condonada.

#### 2.13.3 Requerimientos funcionales
- **RF-M13-01:** La persona DEBE tener de 1 a 40 caracteres, con autocompletado sobre las personas ya usadas. El monto es mayor que 0. La fecha de inicio es hoy o anterior. El interés, si existe, va de 0,01 % a 100 %.
- **RF-M13-02:** El interés simple DEBE acumularse día a día sobre el capital pendiente, desde la fecha de inicio (aunque sea pasada), y seguir corriendo después de la fecha límite hasta que el capital llegue a 0. La tasa diaria es la mensual ÷ 30 o la anual ÷ 365. Se acumula con precisión exacta y solo se redondea a 2 decimales al mostrarlo o al pagarlo. Se muestra aparte del capital.
- **RF-M13-03:** La tasa y el período de interés DEBEN quedar fijos al crear la deuda.
- **RF-M13-04:** El interés ya acumulado NUNCA DEBE recalcularse: ni por pagos con fecha pasada, ni por eliminar un pago, ni por el tipo de cambio o la configuración. Un pago, aunque tenga fecha pasada, reduce el capital desde el momento en que se registra. Eliminar el último pago restablece, desde el momento de la eliminación, el capital y el interés que ese pago había cubierto: ese interés vuelve a quedar sin pagar, sin recalcularse.
- **RF-M13-05:** En cada pago, el desglose DEBE venir precargado (interés primero) y ser editable, cumpliendo:
  - interés ≤ interés acumulado;
  - capital ≤ capital pendiente;
  - interés + capital = monto del pago.
- **RF-M13-06:** Saldo pendiente = capital pendiente + interés acumulado no pagado. Nunca es negativo, y un pago no puede superarlo.
- **RF-M13-07:** La fecha de un pago DEBE estar entre la fecha de inicio y hoy.
- **RF-M13-08:** La parte de interés de un pago DEBE contar como gasto ("Debo") o como ingreso ("Me deben"). La parte de capital y el movimiento inicial NO cuentan (RN-02).
- **RF-M13-09:** Un pago, o el movimiento inicial, en una cuenta de otra moneda DEBE pedir el tipo de cambio usado, precargado según RF-M3-07 y editable, y guardarlo. El monto se ingresa en la moneda de la deuda y la app calcula el de la cuenta, para que nunca quede un residuo por redondeo.
- **RF-M13-10:** La edición DEBE cumplir:
  - en una deuda Activa o Vencida: persona, nota y fecha límite, siempre; monto original, solo si queda mayor o igual al capital ya pagado; dirección, moneda, tasa y período, fijos;
  - en una deuda Pagada o Condonada: solo persona y nota.

  La cuenta y el movimiento inicial se editan desde la deuda. De los pagos solo se edita la nota, y solo se puede eliminar el último, desde la deuda y salvo en una Condonada.
- **RF-M13-11:** Al eliminar una deuda con movimientos asociados (el inicial o pagos), el usuario DEBE elegir entre "Eliminar también los N movimientos asociados" y "Conservarlos como movimientos normales". N incluye el movimiento inicial. Ambas opciones respetan el bloqueo de negativos y los apartados. Una deuda sin ningún movimiento se elimina directamente.
- **RF-M13-12:** "Condonar saldo" DEBE cerrar la deuda en Condonada, mostrar el monto condonado y no crear movimientos.
- **RF-M13-13:** El resumen DEBE mostrar el total que se debe y el total que deben al usuario, en moneda base con la referencia vigente. La vista por persona muestra el neto de cada persona en moneda base, agrupando los nombres sin distinguir mayúsculas ni tildes.
- **RF-M13-14:** Los avisos de vencimiento (desde la V1.1), en ambas direcciones, DEBEN llegar 3 días antes, el día del vencimiento y el día siguiente si la deuda quedó vencida. Después no insisten.

#### 2.13.4 Casos borde y excepciones
- **EC-M13-01:** Un pago supera el saldo pendiente. Se rechaza indicando el saldo.
- **EC-M13-02:** El capital llega a 0 pero queda interés acumulado sin pagar. La deuda sigue Activa (o Vencida) hasta saldarlo, y ya no se acumula más interés.
- **EC-M13-03:** El pago sale del efectivo y lo dejaría en negativo. Se rechaza (M4).
- **EC-M13-04:** El pago sale de una cuenta con apartados. Se aplica la confirmación de M12.
- **EC-M13-05:** Se intenta eliminar un pago que no es el último. La acción no está disponible.
- **EC-M13-06:** La misma persona aparece en "Debo" y en "Me deben". La vista por persona muestra el neto.
- **EC-M13-07:** Se elimina el último pago de una deuda Pagada. Vuelve a Activa (o Vencida): el capital se restablece y el interés corre sobre él desde ese momento, sin recalcular lo ya acumulado.
- **EC-M13-08:** Se crea hoy una deuda con interés y fecha de inicio el 1 de enero. El interés se acumula desde el 1 de enero.

#### 2.13.5 Criterios de aceptación
```gherkin
Escenario: Interés sobre el capital pendiente
  Dado una deuda "Debo" de Bs 2.000,00 al 2 % mensual
  Y un pago de capital de Bs 1.000,00
  Entonces desde que se registra el pago el interés se acumula sobre Bs 1.000,00
  Y el interés acumulado antes del pago no cambia

Escenario: Desglose precargado
  Dado una deuda con interés acumulado Bs 42,30 y capital pendiente Bs 2.000,00
  Cuando el usuario registra un pago de Bs 500,00
  Entonces el desglose propuesto es interés 42,30 y capital 457,70
  Y al guardar desde el Banco, Bs 42,30 cuentan como gasto en "Intereses"

Escenario: Condonar
  Dado una deuda "Me deben" con saldo pendiente Bs 300,00
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
   - el nombre (de 1 a 40 caracteres, por ejemplo "Netflix");
   - el monto (opcional solo en modo confirmación), la cuenta (o el origen y el destino), la categoría y la nota;
   - la frecuencia: diaria, semanal (eligiendo un solo día), mensual (día fijo) o anual (fecha fija);
   - la fecha de inicio (hoy o futura);
   - el fin: sin fin, hasta una fecha (incluida, igual o posterior al inicio) o después de N veces (de 1 a 999);
   - el modo: automático o con confirmación.
3. Guarda. La regla muestra sus próximas fechas. Si empieza hoy, la ocurrencia de hoy se crea en ese momento.

**En la fecha de una ocurrencia**
- En modo automático, el movimiento se registra a las 00:00 en la zona horaria del usuario.
- En modo confirmación, se crea un pendiente. Se ve en la bandeja (si el aviso está activo) y siempre en la sección "Pendientes de confirmar" de Recurrentes.
- El usuario confirma (ajustando el monto, la fecha o la tasa) u omite.

**Pausar y reanudar**
1. El usuario pausa la regla.
2. Al reanudarla, la app pregunta qué ocurrencias de la pausa registrar. Las elegidas se registran con su fecha original y la tasa de esa fecha; las que bloquearían M4 o M12 quedan como pendientes. Si la fecha de fin ya pasó, la regla queda Finalizada y solo se ofrecen las ocurrencias hasta esa fecha.

#### 2.14.2 Ciclo de vida y estados

**Regla**

| Desde | Hacia | Condición |
|---|---|---|
| — | Activa | Creación |
| Activa | Pausada | Por el usuario, o automáticamente si se archiva su categoría o su cuenta (con aviso) |
| Pausada | Activa | Reanudar (con la pregunta por las ocurrencias saltadas) |
| Activa o Pausada | Finalizada | Se alcanza la fecha de fin, o se genera (o se registra al reanudar) la ocurrencia número N |
| Finalizada | Activa | Se extiende el fin |
| Cualquiera | Eliminada | Por el usuario |

- Estado final: Eliminada.

**Ocurrencia:** ver el ciclo de Pendiente en M6.

#### 2.14.3 Requerimientos funcionales
- **RF-M14-01:** Las frecuencias DEBEN ser diaria, semanal, mensual con día fijo y anual. Una regla semanal tiene un solo día y lo respeta.
- **RF-M14-02:** Si el día elegido no existe en un mes, la ocurrencia DEBE caer el último día del mes. El 29 de febrero pasa al 28 en los años no bisiestos.
- **RF-M14-03:** La fecha de inicio DEBE ser hoy o futura. El sistema NUNCA genera ocurrencias con fecha anterior a la fecha de inicio. Si la regla empieza hoy, la ocurrencia de hoy se genera al guardarla.
- **RF-M14-04:** Las ocurrencias DEBEN ejecutarse a las 00:00 en la zona horaria del usuario. Si ese día no existe la 00:00 (horario de verano), se ejecutan en el primer minuto válido del día. Un cambio de zona horaria no repite ni pierde fechas.
- **RF-M14-05:** Una ocurrencia automática DEBE quedar como pendiente si dejaría una cuenta en negativo (M4) o si tocaría dinero apartado (M12).
- **RF-M14-06:** En una transferencia recurrente entre monedas distintas, el modo automático DEBE usar la precarga de RF-M3-07 del día de ejecución. En modo confirmación, el usuario ajusta la tasa al confirmar.
- **RF-M14-07:** Un pendiente sin decisión DEBE pasar a Omitido a los 30 días de generado, con un aviso. Esto vale también para los pendientes recuperados tras una caída del sistema. Las ocurrencias siguientes se generan aunque haya pendientes anteriores.
- **RF-M14-08:** Un pendiente se confirma con su fecha original o con otra, sin fechas futuras. Puede ser anterior al saldo inicial de la cuenta (RF-M4-03). Si su cuenta o categoría está archivada, se pide elegir otra. En una regla sin monto, el monto se ingresa al confirmar.
- **RF-M14-09:** Al reanudar una regla, el sistema DEBE preguntar qué ocurrencias saltadas registrar. Se registran con su fecha original y la tasa de esa fecha; las que bloquearían M4 o M12 quedan como pendientes. Para el total de N veces cuenta toda ocurrencia generada: registradas, pendientes y omitidas. Las saltadas cuentan solo si se registran. Al llegar a N, la regla pasa a Finalizada.
- **RF-M14-10:** Editar una regla DEBE afectar solo a las ocurrencias futuras. Los pendientes y los movimientos ya creados no cambian.
- **RF-M14-11:** Eliminar una regla DEBE conservar los movimientos creados y borrar sus pendientes.
- **RF-M14-12:** NUNCA DEBE existir más de una ocurrencia de la misma regla para la misma fecha. Si el sistema estuvo caído, recupera las ocurrencias de esos días sin duplicarlas.
- **RF-M14-13:** La pantalla DEBE mostrar:
  - las reglas con su próxima fecha;
  - "Pendientes de confirmar";
  - "Próximos vencimientos" de 30 días;
  - por regla, las siguientes 3 fechas y "Cuota X de N" si el fin es por cantidad.
- **RF-M14-14:** El monto DEBE ser obligatorio en modo automático y opcional en modo confirmación. Una regla sin monto se muestra como "monto por definir".
- **RF-M14-15:** Cada regla DEBE tener un nombre de 1 a 40 caracteres, que se usa en la etiqueta "De recurrente: X", en la lista y en los avisos.

#### 2.14.4 Casos borde y excepciones
- **EC-M14-01:** Una regla mensual con el día 31 en noviembre. La ocurrencia cae el 30 de noviembre.
- **EC-M14-02:** Se archiva la cuenta de la regla. La regla se pausa con un aviso para elegir otra cuenta.
- **EC-M14-03:** El sistema estuvo caído 2 días. Al volver, crea las ocurrencias de esos días una sola vez.
- **EC-M14-04:** Se elimina una regla con un pendiente. El pendiente desaparece.
- **EC-M14-05:** Se reanuda una regla de "12 veces" que generó 11 ocurrencias antes de la pausa, y el usuario quiere registrar 2 saltadas. Solo puede registrar 1 y la regla pasa a Finalizada.
- **EC-M14-06:** Se reanuda una regla cuya fecha de fin pasó durante la pausa. Queda Finalizada y solo ofrece registrar las ocurrencias saltadas hasta esa fecha.
- **EC-M14-07:** Se crea a las 15:00 una regla que empieza hoy. La ocurrencia de hoy se crea al guardar.

#### 2.14.5 Criterios de aceptación
```gherkin
Escenario: Automático bloqueado pasa a pendiente
  Dado una regla automática "Pasaje" de Bs 50,00 desde Efectivo
  Y el Efectivo tiene Bs 30,00
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
2. El usuario abre la bandeja. Tocar un aviso lo marca como leído y lleva a su pantalla. Si lo que avisa ya no existe, se muestra "Esto ya no existe".
3. Los avisos que piden decisión (cierre de presupuesto, pendiente de recurrente) tienen sus botones en la misma bandeja.
4. El usuario puede marcar todo como leído (también los avisos que esperan decisión) o eliminar un aviso deslizándolo o desde su menú "…". Si el aviso esperaba una decisión, esta sigue disponible en su módulo.

**Configurar** (V1.2): en Ajustes › Recordatorios, el usuario activa o desactiva cada tipo y ajusta su hora, los días de anticipación (de 0 a 7) o los días de la semana, según el tipo.

#### 2.15.2 Ciclo de vida y estados

| Desde | Hacia | Condición |
|---|---|---|
| — | No leído | Se genera el aviso |
| No leído | Leído | El usuario lo toca, o usa "Marcar todo como leído" |
| No leído o Leído | Eliminado | El usuario lo elimina (deslizándolo o desde su menú), o pasan 90 días |
| Esperando decisión | Resuelto | El usuario decide, o el sistema aplica el valor por defecto (7 días para un cierre, 30 días para un pendiente) |

- Prohibido: borrar por antigüedad un aviso que espera una decisión.

#### 2.15.3 Requerimientos funcionales
- **RF-M15-01:** Todos los avisos DEBEN llegar solo dentro de la app, sin correo de avisos ni notificaciones push.
- **RF-M15-02:** Los tipos y sus valores por defecto DEBEN ser:

  | Tipo | Activo por defecto | Comportamiento |
  |---|---|---|
  | Pago próximo | Sí | Recurrentes de gasto y de transferencia con frecuencia semanal o mayor (no diarias), 1 día antes; sin monto, dicen "monto por definir". Tarjetas, el día del corte y 3 días antes del pago. Deudas en ambas direcciones, 3 días antes, el día y el día siguiente si quedó vencida |
  | Alertas de presupuesto | Sí | Según los umbrales de cada presupuesto (M11) |
  | Cierre de período | Sí | Al cerrar cada período de presupuesto |
  | Pendiente de recurrente | Sí | Al generarse un pendiente, al omitirse por vencimiento y al pausarse una regla porque se archivó su cuenta o su categoría (para elegir otra) |
  | Registrar el día | No | Siempre a la hora elegida (21:00 por defecto), en los días de la semana elegidos |
  | Avance de metas | No | Al cruzar el 25 %, 50 %, 75 % y 100 %. Además, el día 1 de cada mes, si el mes anterior se aportó menos que lo sugerido. Aporte del mes = apartados + entradas a la cuenta dedicada − retiros, sin el efecto del tipo de cambio |

- **RF-M15-03:** Todos los tipos DEBEN poder desactivarse. Desactivar un tipo de decisión no oculta la decisión: los pendientes siguen en Recurrentes y la tarjeta de cierre en el presupuesto.
- **RF-M15-04:** Un mismo evento NUNCA DEBE generar dos avisos (RN-10). Cada hito de meta avisa una sola vez, aunque el tipo de cambio lo haga oscilar.
- **RF-M15-05:** Los avisos DEBEN borrarse solos a los 90 días, salvo los que esperan una decisión.
- **RF-M15-06:** El contador de la campana DEBE mostrar los avisos no leídos.
- **RF-M15-07:** En la V1.1 existen la campana, la bandeja y los avisos de alertas de presupuesto, cierre de período y vencimiento de deudas, todos activos y sin configuración. La V1.2 agrega los demás tipos y la configuración.
- **RF-M15-08:** El aviso de "cambio fuerte del dólar" NO existe.
- **RF-M15-09:** Los avisos programados sin hora configurable (vencimientos de deudas y tarjetas, pagos próximos, avance mensual de metas) DEBEN generarse a las 08:00 en la zona horaria del usuario.
- **RF-M15-10:** Al reactivar un tipo de aviso, NO DEBEN generarse avisos de lo ocurrido mientras estaba desactivado.
- **RF-M15-11:** Al tocar un aviso de algo que ya no existe (deuda, meta, regla), el sistema DEBE mostrar "Esto ya no existe" y marcarlo como leído.
- **RF-M15-12:** "Marcar todo como leído" y eliminar un aviso DEBEN funcionar también con los avisos que esperan una decisión. La decisión sigue en su módulo (RF-M15-03).

#### 2.15.4 Casos borde y excepciones
- **EC-M15-01:** El usuario resuelve un pendiente desde Recurrentes. El aviso de la bandeja queda Resuelto.
- **EC-M15-02:** Se cambia el día de pago de una tarjeta después de generado su aviso. El aviso ya generado no se repite, y el próximo usa la nueva fecha.
- **EC-M15-03:** El aviso "Registrar el día" se genera aunque ya haya movimientos ese día, porque es el comportamiento elegido.

#### 2.15.5 Criterios de aceptación
```gherkin
Escenario: Aviso de vencimiento de deuda
  Dado una deuda "Debo" a Juan con fecha límite el 20/10
  Cuando es 17/10
  Entonces llega a la bandeja "Vence en 3 días: debes Bs 1.200,00 a Juan"

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
- **RNF-03:** El Inicio DEBE cargar en menos de 2 segundos con 5.000 movimientos, en una conexión 4G.
- **RNF-04:** La actualización del tipo de cambio NUNCA DEBE bloquear ni demorar el uso de la app.
- Los tiempos de RNF-01 a RNF-03 se miden en un celular de gama media con red 4G.

### 3.2 Compatibilidad y accesibilidad
- **RNF-05:** La app DEBE funcionar desde 360 px de ancho en las 2 últimas versiones mayores de Chrome, Safari y Firefox, con las mismas funciones en celular y escritorio.
- **RNF-06:** La app DEBE cumplir WCAG 2.2 nivel AA y ser usable por completo con teclado. Toda acción por gesto DEBE tener una alternativa: menú "…" con "Eliminar" en los avisos, casillas para las acciones en lote y botones "Subir" y "Bajar" para reordenar.
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
- **RNF-18:** Los cálculos DEBEN ser exactos al centavo, con el redondeo de RN-06. No deben acumularse diferencias por redondeo: el interés de las deudas se acumula con precisión exacta y solo se redondea al mostrarlo o al pagarlo.
- **RNF-19:** Los valores históricos (movimientos, períodos cerrados, interés acumulado) NUNCA DEBEN cambiar por movimientos del tipo de cambio ni por cambios de configuración. Los únicos cambios que alteran cifras pasadas son los de RN-11.

### 3.7 Tiempo
- **RNF-20:** Todas las fechas de negocio (día de un movimiento, períodos, vencimientos, ejecución de recurrentes y avisos) DEBEN calcularse en la zona horaria del perfil del usuario.

### 3.8 Disponibilidad y tolerancia a fallos
- **RNF-21:** Si fallan las fuentes del tipo de cambio, la app DEBE seguir funcionando con el último valor guardado (M3).
- **RNF-22:** Si falla el servicio de correo, el usuario DEBE poder reenviar los correos de la cuenta respetando los límites (M1).
- **RNF-23:** Sin conexión, la app DEBE bloquearse por completo, incluido Registrar, sin perder los borradores (M2). Es una excepción aceptada al principio rector de la constitución: no existe modo sin conexión.

### 3.9 Auditoría y retención
- **RNF-24:** En la V1 no existe un historial de ediciones por movimiento.
- **RNF-25:** Los eventos de seguridad (cambio de contraseña y eliminación de la cuenta) DEBEN notificarse al dueño por correo.
- **RNF-26:** Retención:
  - avisos: 90 días (salvo los que esperan decisión);
  - registros sin confirmar: 7 días;
  - datos de una cuenta eliminada: se borran de inmediato.
- **RNF-27:** La fuente "paralelo.bo" DEBE mostrarse junto a sus datos, como exige su licencia de uso.

### 3.10 Límites por usuario
- **RNF-28:** Cada usuario tiene como máximo 50 cuentas, 300 categorías, 50 metas, 200 deudas, 100 presupuestos, 100 reglas recurrentes y 12 atajos. Al llegar a un límite, se informa y no se crea el elemento.

### 3.11 Rendimiento de cada pestaña
- **RNF-29:** Cambiar de pestaña DEBE mostrar sus datos principales en menos de 2 segundos en una conexión 4G, con el servicio ya activo y 5.000 movimientos. Amplía RNF-03 (Inicio) a todas las pestañas.

---

## 4. Historial de cambios

| Versión | Fecha | Cambios |
|---|---|---|
| 1.0 | 2026-10-15 | Versión inicial. |
| 1.1 | 2026-10-16 | Resuelve la revisión QA de 127 hallazgos: historial diario de tasas por moneda, tasa guardada al guardar y con 2 decimales, prioridad del valor manual, moneda base libre y "otra moneda" definida; alcance de comparativos y proyecciones; cambios que pueden alterar la historia (RN-11); borradores en todos los formularios; arrastre que se reemplaza en cada cierre y movimientos tardíos según la decisión; interés desde la fecha de inicio que nunca se recalcula, con eliminación solo del último pago; recurrentes que empiezan hoy, que cuentan toda ocurrencia y con monto variable; protección de apartados ampliada; sin sesión hasta confirmar el correo; exportación completa; formato "Bs 1.234,56"; límites por usuario; saldo inicial fijo (se corrige con un ajuste); tasa guardada que solo cambia a mano; tarjetas con saldo inicial a favor; cuentas dedicadas en "Apartado para metas". |
| 1.2 | 2026-10-16 | Ajustes por las fuentes reales de tasas (revisión técnica del plan): el oficial del BCB es un solo valor (TCO); en el paralelo, "venta" es el mayor de los dos valores publicados y "compra" el menor; los días sin compra o venta usan la mediana de ese día; la tasa mínima de una moneda agregada es Bs 0,01. |
| 1.3 | 2026-10-16 | Un nuevo registro con un correo Sin confirmar reinicia el plazo de 7 días para descartarlo. Un movimiento con fecha pasada guarda la tasa de la referencia y del valor manual que el usuario tenía en uso ese día (el historial guarda también los cambios de referencia). El día de una tasa de mercado es el día calendario de Bolivia. El aviso del valor manual se muestra en el panel de Tipo de cambio y como distintivo en la ficha del dólar. Una transferencia con fecha pasada precarga los valores de ese día. Cuentas: el gráfico de saldo usa el filtro de fechas del detalle; el saldo inicial tiene los límites de RF-M6-01; un saldo a favor de tarjeta reduce la deuda en tarjetas; reglas para cambiar el tipo de una cuenta. Una categoría usada por un presupuesto o una regla no se elimina (se archiva). Nombre de atajo de 1 a 30 caracteres. Eliminar el último pago de una deuda restablece también su interés. Las reglas recurrentes tienen nombre (1 a 40). |
| 1.4 | 2026-10-16 | El aviso que acompaña a una regla recurrente pausada automáticamente (al archivar o eliminar su cuenta, o al archivar su categoría) es del tipo "Pendiente de recurrente", y respeta su configuración. |
| 1.5 | 2026-10-28 | Se elimina el correo de aviso por intentos fallidos (RF-M1-08, RF-M1-16, RNF-25); la espera progresiva se mantiene. El enlace del correo solo confirma la cuenta y la app que espera continúa sola al Onboarding, también si el enlace se abre en otro dispositivo (RF-M1-18, EC-M1-11, EC-M1-13, EC-M1-14). Botón "Volver" en la cabecera de las pantallas internas (RF-M2-13, EC-M2-04) y logo de la app (RF-M2-14). Rendimiento de cada pestaña (RNF-29). 3 escenarios Gherkin nuevos (56 en total). |
