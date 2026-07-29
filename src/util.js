/**
 * Utilidades compartidas: normalización de URLs, slugs, rutas seguras.
 */

import { resolve, sep } from 'path';

// ─── URLs ───────────────────────────────────────────────────────

/**
 * Limpia caracteres corruptos de una URL: replacement chars (U+FFFD),
 * caracteres de control y espacios en los extremos.
 *
 * Los CSVs exportados de Screaming Frog o Excel suelen traerlos cuando
 * la URL original tenía acentos y hubo un problema de encoding.
 */
export function sanitizeUrl(url) {
  return String(url || '')
    .replace(/�/g, '')
    .replace(/[\x00-\x1F\x7F]/g, '')
    .trim();
}

/**
 * Normaliza una URL de imagen para poder compararla: sin query string,
 * sin fragmento, percent-decoded y sin barras finales.
 *
 * Decodificar es clave para el matching: el CSV puede traer
 * `10%20months%20(1).png` y el DOM `10 months (1).png` (o viceversa).
 * Ambos deben converger a la misma cadena.
 */
export function normalizeImageUrl(url) {
  const clean = sanitizeUrl(url);
  try {
    const u = new URL(clean);
    u.search = '';
    u.hash = '';
    return safeDecode(u.href).replace(/\/+$/, '');
  } catch {
    return safeDecode(clean.replace(/[?#].*$/, '')).replace(/\/+$/, '');
  }
}

/** decodeURIComponent que no explota con secuencias inválidas (`%E0%A4%A`). */
export function safeDecode(str) {
  try {
    return decodeURIComponent(str);
  } catch {
    return str;
  }
}

/**
 * Quita acentos y pasa a minúsculas, para comparar nombres de archivo.
 * "Fibra Óptica" → "fibra optica"
 */
export function normalizeTextForMatch(text) {
  return String(text || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

/**
 * Sufijos de tamaño que los CMS agregan al generar derivados.
 * WordPress: `foto-800x600.jpg` · HubSpot y otros: `foto_800x600.jpg`
 */
const SIZE_SUFFIX = /[-_]\d{2,5}x\d{2,5}$/;

/** Sufijos de densidad/escala: `foto@2x.png`, `foto-scaled.jpg` */
const SCALE_SUFFIX = /(@\d+(\.\d+)?x|[-_]scaled|[-_]thumbnail|[-_]large|[-_]medium|[-_]small)$/i;

/**
 * Extrae el nombre base de una imagen, sin extensión ni sufijos de
 * derivado, listo para comparar entre CSV y DOM.
 *
 * @example imageBaseName("https://x.com/foto-800x600.jpg") // "foto"
 * @example imageBaseName("https://x.com/10%20months%20(1).png") // "10 months (1)"
 */
export function imageBaseName(url) {
  const normalized = normalizeImageUrl(url);
  let basename;
  try {
    basename = new URL(normalized).pathname.split('/').pop() || '';
  } catch {
    basename = normalized.split('/').pop() || '';
  }
  basename = safeDecode(basename).replace(/\.\w{2,5}$/, '');
  // Los sufijos pueden venir apilados: `foto-scaled-800x600`
  let previous;
  do {
    previous = basename;
    basename = basename.replace(SIZE_SUFFIX, '').replace(SCALE_SUFFIX, '');
  } while (basename !== previous && basename.length > 0);
  return basename;
}

/** Extensión de la URL, en minúsculas y sin punto. `""` si no tiene. */
export function imageExtension(url) {
  const match = normalizeImageUrl(url).match(/\.(\w{2,5})$/);
  if (!match) return '';
  const ext = match[1].toLowerCase();
  return ext === 'jpeg' ? 'jpg' : ext;
}

/** Pathname de una URL, decodificado y en minúsculas. `""` si no parsea. */
export function urlPathname(url) {
  try {
    return safeDecode(new URL(normalizeImageUrl(url)).pathname).toLowerCase();
  } catch {
    return '';
  }
}

/**
 * Tokens significativos del nombre base, para matching parcial.
 * Descarta piezas cortas que generarían falsos positivos.
 */
export function nameTokens(url) {
  return normalizeTextForMatch(imageBaseName(url))
    .split(/[\s\-_.+]+/)
    .filter(token => token.length > 3);
}

// ─── Slugs y nombres de carpeta ─────────────────────────────────

/**
 * Slug de subcarpeta a partir de la URL de la página.
 * Preserva la jerarquía de paths para que la salida sea navegable.
 *
 * @example slugFromUrl("https://x.com/blog/mi-post") // "blog/mi-post"
 * @example slugFromUrl("https://x.com/") // "_inicio"
 */
export function slugFromUrl(url) {
  try {
    const path = new URL(sanitizeUrl(url)).pathname.replace(/^\/|\/$/g, '');
    if (!path) return '_inicio';
    return sanitizeSegment(path);
  } catch {
    const clean = sanitizeSegment(sanitizeUrl(url).replace(/^https?:\/\//, ''));
    return clean || '_sin-pagina';
  }
}

/** Sanea un path relativo conservando las barras como separador. */
function sanitizeSegment(path) {
  return safeDecode(path)
    .replace(/[^a-zA-Z0-9À-ɏ/_-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/\/+/g, '/')
    .replace(/^[/.]+|[/.]+$/g, '')
    .toLowerCase();
}

/**
 * Dominio de una URL, apto para usarse como nombre de carpeta.
 * @example domainPrefix("https://www.ejemplo.com/x") // "ejemplo-com"
 */
export function domainPrefix(url) {
  try {
    return new URL(sanitizeUrl(url)).hostname.replace(/^www\./, '').replace(/\./g, '-');
  } catch {
    return 'desconocido';
  }
}

/** Sanea el nombre de proyecto que escribe el usuario. */
export function sanitizeProjectName(name) {
  const clean = String(name || '')
    .replace(/[^a-zA-Z0-9À-ɏ\s_-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50)
    .toLowerCase();
  return clean || 'sin-nombre';
}

/** Sanea el nombre de archivo de una imagen de salida. */
export function sanitizeFilename(name) {
  return String(name || 'imagen')
    .replace(/[^a-zA-Z0-9À-ɏ._-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+/, '')
    .slice(0, 80) || 'imagen';
}

// ─── Rutas seguras ──────────────────────────────────────────────

/**
 * Resuelve `userPath` dentro de `baseDir` y verifica que no se escape.
 *
 * Express percent-decodea los parámetros de ruta, así que un
 * `..%2f..%2fapp.js` llega como `../../app.js`. Sin esta comprobación,
 * los endpoints de descarga sirven cualquier archivo del disco.
 *
 * @returns {string|null} Ruta absoluta segura, o null si intenta escapar
 */
export function safeJoin(baseDir, ...userPath) {
  const base = resolve(baseDir);
  const target = resolve(base, ...userPath.map(p => String(p || '')));
  if (target !== base && !target.startsWith(base + sep)) return null;
  return target;
}

// ─── Varios ─────────────────────────────────────────────────────

/** Formatea bytes de forma legible. */
export function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${parseFloat((bytes / 1024 ** i).toFixed(1))} ${units[i]}`;
}

/** Espera `ms` milisegundos. */
export function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * Ejecuta `fn` sobre `items` con concurrencia limitada, preservando el
 * orden de los resultados.
 */
export async function pMap(items, fn, concurrency = 4) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}
