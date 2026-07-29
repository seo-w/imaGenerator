/**
 * Orquestación del procesamiento de un lote.
 *
 * Recorre las filas agrupadas por página: carga cada página una sola vez,
 * inventaría sus imágenes, y procesa en paralelo acotado las filas que le
 * corresponden.
 */

import { existsSync, mkdirSync, writeFileSync, copyFileSync } from 'fs';
import { join } from 'path';
import {
  applyHolgura, DEFAULT_HOLGURA, DEFAULT_AGGRESSIVENESS,
  IMAGE_CONCURRENCY, outputDir,
} from './config.js';
import { groupByPage, harvestPage, indexInventory, matchInventory } from './measure.js';
import {
  optimizeImage, categorizeImage, getSizeLimit, fallbackWidth,
  readMetadata, extensionFor,
} from './optimize.js';
import { downloadImageWithRetry } from './download.js';
import { writeMapping } from './csv.js';
import { createZipFromProject } from './zip.js';
import { slugFromUrl, sanitizeFilename, safeJoin, imageBaseName, pMap } from './util.js';

/**
 * Cache de imágenes ya optimizadas dentro del lote.
 *
 * Guarda la RUTA del archivo escrito, no el buffer: la versión anterior
 * retenía en memoria cada imagen optimizada del lote (≈600MB en un lote de
 * 1155). Al repetirse una imagen se copia el archivo, con memoria O(1).
 *
 * `pending` evita que dos tareas concurrentes descarguen lo mismo.
 */
function createImageCache() {
  const done = new Map();
  const pending = new Map();
  return {
    get: key => done.get(key),
    getPending: key => pending.get(key),
    setPending: (key, promise) => pending.set(key, promise),
    resolve(key, entry) {
      done.set(key, entry);
      pending.delete(key);
    },
    fail(key) { pending.delete(key); },
  };
}

/**
 * Procesa un lote completo.
 *
 * @param {Object} params
 * @param {Array} params.rows - Filas del CSV ya validadas
 * @param {string} params.projectName - Nombre de carpeta del proyecto
 * @param {Object} params.options - format, aggressiveness, holgura
 * @param {Object} params.tracker - Tracker de estado del batch
 * @param {Function} params.emit - emit(event, data) para SSE
 * @param {Object} params.controller - Controlador de pausa/detención
 * @param {Array} params.existingResults - Items de ejecuciones anteriores
 * @param {string} params.batchId
 */
