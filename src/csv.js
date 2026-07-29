/**
 * Parseo del CSV de entrada y escritura del mapping.csv de salida.
 */

import { parse } from 'csv-parse/sync';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { sanitizeUrl } from './util.js';

/** Palabras que delatan una fila de encabezados. */
const HEADER_KEYWORDS = [
  'url', 'page', 'pagina', 'página', 'image', 'imagen', 'img', 'size',
  'tamano', 'tamaño', 'width', 'height', 'selector', 'status', 'estado',
  'hecho', 'done', 'address',
];

/**
 * Valores que marcan una fila como ya procesada.
 * Incluye `verdadero`: Excel en español escribe VERDADERO/FALSO en las
 * columnas booleanas, y es el formato que sale de los reportes de SF
 * abiertos en Excel o Google Sheets en español.
 */
const DONE_VALUES = new Set([
  'true', 'verdadero', 'vrai', 'wahr', '1', 'x',
  'hecho', 'done', 'completado', 'listo', 'ok', 'sí', 'si', 'yes',
]);

/** Valores que explícitamente marcan la fila como NO procesada. */
const NOT_DONE_VALUES = new Set(['false', 'falso', 'faux', 'falsch', '0', 'no', 'pendiente', '']);

/** Un selector CSS plausible empieza con `.`, `#`, letra, `[` o `*`. */
const SELECTOR_SHAPE = /^[.#a-zA-Z[*]/;

/**
 * Patrones de encabezado por rol de columna.
 *
 * Las dos únicas columnas obligatorias son la de página y la de imagen;
 * todo lo demás es opcional y puede venir en cualquier orden o no venir.
 * Por eso el mapeo se hace por NOMBRE y no por posición: un CSV
 * `Url,Image,Size` tiene el tamaño en la posición 3, y un
 * `Url,Image,Size,Alt,Hecho` tiene el estado en la 5.
 */
const COLUMN_PATTERNS = {
  // Se evalúa antes que `page` para que "Image URL" no gane como página
  image: /^(image|imagen|img|src|image ?url|url ?(de ?la ?)?imagen|source)$/i,
  page: /^(url|address|page|p[áa]gina|url ?(de ?la ?)?p[áa]gina|page ?url|direcci[óo]n|landing)$/i,
  selector: /^(selector|css|css ?selector|elemento)$/i,
  status: /^(hecho|done|estado|status|listo|completado|procesado|ok\?|revisado)$/i,
  size: /^(size|tama[ñn]o|peso|bytes|kb|file ?size)$/i,
};

/**
 * Deduce el rol de cada columna a partir del encabezado.
 *
 * @param {string[]} header - Fila de encabezados
 * @returns {Object|null} Índices por rol, o null si no identifica página+imagen
 */
export function mapColumns(header) {
  const names = header.map(h => String(h || '').trim());
  const found = {};

  // La imagen se resuelve primero: "Image URL" contiene "url" y le robaría
  // el puesto a la columna de página si se evaluara al revés.
  for (const role of ['image', 'page', 'selector', 'status', 'size']) {
    const index = names.findIndex((name, i) =>
      !Object.values(found).includes(i) && COLUMN_PATTERNS[role].test(name));
    if (index !== -1) found[role] = index;
  }

  if (found.page === undefined || found.image === undefined) return null;
  return found;
}

/** Una celda que parece URL o ruta: nunca es un encabezado. */
function looksLikeUrl(cell) {
  return /^(https?:)?\/\//i.test(cell) || cell.includes('://') || /^\/[^\s]/.test(cell);
}

/**
 * Detecta si la primera fila son encabezados.
 *
 * El descarte por URL va primero y es lo que hace fiable la detección: sin
 * él, una fila de datos con `https://sitio.com/paginas/imagenes/...` se
 * confunde con un encabezado (contiene "pagina" y "imagen") y se pierde la
 * primera fila del CSV.
 *
 * Además el keyword tiene que ser una palabra del encabezado, no un
 * substring en cualquier parte: "regulacion" no debería matchear por
 * contener "url" en otro contexto.
 */
export function isHeaderRow(row) {
  if (!row || row.length < 2) return false;

  const firstTwo = [row[0], row[1]].map(v => String(v || '').trim());
  if (firstTwo.some(looksLikeUrl)) return false;
  // Un encabezado es una etiqueta corta, no un valor
  if (firstTwo.some(cell => cell.length > 40)) return false;

  return firstTwo.some(cell => {
    const words = cell.toLowerCase().split(/[\s_\-.]+/).filter(Boolean);
    return words.some(word => HEADER_KEYWORDS.includes(word));
  });
}

/**
 * Auto-detecta el delimitador probando cada candidato y quedándose con
 * el que produzca más columnas — no simplemente el primero que dé 2.
 *
 * El criterio anterior ("el primero con ≥2 columnas") elegía `;` en un
 * CSV separado por comas cuando alguna celda contenía un punto y coma.
 */
export function detectDelimiter(csvContent) {
  const candidates = [',', ';', '\t', '|'];
  let best = { delimiter: ',', columns: 0 };
  for (const delimiter of candidates) {
    try {
      const rows = parse(csvContent, {
        columns: false, skip_empty_lines: true, trim: true,
        delimiter, relax_column_count: true, relax_quotes: true, to: 20,
      });
      if (!rows.length) continue;
      // Mediana de columnas: robusta ante una fila suelta mal formada
      const counts = rows.map(r => r.length).sort((a, b) => a - b);
      const median = counts[Math.floor(counts.length / 2)];
      if (median > best.columns) best = { delimiter, columns: median };
    } catch { /* delimitador inválido para este archivo */ }
  }
  return best.delimiter;
}

/**
 * Parsea el CSV y devuelve las filas listas para procesar.
 *
 * @param {string} raw - Contenido crudo del archivo
 * @returns {{rows: Array, skipped: number, delimiter: string, total: number}}
 *   `rows` son objetos `{ pageUrl, imageUrl, selector, csvLine }`.
 *   `csvLine` es el número de fila en el archivo original (1-based,
 *   contando el encabezado), para poder rastrearlo en el mapping.
 */
export function parseCsv(raw) {
  let content = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (content.charCodeAt(0) === 0xFEFF) content = content.slice(1);

  const delimiter = detectDelimiter(content);
  const parsed = parse(content, {
    columns: false, skip_empty_lines: true, trim: true,
    delimiter, relax_column_count: true, relax_quotes: true,
  });

  const cleaned = parsed.map(row => row.map(cell => String(cell || '').trim()));
  const hasHeader = cleaned.length > 0 && isHeaderRow(cleaned[0]);
  const dataRows = hasHeader ? cleaned.slice(1) : cleaned;
  const lineOffset = hasHeader ? 2 : 1;

  // Con encabezado, las columnas se identifican por nombre; sin él, se
  // asume el orden documentado (página, imagen, selector).
  const columns = (hasHeader && mapColumns(cleaned[0]))
    || { page: 0, image: 1, selector: 2 };
  const mappedByName = hasHeader && !!mapColumns(cleaned[0]);

  const rows = [];
  let skipped = 0;

  dataRows.forEach((row, index) => {
    const pageUrl = sanitizeUrl(row[columns.page]);
    const imageUrl = sanitizeUrl(row[columns.image]);
    if (!pageUrl || !imageUrl) return;

    if (isMarkedDone(row, columns, mappedByName)) {
      skipped++;
      return;
    }

    const rawSelector = columns.selector !== undefined ? (row[columns.selector] || '') : '';

    rows.push({
      pageUrl,
      imageUrl,
      selector: SELECTOR_SHAPE.test(rawSelector) ? rawSelector : '',
      csvLine: index + lineOffset,
    });
  });

  return {
    rows, skipped, delimiter,
    total: dataRows.length,
    columns: mappedByName ? columns : null,
  };
}

/**
 * Decide si la fila ya está marcada como procesada.
 *
 * Con encabezado se consulta ÚNICAMENTE la columna de estado. Sin
 * encabezado no hay forma de saber qué columna es qué, así que solo se
 * acepta la última celda y solo si su valor es inequívocamente booleano —
 * de lo contrario un `Size` de `1` byte o un texto cualquiera saltearía
 * filas válidas en silencio.
 */
function isMarkedDone(row, columns, mappedByName) {
  if (mappedByName) {
    if (columns.status === undefined) return false;
    return DONE_VALUES.has(String(row[columns.status] || '').toLowerCase());
  }

  const last = String(row[row.length - 1] || '').toLowerCase();
  if (row.length <= 2) return false;
  // Solo valores booleanos explícitos, nunca `1` / `x` / `ok` sueltos
  const unambiguous = new Set(['true', 'verdadero', 'hecho', 'done', 'completado', 'listo']);
  return unambiguous.has(last);
}

// ─── mapping.csv ────────────────────────────────────────────────

/** Columnas del mapping.csv, en orden. */
export const MAPPING_COLUMNS = [
  'fila', 'url_pagina', 'url_imagen', 'slug', 'archivo', 'formato',
  'original_bytes', 'optimizado_bytes', 'ahorro_pct',
  'ancho_original', 'ancho_final', 'ancho_contenedor', 'holgura',
  'metodo', 'medido', 'categoria', 'calidad', 'size_warning', 'error',
];

/** Escapa un valor para CSV (comillas dobles duplicadas). */
function escapeCell(value) {
  const str = value === null || value === undefined ? '' : String(value);
  return `"${str.replace(/"/g, '""')}"`;
}

/**
 * Convierte un item de resultado en una fila de mapping.
 * Funciona tanto para éxitos como para errores.
 */
export function itemToMappingRow(item) {
  return {
    fila: item.csvLine ?? (item.index != null ? item.index + 1 : ''),
    url_pagina: item.pageUrl || '',
    url_imagen: item.imageUrl || '',
    slug: item.slug || '',
    archivo: item.status === 'ok' ? (item.filename || '') : 'ERROR',
    formato: item.format || '',
    original_bytes: item.originalSize ?? '',
    optimizado_bytes: item.optimizedSize ?? '',
    ahorro_pct: item.savedPercent ?? '',
    ancho_original: item.widthOriginal ?? '',
    ancho_final: item.widthResult ?? '',
    ancho_contenedor: item.containerWidth ?? '',
    holgura: item.holgura || '',
    metodo: item.measureMethod || '',
    medido: item.measured ? 'si' : 'no',
    categoria: item.imageCategory || '',
    calidad: item.qualityUsed ?? '',
    size_warning: item.sizeWarning || '',
    error: item.error || '',
  };
}

/**
 * Escribe el mapping.csv del proyecto a partir del set COMPLETO de items.
 *
 * Se reescribe entero en cada llamada, incluyendo los resultados de
 * ejecuciones previas: si solo se escribieran los items nuevos, una
 * reanudación borraría la trazabilidad del primer intento.
 */
export function writeMapping(projectDir, items) {
  if (!items.length) return null;
  const rows = items.map(itemToMappingRow);
  const lines = [
    MAPPING_COLUMNS.join(','),
    ...rows.map(row => MAPPING_COLUMNS.map(col => escapeCell(row[col])).join(',')),
  ];
  const path = join(projectDir, 'mapping.csv');
  writeFileSync(path, lines.join('\n') + '\n', 'utf-8');
  return path;
}

/**
 * Lee un mapping.csv de vuelta a objetos.
 * Lo usa la vista de Proyectos para mostrar metadatos históricos.
 */
export function readMapping(csvContent) {
  try {
    return parse(csvContent, {
      columns: true, skip_empty_lines: true, trim: true,
      delimiter: ',', relax_quotes: true, relax_column_count: true,
    });
  } catch {
    return [];
  }
}
