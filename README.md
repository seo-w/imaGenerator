# IMA Generator v4.0

Optimizador masivo de imágenes para cualquier sitio web.

Dado un CSV de pares *página → imagen*, la app abre cada página en un navegador headless, **mide cuánto mide realmente cada imagen en su contenedor**, y genera una versión ajustada a ese ancho más una holgura configurable. Adicionalmente controla el peso del archivo para cumplir con las alertas de Screaming Frog (< 100KB) y mejorar Core Web Vitals.

La idea central: **una imagen no debería pesar más de lo que su contenedor necesita**. Servir un JPEG de 2400px en un contenedor de 400px es el desperdicio que esta herramienta elimina.

---

## Los dos ejes de optimización

Son independientes y conviene no confundirlos:

| Eje | Qué decide | De dónde sale |
|-----|-----------|---------------|
| **Dimensión** | El ancho de salida | Medición del contenedor × holgura |
| **Peso** | La calidad de compresión | Límite en KB según la categoría de la imagen |

La dimensión manda. Si una imagen no puede bajar del límite de peso sin reducir su ancho por debajo del que necesita el contenedor, **se conserva el ancho y se reporta un `size_warning`**. Nunca se degrada la dimensión para cumplir un límite de peso.

---

## Requisitos

- Node.js 18+
- Chromium (lo instala `puppeteer` automáticamente)

## Instalación y uso

```bash
npm install
```

```bash
npm start
```

Disponible en http://localhost:3000

---

## Formato del CSV

**Las dos únicas columnas obligatorias son la de página y la de imagen.** Todo lo demás es opcional, puede venir en cualquier orden, y puede no venir.

```csv
Url,Image
https://ejemplo.com/contacto,https://ejemplo.com/img/banner.jpg
```

### Cómo se identifican las columnas

**Si hay encabezado, el mapeo es por nombre**, no por posición. Así un `Url,Image,Size` y un `Url,Image,Size,Alt Text,Hecho` funcionan igual sin configurar nada.

| Rol | Requerido | Encabezados reconocidos |
|-----|-----------|-------------------------|
| Página | **Sí** | `url`, `address`, `page`, `página`, `page url`, `dirección`, `landing` |
| Imagen | **Sí** | `image`, `imagen`, `img`, `src`, `image url`, `url de la imagen`, `source` |
| Selector | No | `selector`, `css`, `css selector`, `elemento` |
| Estado | No | `hecho`, `done`, `estado`, `status`, `listo`, `completado`, `procesado`, `revisado` |
| Tamaño | No | `size`, `tamaño`, `peso`, `bytes`, `kb`, `file size` |

La columna de imagen se resuelve **antes** que la de página: un encabezado `Image URL` contiene la palabra "url" y si no, le robaría el puesto a la columna de página.

**Sin encabezado** se asume el orden `página, imagen, selector`.

### Columna de estado

Cuando el encabezado la identifica, se consulta **solo esa columna**. Valores que saltan la fila: `true`, `verdadero`, `hecho`, `done`, `completado`, `listo`, `ok`, `sí`, `1`, `x`, `yes`. Cualquier otro valor (incluido `falso` / `FALSO`) la procesa.

> `VERDADERO`/`FALSO` es lo que escribe Excel y Google Sheets en español en las columnas booleanas — es el caso normal al abrir un export de Screaming Frog.

Sin encabezado no hay forma de saber qué columna es cuál, así que solo se acepta la **última** celda y solo con valores inequívocamente booleanos (`true`, `verdadero`, `hecho`, `done`, `completado`, `listo`). Nunca `1`, `x` ni `ok` sueltos: un `Size` de `1` byte no debe saltear una fila válida en silencio.

### Otras notas

