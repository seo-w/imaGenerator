# IMA Generator v3.0

Aplicación web para optimización masiva de imágenes. Lee un CSV con URLs de páginas e imágenes, mide el tamaño real de cada imagen en su contenedor, y genera versiones optimizadas en el formato más adecuado. Incluye optimización inteligente con límites de tamaño automáticos para cumplir con las alertas de Screaming Frog (< 100KB) y mejorar Core Web Vitals.

## Características Principales

- **Procesamiento por CSV**: Soporta archivos CSV con delimitador coma (`,`) o punto y coma (`;`)
- **Detección automática de encabezados**: Identifica y salta la fila de encabezados automáticamente
- **Medición con Puppeteer**: Abre cada página en un navegador headless y mide el tamaño real de la imagen
- **Formatos de salida**: WebP, AVIF, JPEG, PNG, o detección automática por CMS
- **Optimización inteligente con límites**: Re-compresión automática en cascada si la imagen supera el límite de tamaño (calidad 82 → 70 → 55 → 40 + cambio de formato)
- **Categorización automática**: Detecta si la imagen es hero, contenido o icono y aplica límites diferentes
- **Cache inteligente**: Si una imagen se repite en el CSV, solo se descarga y optimiza una vez
- **Progreso en tiempo real**: Server-Sent Events (SSE) muestran el avance imagen por imagen
- **Controles de ejecución**: Pausar, reanudar o detener el proceso en cualquier momento
- **Descarga masiva**: Genera un ZIP con todas las imágenes optimizadas
- **Organización por proyecto**: Cada CSV genera su carpeta con subcarpetas por slug de URL
- **Mapping CSV**: Trazabilidad completa de cada imagen procesada con categoría, calidad y warnings
- **UI responsive**: Diseño adaptativo para móvil, tablet y desktop
- **Indicadores visuales**: Filas coloreadas (amarillo/rojo) para imágenes sobre el límite, badges de categoría y calidad
- **Fallback automático**: Si AVIF falla, cae automáticamente a WebP

## Requisitos

- Node.js 18+
- Dependencias listadas en `package.json`

## Instalación

```bash
npm install
```

## Uso

```bash
npm start
```

La aplicación estará disponible en http://localhost:3000

## Formato del CSV

El archivo CSV debe tener al menos 2 columnas:

```csv
url,imagen,selector
https://ejemplo.com/pagina,https://ejemplo.com/imagen.jpg,.clase-imagen
```

### Columnas:

1. **url** (requerida): URL de la página donde se encuentra la imagen
2. **imagen** (requerida): URL directa de la imagen a optimizar
3. **selector** (opcional): Selector CSS para encontrar la imagen en la página

### Notas:

- Se aceptan tanto comas (`,`) como punto y coma (`;`) como separadores
- La primera fila se detecta automáticamente como encabezado y se ignora
- Si no hay selector, la app busca la imagen por su URL en el DOM

## Arquitectura

### Backend (`app.js`)

#### Dependencias

- **express**: Servidor web
- **multer**: Upload de archivos CSV
- **sharp**: Optimización de imágenes
- **puppeteer**: Navegación headless para medir tamaños
- **csv-parse**: Parseo de archivos CSV
- **archiver**: Generación de archivos ZIP

#### Endpoints

| Método | Endpoint | Descripción |
|--------|----------|-------------|
| POST | `/api/process` | Inicia el procesamiento de imágenes vía SSE |
| POST | `/api/control/:processId` | Controla un proceso en ejecución (pause/resume/stop) |
| GET | `/api/output/:filename` | Descarga una imagen optimizada individual |
| GET | `/api/download/:batchId.zip` | Descarga el ZIP con todas las imágenes |
| GET | `/api/projects` | Lista todos los proyectos disponibles |
| POST | `/api/check-state` | Verifica si hay un batch incompleto para un CSV |
| GET | `/api/batches` | Lista todos los batches (completados e incompletos) |

#### Flujo de Procesamiento

1. **Parseo del CSV**: Detección automática del delimitador y validación de columnas
2. **Creación del navegador**: Un solo browser Puppeteer para todo el lote
3. **Creación de carpeta de proyecto**: Se crea `output/{nombre-proyecto}/`
4. **Por cada fila**:
   - Verifica estado de control (paused/stopped)
   - Mide la imagen en la página (si hay URL de página)
   - Descarga la imagen original
   - Optimiza con Sharp al formato seleccionado
   - Guarda en subcarpeta según slug de la URL
   - Envía evento SSE al cliente
5. **Generación de mapping.csv**: Traza completa de todas las imágenes procesadas
6. **Generación de ZIP**: Crea un ZIP con la carpeta completa del proyecto
7. **Limpieza**: Auto-limpieza de archivos temporales cada hora

#### Eventos SSE

