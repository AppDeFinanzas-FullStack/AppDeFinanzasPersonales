# Latencia del despliegue: regiones y pooler

Registro de TASK-260 (plan §4.0 y §1.5; RNF-03 y RNF-29). Explica por qué el API y la base de datos van en la misma región y con qué parámetros se conectan.

## Regiones

| Pieza                | Región antes               | Región ahora               |
| -------------------- | -------------------------- | -------------------------- |
| Base de datos (Neon) | `aws-us-east-1` (Virginia) | `aws-us-east-1` (Virginia) |
| API (Render)         | Oregón                     | `virginia`                 |

Neon no cambió. Lo que se movió fue Render.

## Motivo

El tiempo de una lectura es, sobre todo, el número de viajes secuenciales a la base multiplicado por la latencia entre el API y Neon. Con regiones distintas, cada una de las decenas de consultas de una petición paga entre 50 y 150 ms; en la misma región, el viaje es de pocos milisegundos. Era la causa que más pesaba en la lentitud de las pestañas.

Se movió Render y no Neon porque el API no guarda datos: mover Neon exige crear un proyecto nuevo y restaurar la base.

## Servicio nuevo

Render no cambia de región un servicio existente, así que se creó uno nuevo a mano en Virginia:

- **Nuevo:** `finanzas-api-va`, en <https://finanzas-api-va.onrender.com>.
- **Viejo:** `finanzas-api-u3vu`, en Oregón. Queda para apagar.

`render.yaml` fija `name: finanzas-api-va` y `region: virginia`; `vercel.json` apunta el _rewrite_ de `/api/:path*` a la URL nueva, y la tabla de despliegue del `README.md` la cita. En el Environment `production` de GitHub hay que tener actualizados `API_URL`, `RENDER_DEPLOY_HOOK_URL` y `RENDER_SERVICE_ID` con los del servicio nuevo.

## Parámetros de `DATABASE_URL`

La variable `DATABASE_URL` de Render (se carga en el panel, no en el repositorio) debe cumplir:

- **Host con `-pooler`:** el pooler de Neon (PgBouncer en modo transacción).
- **`sslmode=require`:** la conexión va cifrada.
- **`pgbouncer=true`:** Prisma deja de usar sentencias preparadas, que PgBouncer en modo transacción no admite.
- **`connection_limit=5`:** conexiones suficientes para las lecturas que corren en paralelo, sin agotar el límite del plan gratis.

Forma esperada: el host de Neon con `-pooler` después del nombre del endpoint (el texto que ve Neon como _Pooled connection_) y, al final, `?sslmode=require&pgbouncer=true&connection_limit=5`. No se copia aquí un ejemplo completo para no guardar nunca una URL con contraseña en el repositorio.

Si falta algo, se corrige en Render y se reinicia el servicio. Las migraciones no pasan por aquí: usan la conexión directa (`DATABASE_URL_DIRECT`).

## Tiempos medidos

**Los tiempos `db` de `GET /api/health/ready` no se midieron, ni antes ni después del cambio de región**, por decisión de la persona responsable. No hay cifras que comparar; el beneficio esperado se deduce de la latencia entre regiones, no de una medición.

## Cómo medirlos

Cada respuesta lleva la cabecera `Server-Timing` con `total`, `db` y `queries` (plan §4.0).

1. Abrir la web en producción con las herramientas del navegador (pestaña Network).
2. Ir a `https://<WEB_URL>/api/health/ready`.
3. Anotar el valor `db` de la cabecera `Server-Timing`, tres veces. Se descarta la primera si el servicio estaba dormido.
4. Interpretarlo: en la misma región debería ser de unos pocos milisegundos, y la meta es **menos de 10 ms**. Decenas de milisegundos o más indican regiones distintas o una conexión mal configurada.

Para comparar, repetir la medición con el servicio anterior y anotar ambos resultados en esta página.

## Mantener despiertos los servicios

En el plan gratis, Render duerme el API tras 15 minutos sin tráfico y Neon suspende la base tras 5. Una medición con el servicio dormido incluye el arranque y no sirve. En cron-job.org, el tick debe seguir llamando cada minuto a `POST /internal/jobs/tick`.