- Delimitador auto-detectado entre `,` `;` `tab` `|`. Se elige el que produzca **más columnas** (la mediana), no el primero que dé dos — así una celda con `;` en un CSV de comas no rompe el parseo.
- El encabezado se detecta descartando primero las celdas que parecen URL, y exigiendo que el keyword sea una **palabra** del encabezado y no un substring cualquiera. Sin eso, una fila de datos con `https://sitio.com/paginas/imagenes/...` se confunde con encabezado y se pierde la primera fila.
- Se elimina el BOM y se normalizan los saltos de línea de Windows.
- La columna de selector se usa solo si su valor *parece* un selector (empieza con `.`, `#`, `[`, `*` o letra).

> **La columna 1 es lo más importante del CSV.** Si empareja una imagen con una página donde esa imagen no está, no hay contenedor que medir y el ancho de salida sale de una heurística. Ver [Cuando no se puede medir](#cuando-no-se-puede-medir).

---

## Medición: cómo funciona

### Una carga por página, no por fila

Las filas se agrupan por URL de página. Cada página se abre **una sola vez** y se inventaría por completo; después el cruce contra el CSV se hace en Node.

En lotes reales el promedio es de ~3 imágenes por página, así que agrupar reduce las cargas de navegador aproximadamente a un tercio — y la carga de página domina el tiempo total del proceso.

### Qué se inventaría

De cada página se recolectan todas las imágenes renderizadas con el rect de su contenedor:

- `<img>`: `currentSrc`, `src`, `data-src`, `data-lazy-src`, `data-original`, y **todos** los candidatos de `srcset`
- `<picture>` / `<source>`: los `srcset` se atribuyen al rect del `<img>` hermano
- `background-image`: resuelto vía **CSSOM** (se recorren las reglas que declaran `url(...)` y se consultan sus selectores), más los `style` inline. Si ninguna hoja de estilo es legible por CORS, se cae a un recorrido acotado del DOM
- `<svg><image>`

### Niveles de match

El cruce se resuelve en Node con niveles de confianza explícitos. Gana el de mayor confianza:

| Método | Confianza | Cuándo aplica |
|--------|-----------|---------------|
| `selector` | 100 | Selector CSS de la columna 3 |
| `url-exact` | 90 | URL normalizada idéntica |
| `path-exact` | 80 | Mismo pathname |
| `basename-exact` | 70 | Mismo nombre base sin extensión ni sufijos |
| `basename-normalized` | 60 | Igual sin acentos ni mayúsculas |
| `basename-contains` | 45 | Uno contiene al otro (mín. 6 caracteres) |
| `token-overlap` | 30 | ≥2 tokens compartidos y misma extensión |

Normalizaciones que se aplican a ambos lados antes de comparar:

- Percent-decoding: `10%20months%20(1).png` y `10 months (1).png` convergen
- Query string y fragmento removidos: cubre los CDN que redimensionan por URL (`?width=1280&name=...`)
- Sufijos de derivado apilados: `foto-scaled-1024x768.jpg` → `foto`
- Diacríticos: `Fibra-Óptica` → `fibra-optica`

**Ante empates gana el contenedor más grande.** Si la misma imagen aparece como thumbnail de 100px y como hero de 1200px, se genera un solo archivo: quedarse corto produce una imagen borrosa, sobrar cuesta unos KB.

### Preparación de la página

Antes de medir:

- Se bloquean fuentes, media, websockets y los dominios de analytics/ads conocidos — no afectan el layout y dominan el tiempo de carga
- Los `loading=lazy` se promueven a `eager` y los `data-src` se copian al `src`
- Se recorre la página en pasos de un viewport (hasta 14) para disparar los `IntersectionObserver` del lazy loading
- Se neutraliza el bloqueo de scroll (`overflow:hidden`) y se **ocultan** los overlays fijos que tapan el viewport

> Sobre los banners de cookies: se **ocultan**, no se aceptan. Hacer clic en "Aceptar" sería consentir en nombre de quien ejecuta la herramienta, en un sitio de terceros. Ocultar el overlay logra lo mismo para medir.

---

## Holgura

El ancho objetivo es `contenedor × factor + extra`. Configurable por lote:

| Modo | Cálculo | Contenedor 400px | Contenedor 800px | Contenedor 1400px |
|------|---------|------------------|------------------|-------------------|
| **`+100px`** (default) | `+100` | 500px | 900px | 1500px |
| `×1` | exacto | 400px | 800px | 1400px |
| `×1.5` | `×1.5` | 600px | 1200px | 2100px |
| `×2` | `×2` | 800px | 1600px | 2800px |

`+100px` es el default por compatibilidad con el comportamiento histórico, pero tiene una limitación que conviene tener presente: la holgura relativa que aporta se diluye a medida que el contenedor crece (×1.25 a 400px, ×1.07 a 1400px). Para nitidez consistente en pantallas retina (DPR 2), `×1.5` o `×2` son más coherentes — a costa de más peso.

**Nunca se agranda una imagen.** Si el original es más chico que el ancho objetivo, se conserva su tamaño.

---

## Cuando no se puede medir

Si una imagen no aparece en el inventario de su página, el ancho **no se mide**: se estima con una heurística sobre el ancho original del archivo.

| Ancho original | Ancho objetivo |
|----------------|----------------|
| > 1920px | 1600px |
| > 1200px | 1200px |
| > 800px | 800px |
| > 400px | 600px |
| ≤ 400px | sin redimensionar |

Esto queda **explícitamente marcado**, no silenciado:

- La UI muestra un badge naranja `sin medir` y el ancho con `~` adelante
- El contador **Sin medir** aparece en la barra de estadísticas
- El `mapping.csv` trae `medido=no` y el motivo en `metodo`
- Si más del 25% del lote quedó sin medir, se emite un aviso al terminar

Motivos posibles en la columna `metodo`:

| Valor | Significado |
|-------|-------------|
| `no-encontrada` | La página cargó, pero esa imagen no está en ella |
| `pagina-no-cargo` | Timeout, error de red o de navegación |
| `sin-pagina` | La fila no traía URL de página |

> Un porcentaje alto de `no-encontrada` casi siempre significa que **el CSV está mal armado**, no que la app falle. Es lo que pasa cuando el CSV se genera listando todas las imágenes referenciadas por el CSS o el tema del sitio en lugar de las que cada página renderiza: se emparejan imágenes con páginas donde no aparecen. Vale la pena revisar el CSV antes de aceptar los resultados.

---

## Categorías y límites de peso

La categoría sale del ancho objetivo (o del original, si no hay objetivo):

| Categoría | Ancho | Ejemplos |
|-----------|-------|----------|
| **Hero** | ≥ 1400px | Banners, portadas |
| **Content** | 101–1399px | Cards, imágenes de artículo |
| **Icon** | ≤ 100px | Logos, avatares |

Límites en KB por modo:

| Categoría | Conservador | **Balanced** (default) | Agresivo | Sin límite |
|-----------|------------|------------------------|----------|------------|
| Hero | 300 KB | 200 KB | 100 KB | — |
| Content | 150 KB | 100 KB | 50 KB | — |
| Icon | 50 KB | 30 KB | 20 KB | — |

### Cascada de re-compresión

Si el archivo supera su límite, se prueban calidades `82 → 70 → 55 → 40`, y en modo `auto` se comparan WebP y AVIF en cada escalón quedándose con el más chico. Se corta en cuanto uno entra bajo el límite.

Un formato que deja de responder a las bajadas de calidad (variación < 1%) se descarta para los escalones siguientes, en lugar de re-comprimirlo en vano.

Si ningún escalón alcanza el límite, se entrega el más chico obtenido con un `size_warning` que explica por qué.

---

## Formatos

| Opción | Comportamiento |
|--------|----------------|
| **WebP** (default) | Mejor balance de compatibilidad y compresión |
| **AVIF** | Máxima compresión, más lento de codificar |
| **JPEG** | Máxima compatibilidad, con mozjpeg |
| **PNG** | Con paleta cuando hay límite de peso (sin paleta, `quality` no tiene efecto) |
| **Auto** | Codifica en WebP y AVIF y elige el más chico |

Casos especiales:

- **SVG**: se conserva intacto. Rasterizarlo le quita justamente lo que lo hace valioso.
- **GIF/WebP animados**: se mantiene la animación y se fuerza WebP (el AVIF animado tiene soporte irregular).
- **Si optimizar agranda el archivo**: cuando no hay que redimensionar y ninguna versión optimizada resulta más chica que el original (típico de imágenes que el CDN ya sirve optimizadas), **se conserva el original**. Un optimizador no debe entregar un archivo más pesado que el que recibió.

---

## Salida

```
output/{proyecto}/
├── contacto/
│   ├── 001-banner.webp
│   └── 002-logo.webp
├── blog/mi-post/
│   └── 001-hero.webp
├── _inicio/              ← página raíz del dominio
├── _sin-pagina/          ← filas sin URL de página
└── mapping.csv
```

- El slug preserva la jerarquía del path: `https://x.com/blog/mi-post` → `blog/mi-post/`
- El prefijo numérico es un **contador por carpeta** (reinicia en `001` en cada slug), no el número de fila del CSV. El número de fila está en la columna `fila` del `mapping.csv`.
- Ante nombres de archivo repetidos dentro de una carpeta se agrega un sufijo `_1`, `_2`…

### mapping.csv

| Columna | Descripción |
|---------|-------------|
| `fila` | Nº de fila en el CSV original |
| `url_pagina` / `url_imagen` | URLs de entrada |
| `slug` | Subcarpeta de salida |
| `archivo` | Nombre generado (o `ERROR`) |
| `formato` | Formato de salida |
| `original_bytes` / `optimizado_bytes` | Pesos |
| `ahorro_pct` | % de ahorro (negativo si creció) |
| `ancho_original` / `ancho_final` | Dimensiones de la imagen |
| `ancho_contenedor` | **Ancho medido del contenedor** (vacío si no se midió) |
| `holgura` | Modo de holgura del lote |
| `metodo` | Método de match, o el motivo si no se midió |
| `medido` | `si` / `no` |
| `categoria` | hero / content / icon |
| `calidad` | Calidad usada |
| `size_warning` | Por qué no pudo bajar del límite |
| `error` | Mensaje de error de la fila |

Al reanudar, el `mapping.csv` se reescribe con el set **completo** (ejecuciones previas + nuevas), no solo con lo nuevo.

---

## Vista de Proyectos

`output/` **no se borra automáticamente.** La pestaña *Proyectos* permite:

- Listar los proyectos con nº de imágenes, peso en disco, ahorro y avisos (errores, sin medir, sobre límite)
- Ver las imágenes de cada proyecto agrupadas por slug, con miniatura, peso, ancho final y ancho de contenedor
- Revisar las filas que fallaron y por qué
- Re-generar el ZIP en cualquier momento
- **Borrar un proyecto a mano** (elimina imágenes, `mapping.csv` y el estado de sus batches)

Solo `uploads/` y `temp-zips/` se limpian automáticamente, a las 24h.

---

## Control de ejecución y reanudación

Cada proceso tiene un `processId` y acepta `pause`, `resume` y `stop`. El estado se verifica antes de cada imagen y antes de cada página.

Un proceso detenido queda en estado `stopped`, que **es reanudable**: al volver a cargar el mismo CSV, la app ofrece continuar desde donde quedó. Las filas ya completadas se saltan; las que dieron error se reintentan.

El estado vive en `state/`: `{batchId}.json` con los índices completados, y `{batchId}-results.jsonl` con un item por línea. Si el cliente cierra la pestaña, el proceso se detiene en lugar de seguir gastando CPU.

---

## Cache dentro del lote

Si la misma imagen se repite (un logo en 200 páginas), se descarga y optimiza **una vez**. Las repeticiones **copian el archivo ya escrito**; no se retienen buffers en memoria, así que el consumo es constante independientemente del tamaño del lote.

La clave es `url | formato | ancho objetivo | límite`, calculada después de fijar el ancho objetivo definitivo.

---

## Arquitectura

```
app.js                 # Entry point: arma el servidor Express
src/
├── config.js          # Directorios, límites, holguras, constantes
├── util.js            # URLs, slugs, rutas seguras, pMap
├── csv.js             # Parseo del CSV y escritura del mapping
├── state.js           # Persistencia de batches y reanudación
├── control.js         # Pausar / reanudar / detener
├── measure.js         # ★ Inventario de páginas y matching
├── optimize.js        # Sharp: cascada, categorías, passthrough
├── download.js        # Descarga con reintentos y Referer
├── pipeline.js        # Orquestación del lote
├── projects.js        # Explorar y borrar proyectos
├── zip.js             # Empaquetado
├── cleanup.js         # Limpieza de directorios efímeros
└── routes.js          # Rutas HTTP
public/
├── index.html         # UI (CSS inline)
└── app.js             # Lógica del frontend
```

### Endpoints

| Método | Endpoint | Descripción |
|--------|----------|-------------|
| GET | `/api/options` | Opciones de holgura y límite disponibles |
| POST | `/api/process` | Procesa un CSV (SSE) |
| POST | `/api/control/:processId` | `pause` / `resume` / `stop` |
| POST | `/api/check-state` | ¿Hay un batch reanudable para este CSV? |
| GET | `/api/batches` | Lista de batches |
| DELETE | `/api/batches/:batchId` | Borra el estado de un batch |
| GET | `/api/projects` | Lista de proyectos con métricas |
| GET | `/api/projects/:name` | Detalle: imágenes por slug + errores |
| GET | `/api/projects/:name/file/*` | Sirve una imagen del proyecto |
| GET | `/api/projects/:name/download` | ZIP del proyecto, generado al pedido |
| DELETE | `/api/projects/:name` | Borra el proyecto |
| GET | `/api/output/*` | Sirve una imagen por ruta (soporta slugs anidados) |
| GET | `/api/download/:batchId.zip` | ZIP del batch |

Las rutas que sirven archivos resuelven el path y verifican que quede dentro del directorio permitido antes de leer.

### Eventos SSE

| Evento | Descripción |
|--------|-------------|
| `start` | Inicio: total, delimitador detectado, opciones del lote |
| `resume` | Reanudación: cuántas ya estaban completadas |
| `page` | Página inventariada: nº de imágenes encontradas vs. pedidas |
| `progress` | Estado actual (`measuring`, `downloading`, `optimizing`, `packaging`) |
| `item` | Resultado de una imagen |
| `stopped` | Detenido por el usuario (reanudable) |
| `complete` | Fin, con resumen y URL del ZIP |
| `error` | Error |

Se envía un comentario `: ping` cada 15s para que ningún proxy corte el stream.

---

## Variables de entorno

| Variable | Default | Descripción |
|----------|---------|-------------|
| `PORT` | `3000` | Puerto del servidor |

Las constantes de comportamiento (concurrencia, timeouts, límites, holguras) están en [src/config.js](src/config.js).

---

## Limitaciones conocidas

- **Solo se mide en desktop.** El viewport es 1920×1080 fijo. Un sitio donde una imagen se muestra más ancha en mobile que en desktop quedaría sub-dimensionada. Medir en ambos viewports y tomar el mayor está pendiente.
- **No hay soporte para páginas con login.** No se pasan cookies ni credenciales.
- **Los pseudo-elementos no se pueden medir.** Un `background-image` en `::before` / `::after` no existe en el DOM, así que no tiene rect. Esas imágenes caen en `no-encontrada`.
- **El CSV no se valida contra las páginas antes de procesar.** Recién al terminar se sabe cuántas filas no se pudieron medir.

---

## Solución de problemas

### "El CSV no tiene filas válidas"

El mensaje incluye cuántas filas se leyeron y qué delimitador se detectó. Verificar que haya al menos dos columnas con contenido.

### Muchas imágenes salen "sin medir"

El caso más común, y casi siempre es el CSV. Verificar en el navegador que la imagen esté realmente en la página que dice la columna 1. Si está pero como `background-image` de un pseudo-elemento, no hay forma de medirla: usar la columna `selector` apuntando al contenedor.

### Una imagen no baja del límite de peso

Es el comportamiento esperado cuando el contenedor es grande: la dimensión tiene prioridad sobre el peso. Para heros de 1400px+ es normal superar 100KB — usar modo *Conservador*. El `size_warning` del `mapping.csv` explica el caso concreto.

### Una imagen quedó más grande que el original

No debería pasar: si no hay que redimensionar y optimizar la agranda, se conserva el original y se anota en `note`. Si aparece con `+%` en la tabla es porque **sí** hubo redimensionado y aun así creció, lo que indica un original con compresión muy agresiva.

### El ZIP del batch da 404

Los ZIP de `temp-zips/` se limpian a las 24h. El proyecto sigue en `output/`: descargarlo desde la pestaña *Proyectos*, que lo regenera.

### Puppeteer no arranca

Si falla el lanzamiento del navegador, el lote continúa sin medir (todo cae a la heurística) y se emite un `error` explicándolo. Reinstalar Chromium con `npx puppeteer browsers install chrome`.

---

## Changelog

### v4.0

**Motor de medición reescrito**

- Las filas se agrupan por página: **una carga de navegador por página** en lugar de una por fila (~3× menos cargas en lotes reales).
- El matching se movió de `page.evaluate` a Node, con niveles de confianza explícitos y testeable de forma aislada.
- Corregido el bug de encoding que impedía todo match cuando la URL traía caracteres escapados: el nombre del CSV se comparaba percent-encoded (`10%20months%20(1)`) contra el del DOM decodificado (`10 months (1)`).
- Los `background-image` se resuelven vía CSSOM en lugar de `querySelectorAll('*')` + `getComputedStyle` por elemento.
- Se recolectan todos los candidatos de `srcset`, no solo el primero.
- Nuevos motivos explícitos cuando no se puede medir (`no-encontrada`, `pagina-no-cargo`, `sin-pagina`) en lugar de un `fallback-resize` genérico, más aviso cuando supera el 25% del lote.

**Bugs corregidos**

- **Detener rompía la reanudación**: el batch se marcaba `completed` incluso al detenerse, así que `check-state` no lo encontraba nunca. Ahora queda `stopped`, que es reanudable.
- **Pausar y luego detener colgaba el proceso**: la Promise de pausa solo se resolvía al pasar a `running`, nunca a `stopped`.
- **"Sin límite" no hacía nada**: el frontend enviaba `aggressiveness=none` y el backend leía un parámetro `sizeLimit` que nunca llegaba; `limits['none']` caía a `balanced`. Se aplicaban los límites de Balanced en silencio.
- **Todas las descargas individuales daban 404**: apuntaban a `/api/output/{archivo}` con un solo segmento de ruta, pero las imágenes viven en `{proyecto}/{slug}/{archivo}`.
- **Path traversal** en `/api/output/:filename`: `..%2f..%2f..%2f..%2f..%2fetc%2fpasswd` servía cualquier archivo del disco. Ahora se resuelve el path y se verifica que quede dentro del directorio permitido.
- **La categoría se calculaba siempre mal**: usaba `widthOriginal` doce líneas antes de asignarla, así que valía `undefined`. Una imagen sin medición ni fallback caía en `icon` y se comprimía a 30KB.
- **El `mapping.csv` se perdía al reanudar**: se reescribía solo con las filas nuevas.
- **La clave de cache se calculaba antes del fallback de ancho**, así que la tabla reportaba `original` en imágenes que sí se habían redimensionado.
- **La limpieza automática borraba `output/` a las 24h** — y encima fallaba en silencio con slugs anidados (`blog/mi-post`), porque hacía `unlink` sobre un directorio. Ya no se toca `output/`.
- **Consumo de memoria sin techo**: el cache retenía el buffer de cada imagen optimizada del lote (≈600MB en un lote de 1155). Ahora guarda la ruta y copia el archivo.
- **La detección de delimitador elegía mal**: tomaba el primero que diera 2 columnas, así que una celda con `;` en un CSV de comas rompía el parseo. Ahora gana el que produzca más columnas.
- **Los AVIF se guardaban como `.heif`**: Sharp reporta `info.format = 'heif'` para AVIF (que es un contenedor HEIF), y ese valor se usaba como nombre de formato y extensión. El nombre canónico ahora es el formato pedido.
- **Un CSV sin encabezado perdía su primera fila**: `isHeaderRow` buscaba keywords como substring en las dos primeras celdas, así que una URL con `/paginas/` o `/imagenes/` se detectaba como encabezado. Ahora se descartan primero las celdas que parecen URL y el keyword tiene que ser una palabra completa del encabezado.
- **El mapeo de columnas era posicional**: la columna 3 se evaluaba como selector-o-estado y la 4 como estado. Con un `Url,Image,Size` el tamaño se leía como estado, y con un `Url,Image,Size,Alt,Hecho` se leía `Alt` como estado ignorando `Hecho`. Ahora, si hay encabezado, las columnas se identifican **por nombre** en cualquier orden y con cualquier cantidad de columnas extra.
- **`VERDADERO` no se reconocía como fila hecha**: Excel y Google Sheets en español escriben `VERDADERO`/`FALSO` en las columnas booleanas, así que marcar filas como hechas no tenía ningún efecto y se reprocesaban todas.

**Nuevo**

- **Selector de holgura**: `+100px` (default), `×1`, `×1.5`, `×2`.
- **Vista de Proyectos**: explorar los proyectos procesados con miniaturas y métricas, re-descargar el ZIP y borrarlos a mano.
- **Columna "Contenedor"** en la tabla de resultados: ancho medido → ancho objetivo.
- **Contador "Sin medir"** en las estadísticas.
- Los SVG se conservan intactos en lugar de rasterizarse.
- Los GIF/WebP animados conservan la animación.
- Si optimizar agranda el archivo, se conserva el original.
- `Referer` en las descargas: varios CDN devuelven 403 sin él.
- Se detecta cuando el servidor responde HTML en lugar de una imagen, en lugar de fallar más tarde con un error confuso de Sharp.
- No se reintentan errores permanentes (404, 403, 410).
- Descarga y optimización con concurrencia 4 dentro de cada página.
- Se bloquean fuentes, media y dominios de analytics durante la medición.
- `.gitignore` (el repo tenía `node_modules` versionado: 6281 archivos).

**Optimizaciones**

- Se eliminaron los `sharp().metadata()` redundantes: las dimensiones finales salen del `info` que Sharp ya devuelve, sin un decode extra por candidato.
- PNG usa paleta cuando hay límite de peso; antes `quality` no tenía efecto y la cascada re-comprimía cuatro veces un buffer idéntico.
- AVIF con `effort: 4` en lugar de 6: el ahorro extra era marginal y costaba el doble de CPU.
- Un formato que deja de responder a las bajadas de calidad se descarta para los escalones siguientes.
- El estado del batch se vuelca a disco como máximo una vez por segundo, en lugar de serializar el array de índices en cada imagen.

**Estructura**

- `app.js` pasó de 1668 líneas con todo mezclado a un entry point de ~35 líneas, con la lógica en 12 módulos bajo `src/`.
- Código muerto eliminado: `createZip` (deprecado), `formatFromCMS` (devolvía siempre `'auto'`), `slugKey` (se calculaba y no se usaba), `aggressiveFallback` (declarado y nunca leído).

**Documentación**

Se quitaron del README tres features que estaban documentadas pero no implementadas:

- *Detección de formato por CMS* (WordPress→AVIF, HubSpot→WebP): `detectCMS()` funcionaba pero su resultado se descartaba.
- *Prefijo de dominio ante colisiones de slug*: la clave se calculaba pero nunca se usaba para la carpeta.
- *"El prefijo numérico corresponde al número de fila del CSV"*: es un contador por carpeta.

### v3.0.1

Bugfix: `result is not defined` al procesar imágenes desde el cache. La variable solo existía dentro del `try` de la rama de descarga, pero se referenciaba en la construcción del item y del mapping.

---

## Licencia

MIT
