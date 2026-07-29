/**
 * Exploración y administración de proyectos ya procesados.
 *
 * Un proyecto es una carpeta en `output/`, con subcarpetas por slug de
 * página y un `mapping.csv` con la trazabilidad. Como `output/` ya no se
 * limpia automáticamente, esta es la vía para revisar y borrar trabajo.
 */

import { readdirSync, statSync, existsSync, readFileSync, rmSync } from 'fs';
import { join, relative, sep } from 'path';
import { outputDir } from './config.js';
import { readMapping } from './csv.js';
import { safeJoin } from './util.js';
import { deleteBatchesForProject } from './state.js';

/** Extensiones que consideramos imágenes de salida. */
const IMAGE_EXTENSIONS = new Set(['webp', 'avif', 'jpg', 'jpeg', 'png', 'gif', 'svg']);

function isImage(filename) {
  const ext = filename.split('.').pop()?.toLowerCase();
  return IMAGE_EXTENSIONS.has(ext);
}

/** Recorre un directorio y devuelve las imágenes con su ruta relativa. */
function walkImages(dir, base = dir) {
  const found = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return found;
  }

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...walkImages(full, base));
    } else if (isImage(entry.name)) {
      try {
        const stat = statSync(full);
        found.push({
          filename: entry.name,
          relativePath: relative(base, full).split(sep).join('/'),
          slug: relative(base, dir).split(sep).join('/') || '.',
          bytes: stat.size,
          modifiedAt: stat.mtime.toISOString(),
        });
      } catch { /* archivo desaparecido entre readdir y stat */ }
    }
  }
  return found;
}

/** Lee el mapping.csv de un proyecto, indexado por nombre de archivo. */
function loadMappingIndex(projectDir) {
  const path = join(projectDir, 'mapping.csv');
  if (!existsSync(path)) return { rows: [], byFilename: new Map() };
  const rows = readMapping(readFileSync(path, 'utf-8'));
  const byFilename = new Map();
  for (const row of rows) {
    if (row.archivo && row.archivo !== 'ERROR') byFilename.set(row.archivo, row);
  }
  return { rows, byFilename };
}

/** Resumen de todos los proyectos, del más reciente al más viejo. */
export function listProjects() {
  if (!existsSync(outputDir)) return [];

  return readdirSync(outputDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
    .map(entry => {
      const projectDir = join(outputDir, entry.name);
      const images = walkImages(projectDir);
      const { rows } = loadMappingIndex(projectDir);

      let originalBytes = 0;
      let optimizedBytes = 0;
      let errors = 0;
      let unmeasured = 0;
      let warnings = 0;

      for (const row of rows) {
        if (row.archivo === 'ERROR' || row.error) { errors++; continue; }
        originalBytes += Number(row.original_bytes) || 0;
        optimizedBytes += Number(row.optimizado_bytes) || 0;
        if (row.medido === 'no') unmeasured++;
        if (row.size_warning) warnings++;
      }

      const stat = statSync(projectDir);
      const diskBytes = images.reduce((sum, img) => sum + img.bytes, 0);

      return {
        name: entry.name,
        imageCount: images.length,
        slugCount: new Set(images.map(img => img.slug)).size,
        diskBytes,
        originalBytes,
        optimizedBytes,
        savedBytes: Math.max(originalBytes - optimizedBytes, 0),
        savedPercent: originalBytes > 0
          ? Number(((1 - optimizedBytes / originalBytes) * 100).toFixed(1))
          : 0,
        errors,
        warnings,
        unmeasured,
        hasMapping: rows.length > 0,
        createdAt: stat.birthtime.toISOString(),
        modifiedAt: stat.mtime.toISOString(),
      };
    })
    .sort((a, b) => new Date(b.modifiedAt) - new Date(a.modifiedAt));
}

/**
 * Detalle de un proyecto: imágenes agrupadas por slug, con los metadatos
 * del mapping cuando existen.
 *
 * @returns {Object|null} null si el proyecto no existe
 */
export function getProject(name) {
  const projectDir = safeJoin(outputDir, name);
  if (!projectDir || !existsSync(projectDir) || !statSync(projectDir).isDirectory()) return null;

  const images = walkImages(projectDir);
  const { rows, byFilename } = loadMappingIndex(projectDir);

  const groups = new Map();
  for (const image of images) {
    const mapping = byFilename.get(image.filename);
    const enriched = {
      ...image,
      urlPagina: mapping?.url_pagina || '',
      urlImagen: mapping?.url_imagen || '',
      formato: mapping?.formato || image.filename.split('.').pop(),
      originalBytes: Number(mapping?.original_bytes) || null,
      optimizedBytes: Number(mapping?.optimizado_bytes) || image.bytes,
      savedPercent: mapping?.ahorro_pct || null,
      anchoOriginal: Number(mapping?.ancho_original) || null,
      anchoFinal: Number(mapping?.ancho_final) || null,
      anchoContenedor: Number(mapping?.ancho_contenedor) || null,
      holgura: mapping?.holgura || '',
      metodo: mapping?.metodo || '',
      medido: mapping?.medido === 'si',
      categoria: mapping?.categoria || '',
      calidad: mapping?.calidad || '',
      sizeWarning: mapping?.size_warning || '',
    };
    if (!groups.has(image.slug)) groups.set(image.slug, []);
    groups.get(image.slug).push(enriched);
  }

  const errorRows = rows
    .filter(row => row.archivo === 'ERROR' || row.error)
    .map(row => ({
      fila: row.fila,
      urlPagina: row.url_pagina,
      urlImagen: row.url_imagen,
      error: row.error || 'Error no especificado',
    }));

  const slugs = [...groups.entries()]
    .map(([slug, items]) => ({
      slug,
      images: items.sort((a, b) => a.filename.localeCompare(b.filename)),
      bytes: items.reduce((sum, img) => sum + img.bytes, 0),
    }))
    .sort((a, b) => a.slug.localeCompare(b.slug));

  const stat = statSync(projectDir);
  return {
    name,
    slugs,
    errors: errorRows,
    imageCount: images.length,
    hasMapping: rows.length > 0,
    createdAt: stat.birthtime.toISOString(),
    modifiedAt: stat.mtime.toISOString(),
  };
}

/**
 * Borra un proyecto completo y el estado de sus batches.
 * @returns {boolean} true si se borró, false si no existía
 */
export function deleteProject(name) {
  const projectDir = safeJoin(outputDir, name);
  if (!projectDir || projectDir === outputDir || !existsSync(projectDir)) return false;
  rmSync(projectDir, { recursive: true, force: true });
  deleteBatchesForProject(name);
  return true;
}

/**
 * Ruta absoluta de una imagen dentro de un proyecto, verificando que no
 * se escape de `output/`.
 * @returns {string|null}
 */
export function resolveProjectFile(name, relativePath) {
  const projectDir = safeJoin(outputDir, name);
  if (!projectDir) return null;
  const filePath = safeJoin(projectDir, relativePath);
  if (!filePath || !existsSync(filePath) || !statSync(filePath).isFile()) return null;
  return filePath;
}

/** Ruta de la carpeta de un proyecto, o null si no existe. */
export function projectPath(name) {
  const dir = safeJoin(outputDir, name);
  return dir && existsSync(dir) ? dir : null;
}