| Evento | Descripción |
|--------|-------------|
| `start` | Inicio del procesamiento con total de imágenes |
| `progress` | Actualización de progreso con estado actual |
| `item` | Resultado de una imagen procesada |
| `stopped` | Proceso detenido por el usuario |
| `complete` | Proceso finalizado con resumen y URL del ZIP |
| `error` | Error durante el procesamiento |

### Frontend (`public/`)

#### Tecnologías

- HTML5 semántico
- CSS3 con variables CSS y Grid/Flexbox
- JavaScript vanilla (ES6+)
- Server-Sent Events para comunicación en tiempo real

#### Componentes

- **Dropzone**: Área de arrastrar y soltar con feedback visual
- **Selector de formato**: WebP, AVIF, JPEG, PNG, o Auto
- **Selector de límite**: Balanced (default), Conservador, Agresivo, Sin límite
- **Controles de ejecución**: Pausar, Reanudar, Detener
- **Barra de progreso**: Con animación shimmer y porcentaje
- **Panel de logs**: Terminal en tiempo real con colores
- **Tabla de resultados**: Scroll horizontal en móvil, filas coloreadas por estado
- **Estadísticas**: Total, optimizadas, errores, sobre límite, espacio ahorrado
- **Toast notifications**: Mensajes temporales sin alerts

#### Responsive Breakpoints

- **Mobile** (< 640px): Layout de una columna, controles táctiles grandes
- **Tablet** (640px - 1023px): Tabla con scroll horizontal
- **Desktop** (>= 1024px): Sidebar sticky + contenido principal

## Formato de Salida

### Nombre del Proyecto

Al cargar un CSV, se propone un nombre de proyecto basado en el nombre del archivo. El usuario puede editarlo antes de iniciar el procesamiento. Las imágenes se organizan en:

```
output/{proyecto}/
├── {slug-pagina-1}/
│   ├── 001-imagen.webp
│   └── 002-logo.webp
├── {slug-pagina-2}/
│   └── 003-hero.webp
└── mapping.csv
```

### Subcarpetas por Slug

Cada URL de página genera una subcarpeta basada en su path:
- `https://ejemplo.com/contacto` → `contacto/`
- `https://ejemplo.com/blog/mi-post` → `blog/mi-post/`
- Sin URL de página → `_sin-pagina/`

Si dos dominios distintos tienen el mismo slug, se prefija con el dominio para evitar colisiones:
- `https://sitio1.com/contacto` → `sitio1-com/contacto/`
- `https://sitio2.com/contacto` → `sitio2-com/contacto/`

### Prefijo Numérico

Cada archivo lleva un prefijo de 3 dígitos que corresponde al número de fila en el CSV, facilitando la identificación: `001-banner.webp`, `002-logo.webp`, etc.

### Mapping CSV

Cada proyecto incluye un `mapping.csv` con la trazabilidad completa:

| Columna | Descripción |
|---------|-------------|
| `fila` | Número de fila en el CSV original |
| `url_pagina` | URL de la página donde se encontró la imagen |
| `url_imagen` | URL original de la imagen |
| `slug` | Subcarpeta donde se guardó |
| `archivo` | Nombre del archivo generado |
| `formato` | Formato de salida (webp, avif, jpeg, png) |
| `original_bytes` | Tamaño original en bytes |
| `optimizado_bytes` | Tamaño optimizado en bytes |
| `ahorro_pct` | Porcentaje de ahorro |
| `metodo` | Método de detección usado |
| `categoria` | Categoría detectada: hero, content, icon |
| `calidad` | Calidad de compresión usada (1-100) |
| `size_warning` | Mensaje de advertencia si no se pudo bajar del límite |

### Selección Manual

El usuario puede elegir el formato global para todo el lote:

- **Auto**: Detecta el CMS de la URL y elige el formato óptimo
- **WebP**: Mejor balance de calidad/compresión (default)
- **AVIF**: Máxima compresión, puede no ser soportado por todos los navegadores
- **JPEG**: Máxima compatibilidad
- **PNG**: Sin pérdida de calidad

### Detección Automática por CMS

| CMS | Formato |
|-----|---------|
| WordPress (`wp-content`, `wordpress`, `wp.com`) | AVIF (con fallback a WebP) |
| HubSpot (`hubspot`, `hs-scripts`, `hubspotusercontent`) | WebP |
| Otros / Auto | WebP |

## Optimización Inteligente con Límites

### Categorización Automática

El sistema clasifica cada imagen según su tamaño medido en la página:

| Categoría | Ancho medido | Descripción |
|-----------|-------------|-------------|
| **Hero** | ≥ 1400px | Banners principales, imágenes de portada |
| **Content** | 101-1399px | Imágenes de contenido, cards, sidebar |
| **Icon** | ≤ 100px | Logos, iconos, avatares |

### Límites de Tamaño por Modo

| Categoría | Conservador | Balanced (default) | Agresivo |
|-----------|------------|-------------------|----------|
| Hero | 300 KB | 200 KB | 100 KB |
| Content | 150 KB | 100 KB | 50 KB |
| Icon | 50 KB | 30 KB | 20 KB |

