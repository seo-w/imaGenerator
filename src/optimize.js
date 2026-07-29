/**
 * Optimización de imágenes con Sharp.
 *
 * Dos ejes independientes:
 *   - Dimensión: el ancho objetivo lo decide la medición del contenedor
 *     más la holgura. Nunca se reduce por debajo de ese valor.
 *   - Peso: si el archivo supera el límite de su categoría, se baja la
 *     calidad en cascada. La dimensión no se toca.
 */

import sharp from 'sharp';
import {
  CATEGORY_THRESHOLDS, SIZE_LIMITS, QUALITY_STEPS, QUALITY_START,
  FALLBACK_WIDTHS, DEFAULT_AGGRESSIVENESS,
} from './config.js';

/** Formatos que Sharp escribe y que aceptamos como salida. */
const RASTER_FORMATS = new Set(['webp', 'avif', 'jpeg', 'png']);

/**
 * Clasifica una imagen por el ancho al que se va a mostrar.
 * @param {number} effectiveWidth - Ancho objetivo, o el original si no se midió
 */
export function categorizeImage(effectiveWidth) {
  const width = Number(effectiveWidth) || 0;
  if (width >= CATEGORY_THRESHOLDS.hero) return 'hero';
  if (width > 0 && width <= CATEGORY_THRESHOLDS.icon) return 'icon';
  return 'content';
}

/**
 * Límite de peso en bytes, o `null` si no hay límite.
 * @param {string} category - hero | content | icon
 * @param {string} aggressiveness - conservative | balanced | aggressive | none
 */
export function getSizeLimit(category, aggressiveness = DEFAULT_AGGRESSIVENESS) {
  if (aggressiveness === 'none') return null;
  const table = SIZE_LIMITS[aggressiveness] ?? SIZE_LIMITS[DEFAULT_AGGRESSIVENESS];
  if (!table) return null;
  return table[category] ?? table.content;
}

/**
 * Ancho de fallback cuando no se pudo medir el contenedor.
 *
 * Es una heurística por el ancho original del archivo, NO una medición.
 * Se reporta como tal (`measured: false`) para que quede visible en la UI
 * y en el mapping.csv.
 *
 * @returns {number|null} Ancho objetivo, o null para no redimensionar
 */
export function fallbackWidth(originalWidth) {
  for (const { minOriginal, target } of FALLBACK_WIDTHS) {
    if (originalWidth > minOriginal) return target;
  }
  return null;
}

/** Lee los metadatos de un buffer sin decodificar los píxeles. */
export async function readMetadata(buffer) {
  const meta = await sharp(buffer, { failOn: 'none' }).metadata();
  return {
    format: meta.format,
    width: Math.round(meta.width || 0),
    height: Math.round(meta.height || 0),
    pages: meta.pages || 1,
    hasAlpha: !!meta.hasAlpha,
    isAnimated: (meta.pages || 1) > 1,
    isVector: meta.format === 'svg',
  };
}

/**
 * Codifica un buffer al formato pedido y devuelve el resultado junto a la
 * info que Sharp ya calculó.
 *
 * Usa `resolveWithObject` para obtener ancho/alto/tamaño finales sin un
 * segundo decode: la versión anterior llamaba a `sharp(buffer).metadata()`
 * por cada candidato de la cascada, duplicando el trabajo.
 */