export async function runBatch({
  rows, projectName, options, tracker, emit, controller, browser,
  existingResults = [], batchId,
}) {
  const {
    format = 'auto',
    aggressiveness = DEFAULT_AGGRESSIVENESS,
    holgura = DEFAULT_HOLGURA,
  } = options;

  const projectDir = join(outputDir, projectName);
  if (!existsSync(projectDir)) mkdirSync(projectDir, { recursive: true });

  const groups = groupByPage(rows);
  const cache = createImageCache();
  const slugCounters = new Map();
  const newItems = [];

  let processed = tracker.completedCount;
  let overLimit = 0;
  let totalSaved = 0;
  let measuredCount = 0;
  let stopped = false;

  // Los prefijos numéricos se reservan de forma síncrona y en orden de
  // CSV, antes de lanzar trabajo concurrente, para que dos tareas
  // paralelas no se peleen por el mismo nombre de archivo.
  const prefixes = new Map();
  for (const group of groups) {
    const slug = group.pageUrl ? slugFromUrl(group.pageUrl) : '_sin-pagina';
    for (const index of group.indices) {
      if (tracker.isCompleted(index)) continue;
      const next = (slugCounters.get(slug) || 0) + 1;
      slugCounters.set(slug, next);
      prefixes.set(index, String(next).padStart(3, '0'));
    }
  }

  for (let groupIndex = 0; groupIndex < groups.length; groupIndex++) {
    const group = groups[groupIndex];

    if (await controller.checkStatus() === 'stopped') { stopped = true; break; }

    const pending = group.indices.filter(index => !tracker.isCompleted(index));
    if (!pending.length) continue;

    const slug = group.pageUrl ? slugFromUrl(group.pageUrl) : '_sin-pagina';

    // ── Inventariar la página una sola vez ────────────────────
    let indexed = [];
    let selectorRects = {};
    let harvestError = null;

    if (group.pageUrl && browser) {
      emit('progress', {
        current: processed, total: rows.length, status: 'measuring',
        pageUrl: group.pageUrl,
      });

      const harvest = await harvestPage(browser, group.pageUrl, { selectors: group.selectors });
      if (harvest.ok) {
        indexed = indexInventory(harvest.inventory);
        selectorRects = harvest.selectorRects;
      } else {
        harvestError = harvest.error;
      }

      emit('page', {
        pageUrl: group.pageUrl,
        pageIndex: groupIndex + 1,
        totalPages: groups.length,
        images: pending.length,
        inventorySize: indexed.length,
        error: harvestError,
      });
    }

    // ── Procesar las filas de esta página ─────────────────────
    const results = await pMap(pending, async (index) => {
      if (await controller.checkStatus() === 'stopped') return null;

      const row = rows[index];
      emit('progress', {
        current: processed, total: rows.length, status: 'processing',
        pageUrl: row.pageUrl, imageUrl: row.imageUrl,
      });

      try {
        const item = await processRow({
          row, index, slug, prefix: prefixes.get(index) || '000',
          projectDir, indexed, selectorRects, cache,
          format, aggressiveness, holgura, harvestError, emit,
        });
        return item;
      } catch (err) {
        return {
          index, csvLine: row.csvLine, status: 'error',
          pageUrl: row.pageUrl, imageUrl: row.imageUrl, slug,
          error: err.message,
        };
      }
    }, IMAGE_CONCURRENCY);

    for (const item of results) {
      if (!item) continue;
      processed++;
      tracker.record(item);
      newItems.push(item);
      if (item.status === 'ok') {
        totalSaved += (item.originalSize || 0) - (item.optimizedSize || 0);
        if (item.sizeWarning) overLimit++;
        if (item.measured) measuredCount++;
      }
      emit('item', item);
      emit('progress', {
        current: processed, total: rows.length, status: 'processing',
        pageUrl: item.pageUrl, imageUrl: item.imageUrl,
      });
    }

    if (await controller.checkStatus() === 'stopped') { stopped = true; break; }
  }

  tracker.flush();

  // ── mapping.csv con el set completo (previos + nuevos) ──────
  emit('progress', { current: processed, total: rows.length, status: 'packaging' });

  const allItems = new Map();
  for (const item of existingResults) allItems.set(item.index, item);
  for (const item of newItems) allItems.set(item.index, item);
  const merged = [...allItems.values()].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  writeMapping(projectDir, merged);

  // ── ZIP ────────────────────────────────────────────────────
  let zipUrl = null;
  const savedCount = merged.filter(item => item.status === 'ok').length;
  if (savedCount > 0) {
    try {
      await createZipFromProject(projectDir, batchId);
      zipUrl = `/api/download/${batchId}.zip`;
    } catch (err) {
      emit('error', { message: `No se pudo generar el ZIP: ${err.message}` });
    }
  }

  const successCount = merged.filter(item => item.status === 'ok').length;
  const errorCount = merged.filter(item => item.status !== 'ok').length;

  return {
    stopped,
    zipUrl,
    projectName,
    summary: {
      total: rows.length,
      success: successCount,
      errors: errorCount,
      overLimit,
      measured: measuredCount,
      unmeasured: successCount - measuredCount,
      totalSavedBytes: totalSaved,
    },
  };
}

/**
 * Procesa una fila: medir → descargar → optimizar → guardar.
 * @returns {Promise<Object>} Item de resultado (ok o error)
 */
