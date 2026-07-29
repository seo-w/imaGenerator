/**
 * Limpieza de directorios efímeros.
 *
 * `output/` NO se limpia automáticamente: contiene el trabajo del usuario
 * y se administra a mano desde la vista de Proyectos. Antes se borraba a
 * las 24h — y encima el borrado fallaba en silencio con slugs anidados
 * (`blog/mi-post`), porque hacía unlink sobre un directorio.
 */

import { readdirSync, statSync, rmSync } from 'fs';
import { join } from 'path';
import { CLEANUP_DIRS, CLEANUP_MAX_AGE_MS, CLEANUP_INTERVAL_MS } from './config.js';

/**
 * Borra entradas de `dir` más viejas que `maxAgeMs`, recursivamente.
 * @returns {number} Cantidad de entradas eliminadas
 */
export function cleanupOldEntries(dir, maxAgeMs = CLEANUP_MAX_AGE_MS) {
  let removed = 0;
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return 0;
  }

  const now = Date.now();
  for (const entry of entries) {
    if (entry === '.gitkeep' || entry === '.DS_Store') continue;
    const path = join(dir, entry);
    try {
      if (now - statSync(path).mtimeMs <= maxAgeMs) continue;
      rmSync(path, { recursive: true, force: true });
      removed++;
    } catch { /* archivo en uso o ya borrado */ }
  }
  return removed;
}

/** Arranca la limpieza periódica de uploads/ y temp-zips/. */
export function startCleanupScheduler() {
  const run = () => {
    for (const dir of CLEANUP_DIRS) cleanupOldEntries(dir);
  };
  run();
  const timer = setInterval(run, CLEANUP_INTERVAL_MS);
  timer.unref?.();
  return timer;
}