async function encode(inputBuffer, { format, quality, targetWidth, sourceWidth, animated }) {
  let pipeline = sharp(inputBuffer, { failOn: 'none', animated });

  if (targetWidth && sourceWidth > targetWidth) {
    pipeline = pipeline.resize(targetWidth, null, {
      fit: 'inside',
      withoutEnlargement: true,
    });
  }

  switch (format) {
    case 'webp':
      pipeline = pipeline.webp({ quality, effort: 4 });
      break;
    case 'avif':
      // effort 4 en lugar de 6: el ahorro extra de 6 es marginal y cuesta
      // el doble de CPU, que en lotes grandes domina el tiempo total.
      pipeline = pipeline.avif({ quality, effort: 4 });
      break;
    case 'jpeg':
      pipeline = pipeline.jpeg({ quality, progressive: true, mozjpeg: true });
      break;
    case 'png':
      // `quality` solo tiene efecto sobre PNG con paleta. Sin esto, la
      // cascada re-comprimía cuatro veces el mismo buffer idéntico.
      pipeline = pipeline.png({
        compressionLevel: 9,
        palette: quality < 100,
        quality,
        effort: 7,
      });
      break;
    default:
      pipeline = pipeline.webp({ quality, effort: 4 });
  }

  const { data, info } = await pipeline.toBuffer({ resolveWithObject: true });
  return {
    buffer: data,
    // El nombre canónico es el formato PEDIDO, no `info.format`: para AVIF
    // Sharp reporta `heif` (AVIF es un contenedor HEIF), lo que generaba
    // archivos `.heif` que ningún navegador reconoce como imagen web.
    format: normalizeFormat(format),
    width: Math.round(info.width),
    height: Math.round(info.height),
    size: data.length,
    quality,
  };
}

/**
 * Optimiza una imagen respetando el ancho objetivo y, si hay límite, el
 * peso máximo.
 *
 * @param {Buffer} inputBuffer
 * @param {Object} options
 * @param {number|null} options.targetWidth - Ancho objetivo (null = original)
 * @param {string} options.format - webp|avif|jpeg|png|auto
 * @param {number|null} options.sizeLimitBytes - Límite de peso (null = sin límite)
 * @returns {Promise<Object>} Resultado con buffer, formato y métricas
 */
export async function optimizeImage(inputBuffer, {
  targetWidth = null,
  format = 'auto',
  sizeLimitBytes = null,
} = {}) {
  const meta = await readMetadata(inputBuffer);

  // Los SVG se dejan intactos: rasterizarlos les quita justamente lo que
  // los hace valiosos, y ya son livianos.
  if (meta.isVector) {
    return {
      buffer: inputBuffer,
      format: 'svg',
      widthOriginal: meta.width, heightOriginal: meta.height,
      widthResult: meta.width, heightResult: meta.height,
      qualityUsed: null,
      sizeWarning: null,
      passthrough: true,
      note: 'SVG conservado sin cambios (vectorial)',
    };
  }

  // Los animados se mantienen animados y en WebP: AVIF animado tiene
  // soporte irregular, y convertir a estático rompe la imagen.
  const animated = meta.isAnimated;
  const requestedFormats = animated
    ? ['webp']
    : (format === 'auto' ? ['webp', 'avif'] : [normalizeFormat(format)]);

  const base = {
    targetWidth,
    sourceWidth: meta.width,
    animated,
  };

  // Si no hay que reducir dimensiones, el original es un candidato válido:
  // re-comprimir un archivo ya optimizado suele agrandarlo.
  const willResize = !!(targetWidth && meta.width > targetWidth);

  // ── Sin límite de peso: una pasada a calidad inicial ─────────
  if (!sizeLimitBytes) {
    const candidates = await Promise.all(
      requestedFormats.map(fmt => encode(inputBuffer, { ...base, format: fmt, quality: QUALITY_START })
        .catch(() => null))
    );
    const winner = pickSmallest(candidates);
    if (!winner) throw new Error('No se pudo codificar la imagen en ningún formato');
    const original = keepOriginalIfSmaller(winner, inputBuffer, meta, willResize);
    return original || finalize(winner, meta, null);
  }

  // ── Con límite: cascada de calidad ───────────────────────────
  let best = null;
  // Formatos que dejaron de responder a bajadas de calidad
  const exhausted = new Set();
  const lastSizes = new Map();

  for (const quality of QUALITY_STEPS) {
    const active = requestedFormats.filter(fmt => !exhausted.has(fmt));
    if (!active.length) break;

    const candidates = await Promise.all(
      active.map(fmt => encode(inputBuffer, { ...base, format: fmt, quality }).catch(() => null))
    );

    for (const candidate of candidates) {
      if (!candidate) continue;
      if (!best || candidate.size < best.size) best = candidate;

      // Si bajar la calidad no movió el tamaño, este formato no responde
      // (típico de PNG sin paleta): dejar de intentarlo.
      const previous = lastSizes.get(candidate.format);
      if (previous !== undefined && Math.abs(previous - candidate.size) < previous * 0.01) {
        exhausted.add(candidate.format);
      }
      lastSizes.set(candidate.format, candidate.size);
    }

    if (best && best.size <= sizeLimitBytes) {
      const original = keepOriginalIfSmaller(best, inputBuffer, meta, willResize);
      return original || finalize(best, meta, null);
    }
  }

  if (!best) throw new Error('No se pudo codificar la imagen en ningún formato');

  const original = keepOriginalIfSmaller(best, inputBuffer, meta, willResize);
  if (original) return original;

  const warning = `No se pudo bajar de ${Math.round(best.size / 1024)}KB `
    + `(límite: ${Math.round(sizeLimitBytes / 1024)}KB) sin reducir el ancho por debajo `
    + `de los ${targetWidth || meta.width}px que necesita el contenedor.`;
  return finalize(best, meta, warning);
}

