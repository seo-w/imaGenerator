/**
 * IMA Generator — punto de entrada.
 *
 * Optimizador masivo de imágenes: lee un CSV de páginas e imágenes, mide
 * cuánto mide cada imagen en su contenedor real, y genera versiones
 * ajustadas a ese tamaño más una holgura configurable.
 *
 * La lógica vive en `src/`. Este archivo solo arma el servidor.
 */

import express from 'express';
import { PORT, publicDir, outputDir, ensureDirs } from './src/config.js';
import { startCleanupScheduler } from './src/cleanup.js';
import { createRouter } from './src/routes.js';

ensureDirs();

const app = express();

app.use(express.static(publicDir));
app.use(express.json({ limit: '20mb' })); // check-state manda el CSV completo
app.use(createRouter());

/** Manejador de errores: multer y demás fallos de middleware. */
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
  res.status(status).json({ error: err.message || 'Error en la petición' });
});

startCleanupScheduler();

app.listen(PORT, () => {
  console.log(`IMA Generator escuchando en http://localhost:${PORT}`);
  console.log(`Proyectos en ${outputDir} (no se borran automáticamente)`);
});
