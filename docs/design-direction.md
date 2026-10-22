# Dirección visual de la web

**Decidida el 2026-10-19 con el usuario.** Aplica a toda pantalla y componente de `apps/web`. Si algo cambia, se edita este documento en su propio commit `docs:`.

## Estética y tono

**Minimalista neutro.** Una app de dinero para el día a día en celular: calma, mucho aire y casi ningún adorno. El color lo ponen la marca (poco) y las categorías (donde corresponde); todo lo demás es neutro. Sin degradados, sin sombras decorativas, sin ilustraciones de relleno.

- La jerarquía sale del tamaño y del peso de la letra, no de cajas ni colores.
- Bordes de 1 px (`--border`) para separar; las sombras solo en elementos que flotan (menús, hojas, diálogos).
- Una sola cosa memorable por pantalla: el monto o el estado principal, grande y alineado.

## Tema

Claro y oscuro, y el valor por defecto es el del sistema (`theme = system`). Los fondos NO se tocan: `--background` es `0 0% 100%` en claro y `222.2 84% 4.9%` en oscuro, porque el contraste AA de los 12 colores de categoría se mide contra ellos (`THEME_BACKGROUND`).

## Color de marca: verde azulado profundo

Solo para la acción principal, los enlaces y el foco. Los 12 colores de `PALETTE` son de las categorías, no de la marca.

| Token (`index.css`) | Claro | Oscuro |
|---|---|---|
| `--primary` | `168 60% 24%` | `168 48% 52%` |
| `--primary-foreground` | `0 0% 100%` | `222.2 84% 4.9%` |
| `--ring` | `168 60% 24%` | `168 48% 52%` |

El resto de tokens de shadcn (`--secondary`, `--muted`, `--accent`, `--border`, `--input`, `--destructive`) se queda en los neutros actuales. `--destructive` es solo para errores y acciones que borran, nunca para "gasto".

## Tipografía: IBM Plex Sans

Una sola familia, pesos 400, 500 y 600, cargada desde Google Fonts con `font-display: swap`. Pila: `"IBM Plex Sans", system-ui, sans-serif`.

- **Montos y cifras:** `font-variant-numeric: tabular-nums` siempre, alineadas a la derecha en listas y tablas.
- **Escala:** cuerpo 16 px (nunca menos en celular), texto secundario 14 px, títulos de pantalla 24 px / 600, monto destacado 32 px / 600.
- **Mayúsculas:** frases en minúscula (sentence case). Sin etiquetas en mayúsculas ni encabezados decorativos sobre los títulos.
- Líneas de texto de menos de 80 caracteres.

## Forma y densidad

- Radio base `--radius: 0.5rem` en todo; los controles pequeños (casillas, insignias) usan `calc(var(--radius) - 2px)`.
- Densidad cómoda, celular primero: objetivos táctiles de al menos 44 px de alto, 16 px de margen lateral, espaciado en múltiplos de 4 px.
- Una columna en celular. En escritorio (≥ 1024 px) el contenido se centra con un ancho máximo cómodo; no se estira.

## Reglas de componentes y pantallas

- Usar los componentes de shadcn/ui tal cual, con estos tokens. No crear variantes de botón nuevas sin una razón en la spec.
- **Un solo botón primario por vista.** Las demás acciones, secundarias o de texto.
- **Montos:** el signo `−` (menos) va delante en gastos y el `+` en ingresos; nunca se comunica solo por color. La moneda y el formato salen de los formateadores (`useFormatters`), no se escriben a mano.
- **Formularios:** etiqueta visible encima del campo, error debajo en `--destructive` y con texto que explica cómo corregirlo. Foco visible siempre (anillo de `--ring`).
- **Estados vacíos y errores:** dicen qué pasó y qué hacer; sin disculpas ni humor. Los textos van en `locales/es-BO`, nunca en el código.
- **Movimiento:** solo como respuesta a una acción (abrir, expandir, confirmar) y breve. Sin animaciones de entrada ni efectos al pasar el cursor. Respetar `prefers-reduced-motion`.
- **Accesibilidad:** contraste AA (≥ 4,5:1), navegación completa con teclado, `aria-label` en botones de solo ícono, y los íconos de lucide-react nunca son la única señal.

## Metas (M12)

- **Anillo de progreso:** SVG de trazo de 4 px (8 px en el detalle), pista en `--muted` y avance en el color de la meta (`PALETTE`). El porcentaje va en texto dentro o al lado del anillo; el color nunca es la única señal (`role="progressbar"` con `aria-valuenow`).
- **Estado de la meta:** insignia de texto (en curso, lograda, vencida, archivada) con estilo neutro; "lograda" puede usar el color de la meta en el borde, nunca `--destructive` para "vencida".
- **Celebración:** un diálogo de shadcn con el ícono de la meta, el título y el monto logrado en 32 px / 600, y un solo botón primario para cerrarlo. Sin confeti ni animaciones propias: solo la transición del diálogo, que respeta `prefers-reduced-motion`.