/**
 * Devuelve el original si optimizarlo lo hubiera agrandado.
 *
 * Pasa seguido con imágenes que ya vienen optimizadas (un WebP servido por
 * el CDN, un JPEG bien comprimido): re-codificarlas al mismo ancho suma
 * peso en lugar de quitarlo. Un optimizador no debe entregar un archivo
 * más grande que el que recibió.
 *
 * Solo aplica si NO hubo que reducir dimensiones: si la imagen se
 * redimensionó, el archivo nuevo es el correcto aunque pese parecido.
 *
 * @returns {Object|null} Resultado passthrough, o null si conviene optimizar
 */
function keepOriginalIfSmaller(winner, inputBuffer, meta, willResize) {
  if (willResize) return null;
  if (winner.size < inputBuffer.length) return null;
  if (!RASTER_FORMATS.has(meta.format === 'jpg' ? 'jpeg' : meta.format)) return null;

  const sourceFormat = meta.format === 'jpg' ? 'jpeg' : meta.format;
  return {
    buffer: inputBuffer,
    format: sourceFormat,
    widthOriginal: meta.width,
    heightOriginal: meta.height,
    widthResult: meta.width,
    heightResult: meta.height,
    qualityUsed: null,
    sizeWarning: null,
    passthrough: true,
    note: `El original (${Math.round(inputBuffer.length / 1024)}KB) ya era más chico que `
      + `cualquier versión optimizada (${Math.round(winner.size / 1024)}KB): se conservó sin cambios.`,
  };
}

/** Normaliza alias de formato. */
function normalizeFormat(format) {
  const lower = String(format || '').toLowerCase();
  if (lower === 'jpg') return 'jpeg';
  return RASTER_FORMATS.has(lower) ? lower : 'webp';
}

function pickSmallest(candidates) {
  return candidates.filter(Boolean).reduce(
    (best, candidate) => (!best || candidate.size < best.size ? candidate : best),
    null
  );
}

function finalize(winner, meta, sizeWarning) {
  return {
    buffer: winner.buffer,
    format: winner.format,
    widthOriginal: meta.width,
    heightOriginal: meta.height,
    widthResult: winner.width,
    heightResult: winner.height,
    qualityUsed: winner.quality,
    sizeWarning,
    passthrough: false,
  };
}

/** Extensión de archivo para un formato de salida. */
export function extensionFor(format) {
  if (format === 'jpeg') return 'jpg';
  return format || 'webp';
}
