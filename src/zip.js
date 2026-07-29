/**
 * Empaquetado de proyectos en ZIP.
 */

import archiver from 'archiver';
import { createWriteStream, existsSync } from 'fs';
import { join } from 'path';
import { tempZipsDir } from './config.js';

/**
 * Comprime la carpeta completa de un proyecto (subcarpetas + mapping.csv).
 *
 * @param {string} projectDir - Ruta absoluta de la carpeta del proyecto
 * @param {string} zipName - Nombre del ZIP, sin extensión
 * @returns {Promise<string>} Ruta del ZIP generado
 */
export function createZipFromProject(projectDir, zipName) {
  const zipPath = join(tempZipsDir, `${zipName}.zip`);
  const output = createWriteStream(zipPath);
  const archive = archiver('zip', { zlib: { level: 9 } });

  return new Promise((resolve, reject) => {
    output.on('close', () => resolve(zipPath));
    output.on('error', reject);
    archive.on('error', reject);
    archive.on('warning', err => { if (err.code !== 'ENOENT') reject(err); });

    archive.pipe(output);
    archive.glob('**/*', { cwd: projectDir, ignore: ['.DS_Store', '**/.DS_Store'] });
    archive.finalize();
  });
}

/** Ruta del ZIP de un batch, o null si ya fue limpiado. */
export function findZip(zipName) {
  const zipPath = join(tempZipsDir, `${zipName}.zip`);
  return existsSync(zipPath) ? zipPath : null;
}