### Estrategia de Re-compresión en Cascada

Cuando una imagen supera el límite, el backend intenta automáticamente:

1. **Calidad 82** → conversión inicial
2. **Calidad 70** → si supera el límite
3. **Calidad 55** → si sigue superando
4. **Calidad 40** → último intento antes de fallback
5. **Cambio de formato** → WebP vs AVIF, elige el más pequeño en cada paso

**Importante**: Las dimensiones NUNCA se reducen por debajo del tamaño medido + 100px (buffer retina). Esto garantiza que la imagen no quede pixelada al implementarla.

### Indicadores Visuales en la UI

| Estado | Color | Descripción |
|--------|-------|-------------|
| ✅ Normal | Blanco | Imagen dentro del límite |
| ⚠️ Warning | Amarillo | Imagen sobre el límite pero optimizada al máximo posible |
| ❌ Crítico | Rojo | Imagen > 300KB, no se pudo reducir significativamente |

### Badges en la Tabla de Resultados

- **Categoría**: `HERO`, `CONTENT`, `ICON` — tipo de imagen detectado
- **Calidad**: `q55`, `q70`, etc. — calidad de compresión usada (solo si < 82)
- **Size Warning**: `⚠ 145KB` — tamaño final cuando supera el límite (hover para ver detalle)

## Control de Ejecución

Cada proceso recibe un `processId` único. El endpoint `/api/control/:processId` acepta:

- **pause**: Pausa el proceso después de la imagen actual
- **resume**: Reanuda un proceso pausado
- **stop**: Detiene el proceso definitivamente

El estado se verifica antes de procesar cada imagen, permitiendo una respuesta inmediata.

## Cache de Imágenes

Para evitar descargas redundantes, se implementa un cache en memoria:

- **Key**: `imageUrl|format|targetWidth`
- **Valor**: Buffer optimizado + metadata
- **Beneficio**: Si el mismo CSV tiene imágenes repetidas (como logos), solo se descargan una vez

## Directorios

```
imaGenerator/
├── app.js                 # Backend Express
├── package.json           # Dependencias
├── public/
│   ├── index.html        # UI principal
│   └── app.js            # Lógica del frontend
├── uploads/              # CSVs temporales (auto-limpieza)
├── output/               # Imágenes optimizadas organizadas por proyecto
│   ├── mi-proyecto/
│   │   ├── contacto/
│   │   │   ├── 001-banner.webp
│   │   │   └── 002-logo.webp
│   │   ├── nosotros/
│   │   │   └── 003-hero.webp
│   │   └── mapping.csv
│   └── otro-proyecto/
│       └── ...
├── temp-zips/            # ZIPs temporales (auto-limpieza)
└── state/                # Estado de batches para reanudación
```

## Variables de Entorno

| Variable | Default | Descripción |
|----------|---------|-------------|
| `PORT` | `3000` | Puerto del servidor |

## Solución de Problemas

### "El CSV no tiene filas válidas"

- Verificar que el CSV tenga al menos 2 columnas
- Asegurarse de que el separador sea coma (`,`) o punto y coma (`;`)
- La primera fila puede ser encabezados (se detecta automáticamente)

### Puppeteer no encuentra la imagen

- Agregar un selector CSS en la tercera columna del CSV
- Verificar que la imagen esté cargada en el DOM (no lazy-loaded sin scroll)
- La app hace scroll automático para trigger lazy loading

### AVIF falla

- El formato cae automáticamente a WebP
- Para forzar WebP, seleccionarlo manualmente en el dropdown

### Imagen supera el límite de tamaño

- El sistema intenta automáticamente múltiples niveles de compresión
- Si no puede bajar del límite, la fila se marca en amarillo (warning) o rojo (crítico)
- El `mapping.csv` incluye la columna `size_warning` con la explicación
- Para imágenes hero > 1400px, es normal que superen 100KB — usar modo "Conservador"
- Para contenido general, el modo "Balanced" (100KB) cumple con Screaming Frog
- El modo "Agresivo" es para sitios con requisitos estrictos de rendimiento

## Changelog

### v3.0.1 (2026-05-28)

**Bugfix: `result is not defined` en procesamiento con cache**

- **Problema**: Al procesar imágenes que ya estaban en cache, el backend lanzaba `ReferenceError: result is not defined` al guardar el archivo.
- **Causa**: La variable `result` solo existía dentro del bloque `try` del branch de descarga/optimización. Cuando una imagen venía del cache (branch `if (cached)`), esa variable nunca se definía, pero se referenciaba en 3 lugares fuera del scope:
  - Construcción de `successItem` (líneas 1405, 1407)
  - Construcción de `mappingRows` (líneas 1431-1433)
- **Fix**: Reemplazar todas las referencias a `result?.*` por `cacheEntry?.*`, leyendo directamente del cache (`imageCache.get(cacheKey)`) que siempre está populado en ambos caminos (cache hit o miss).

## Licencia

MIT