async function processRow({
  row, index, slug, prefix, projectDir, indexed, selectorRects, cache,
  format, aggressiveness, holgura, harvestError, emit,
}) {
  const { pageUrl, imageUrl, selector, csvLine } = row;

  const baseItem = { index, csvLine, pageUrl, imageUrl, slug, holgura };

  if (!imageUrl) {
    return { ...baseItem, status: 'error', error: 'Falta URL de imagen' };
  }

  // ── 1. Medir contra el inventario ─────────────────────────
  const match = indexed.length || Object.keys(selectorRects).length
    ? matchInventory(indexed, imageUrl, selector, selectorRects)
    : null;

  let containerWidth = null;
  let targetWidth = null;
  let measureMethod = null;
  let measured = false;

  if (match) {
    containerWidth = match.width;
    targetWidth = applyHolgura(match.width, holgura);
    measureMethod = match.method;
    measured = true;
  } else if (harvestError) {
    measureMethod = 'pagina-no-cargo';
  } else if (pageUrl) {
    measureMethod = 'no-encontrada';
  } else {
    measureMethod = 'sin-pagina';
  }

  // ── 2. Descargar ──────────────────────────────────────────
  emit('progress', {
    current: null, total: null, status: 'downloading', pageUrl, imageUrl,
  });

  const inputBuffer = await downloadImageWithRetry(imageUrl, { referer: pageUrl })
    .catch(err => { throw new Error(`Error descargando: ${err.message}`); });

  const sourceMeta = await readMetadata(inputBuffer)
    .catch(err => { throw new Error(`Formato no reconocido: ${err.message}`); });

  // Sin medición, el ancho objetivo sale de una heurística sobre el ancho
  // original. Queda marcado como no medido para que sea visible.
  if (!measured) {
    targetWidth = fallbackWidth(sourceMeta.width);
  }

  // ── 3. Optimizar (con cache) ──────────────────────────────
  const category = categorizeImage(targetWidth || sourceMeta.width);
  const sizeLimitBytes = getSizeLimit(category, aggressiveness);

  // La clave se calcula DESPUÉS de fijar targetWidth: antes se construía
  // con el valor previo al fallback, así que la tabla reportaba
  // "original" en imágenes que sí se habían redimensionado.
  const cacheKey = [imageUrl, format, targetWidth || 'orig', sizeLimitBytes || 'nolimit'].join('|');

  const baseName = sanitizeFilename(imageBaseName(imageUrl) || 'imagen');

  emit('progress', { current: null, total: null, status: 'optimizing', pageUrl, imageUrl });

  let optimization = cache.get(cacheKey);
  let fromCache = !!optimization;

  if (!optimization) {
    const inFlight = cache.getPending(cacheKey);
    if (inFlight) {
      optimization = await inFlight;
      fromCache = true;
    } else {
      const promise = optimizeImage(inputBuffer, { targetWidth, format, sizeLimitBytes })
        .then(result => ({
          format: result.format,
          buffer: result.buffer,
          widthOriginal: result.widthOriginal,
          heightOriginal: result.heightOriginal,
          widthResult: result.widthResult,
          heightResult: result.heightResult,
          qualityUsed: result.qualityUsed,
          sizeWarning: result.sizeWarning,
          passthrough: result.passthrough,
          note: result.note,
          originalSize: inputBuffer.length,
          optimizedSize: result.buffer.length,
        }));
      cache.setPending(cacheKey, promise);
      try {
        optimization = await promise;
      } catch (err) {
        cache.fail(cacheKey);
        throw new Error(`Error optimizando: ${err.message}`);
      }
    }
  }

  // ── 4. Guardar ────────────────────────────────────────────
  const finalExt = extensionFor(optimization.format);
  const subfolder = safeJoin(projectDir, slug) || projectDir;
  if (!existsSync(subfolder)) mkdirSync(subfolder, { recursive: true });

  let filename = `${prefix}-${baseName}.${finalExt}`;
  let counter = 1;
  while (existsSync(join(subfolder, filename))) {
    filename = `${prefix}-${baseName}_${counter}.${finalExt}`;
    counter++;
  }
  const filePath = join(subfolder, filename);

  // Si esta imagen ya se escribió antes en el lote, se copia el archivo en
  // lugar de mantener su buffer en memoria.
  if (optimization.sourcePath && existsSync(optimization.sourcePath)) {
    copyFileSync(optimization.sourcePath, filePath);
  } else if (optimization.buffer) {
    writeFileSync(filePath, optimization.buffer);
    if (!fromCache) {
      // Liberar el buffer y quedarse solo con la ruta
      cache.resolve(cacheKey, { ...optimization, buffer: null, sourcePath: filePath });
    }
  } else {
    throw new Error('El archivo optimizado ya no está disponible en disco');
  }

  const savedPercent = optimization.originalSize > 0
    ? ((1 - optimization.optimizedSize / optimization.originalSize) * 100).toFixed(1)
    : '0.0';

  return {
    ...baseItem,
    status: 'ok',
    filename,
    format: optimization.format,
    originalSize: optimization.originalSize,
    optimizedSize: optimization.optimizedSize,
    savedPercent,
    widthOriginal: optimization.widthOriginal,
    heightOriginal: optimization.heightOriginal,
    widthResult: optimization.widthResult,
    heightResult: optimization.heightResult,
    containerWidth,
    targetWidth: targetWidth || null,
    measured,
    measureMethod,
    imageCategory: category,
    qualityUsed: optimization.qualityUsed,
    sizeWarning: optimization.sizeWarning,
    note: optimization.note || null,
    cached: fromCache,
  };
}
