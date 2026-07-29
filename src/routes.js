/**
 * Rutas HTTP de IMA Generator.
 */

import express from 'express';
import multer from 'multer';
import { readFileSync, unlinkSync, existsSync } from 'fs';
import { join } from 'path';
import {
  uploadsDir, outputDir, MAX_CSV_BYTES,
  DEFAULT_AGGRESSIVENESS, DEFAULT_HOLGURA, HOLGURA_MODES, SIZE_LIMITS,
} from './config.js';
import { parseCsv } from './csv.js';
import {
  hashCsv, generateBatchId, loadBatchState, findResumableBatch,
  loadBatchResults, finalizeBatchState, createBatchTracker,
  listBatches, deleteBatchState,
} from './state.js';
import {
  createProcessController, registerProcess, unregisterProcess,
  getProcess, newProcessId,
} from './control.js';
import { createBrowser } from './measure.js';
import { runBatch } from './pipeline.js';
import { sanitizeProjectName, safeJoin } from './util.js';
import { findZip, createZipFromProject } from './zip.js';
import {
  listProjects, getProject, deleteProject, resolveProjectFile, projectPath,
} from './projects.js';

const upload = multer({
  dest: uploadsDir,
  limits: { fileSize: MAX_CSV_BYTES, files: 1 },
  fileFilter: (req, file, cb) => {
    const ok = /\.(csv|txt|tsv)$/i.test(file.originalname)
      || /text\/(csv|plain|tab-separated-values)|application\/vnd\.ms-excel/.test(file.mimetype);
    cb(ok ? null : new Error('Solo se aceptan archivos CSV'), ok);
  },
});

export function createRouter() {
  const router = express.Router();

  // ─── Opciones disponibles (las consume la UI) ──────────────
  router.get('/api/options', (req, res) => {
    res.json({
      holgura: Object.entries(HOLGURA_MODES).map(([value, { label }]) => ({ value, label })),
      holguraDefault: DEFAULT_HOLGURA,
      aggressiveness: Object.keys(SIZE_LIMITS),
      aggressivenessDefault: DEFAULT_AGGRESSIVENESS,
    });
  });

  // ─── Procesamiento (SSE) ───────────────────────────────────
  router.post('/api/process', upload.single('csv'), handleProcess);

  // ─── Control de ejecución ──────────────────────────────────
  router.post('/api/control/:processId', (req, res) => {
    const controller = getProcess(req.params.processId);
    if (!controller) {
      return res.status(404).json({ error: 'Proceso no encontrado o ya finalizado' });
    }
    const { action } = req.body || {};
    const statusByAction = { pause: 'paused', resume: 'running', stop: 'stopped' };
    if (!statusByAction[action]) {
      return res.status(400).json({ error: 'Acción no válida. Use: pause, resume, stop' });
    }
    controller.updateStatus(statusByAction[action]);
    res.json({ ok: true, action, status: controller.getStatus() });
  });

  // ─── Estado y reanudación ──────────────────────────────────
  router.post('/api/check-state', (req, res) => {
    const { csvContent } = req.body || {};
    if (!csvContent) return res.status(400).json({ error: 'Se requiere csvContent' });

    const resumable = findResumableBatch(hashCsv(csvContent));
    if (!resumable) return res.json({ found: false });

    res.json({
      found: true,
      batchId: resumable.id,
      projectName: resumable.projectName,
      totalRows: resumable.totalRows,
      completed: resumable.completedIndices?.length || 0,
      errors: resumable.errorIndices?.length || 0,
      status: resumable.status,
      createdAt: resumable.createdAt,
    });
  });

  router.get('/api/batches', (req, res) => res.json({ batches: listBatches() }));

  router.delete('/api/batches/:batchId', (req, res) => {
    deleteBatchState(req.params.batchId);
    res.json({ ok: true });
  });

  // ─── Proyectos ─────────────────────────────────────────────
  router.get('/api/projects', (req, res) => res.json({ projects: listProjects() }));

  router.get('/api/projects/:name', (req, res) => {
    const project = getProject(req.params.name);
    if (!project) return res.status(404).json({ error: 'Proyecto no encontrado' });
    res.json(project);
  });

  router.delete('/api/projects/:name', (req, res) => {
    if (!deleteProject(req.params.name)) {
      return res.status(404).json({ error: 'Proyecto no encontrado' });
    }
    res.json({ ok: true });
  });

  // Sirve una imagen del proyecto. El path va como wildcard porque los
  // slugs pueden estar anidados (`blog/mi-post/001-foto.webp`).
  router.get('/api/projects/:name/file/*', (req, res) => {
    const relativePath = req.params[0] || '';
    const filePath = resolveProjectFile(req.params.name, relativePath);
    if (!filePath) return res.status(404).json({ error: 'Archivo no encontrado' });
    res.sendFile(filePath);
  });

  router.get('/api/projects/:name/download', async (req, res) => {
    const dir = projectPath(req.params.name);
    if (!dir) return res.status(404).json({ error: 'Proyecto no encontrado' });
    try {
      const zipName = `proyecto-${req.params.name}`;
      const zipPath = await createZipFromProject(dir, zipName);
      res.download(zipPath, `${req.params.name}.zip`);
    } catch (err) {
      res.status(500).json({ error: `No se pudo generar el ZIP: ${err.message}` });
    }
  });

  // ─── Descargas ─────────────────────────────────────────────

  // Wildcard, no `:filename`: las imágenes viven en rutas anidadas
  // (`proyecto/blog/mi-post/001-foto.webp`). Con un solo segmento, todos
  // los botones de descarga de la tabla daban 404.
  router.get('/api/output/*', (req, res) => {
    const filePath = safeJoin(outputDir, req.params[0] || '');
    if (!filePath || !existsSync(filePath)) {
      return res.status(404).json({ error: 'Archivo no encontrado' });
    }
    res.sendFile(filePath);
  });

  router.get('/api/download/:batchId.zip', (req, res) => {
    const zipPath = findZip(req.params.batchId);
    if (!zipPath) {
      return res.status(404).json({
        error: 'ZIP no encontrado. Los ZIP temporales se limpian a las 24h; '
          + 'descargá el proyecto desde la pestaña Proyectos.',
      });
    }
    res.download(zipPath, `imagenes_optimizadas_${req.params.batchId}.zip`);
  });

  return router;
}

/**
 * POST /api/process — procesa un CSV emitiendo eventos SSE.
 *
 * Query params:
 *   format          webp | avif | jpeg | png | auto
 *   aggressiveness  conservative | balanced | aggressive | none
 *   holgura         100px | 1x | 1.5x | 2x
 *   projectName     nombre de carpeta de salida
 *   resumeBatchId   batch a reanudar
 */
async function handleProcess(req, res) {
  const format = String(req.query.format || 'auto').toLowerCase();
  const aggressiveness = SIZE_LIMITS[String(req.query.aggressiveness || '').toLowerCase()] !== undefined
    ? String(req.query.aggressiveness).toLowerCase()
    : DEFAULT_AGGRESSIVENESS;
  const holgura = HOLGURA_MODES[req.query.holgura] ? req.query.holgura : DEFAULT_HOLGURA;
  const projectName = sanitizeProjectName(req.query.projectName);
  const resumeBatchId = req.query.resumeBatchId || null;

  const processId = newProcessId();
  const controller = createProcessController();
  registerProcess(processId, controller);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  // Evita que un proxy intermedio acumule el stream y mate el progreso
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  const emit = (event, data) => {
    if (res.writableEnded) return;
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  // Latido: mantiene la conexión viva durante páginas lentas
  const heartbeat = setInterval(() => {
    if (!res.writableEnded) res.write(': ping\n\n');
  }, 15000);
  heartbeat.unref?.();

  // Si el cliente cierra la pestaña, detener el trabajo en vez de seguir
  // gastando CPU contra un socket muerto.
  req.on('close', () => {
    if (!res.writableEnded) controller.updateStatus('stopped');
  });

  let browser = null;

  try {
    if (!req.file) {
      emit('error', { message: 'No se recibió archivo CSV.' });
      return res.end();
    }

    const csvContent = readFileSync(req.file.path, 'utf-8');
    try { unlinkSync(req.file.path); } catch { /* ya borrado */ }

    const { rows, skipped, delimiter, total } = parseCsv(csvContent);

    if (!rows.length) {
      emit('error', {
        message: total === 0
          ? 'El CSV está vacío.'
          : `El CSV no tiene filas válidas (se leyeron ${total}, delimitador "${delimiter}"). `
            + 'Se requieren al menos 2 columnas: url de página y url de imagen.',
      });
      return res.end();
    }

    // ─── Estado del batch ────────────────────────────────────
    const csvHash = hashCsv(csvContent);
    let batchId;
    let existingResults = [];
    let initialState;

    if (resumeBatchId) {
      const previous = loadBatchState(resumeBatchId);
      if (!previous) {
        emit('error', { message: 'El batch a reanudar no existe.' });
        return res.end();
      }
      batchId = resumeBatchId;
      existingResults = loadBatchResults(batchId);
      initialState = { ...previous, status: 'running', totalRows: rows.length };
    } else {
      batchId = generateBatchId(csvHash);
      initialState = {
        id: batchId,
        csvHash,
        createdAt: new Date().toISOString(),
        totalRows: rows.length,
        status: 'running',
        completedIndices: [],
        errorIndices: [],
        format, aggressiveness, holgura, projectName,
      };
    }

    const tracker = createBatchTracker(batchId, initialState);
    tracker.flush();

    if (existingResults.length) {
      emit('resume', {
        batchId, processId, projectName, total: rows.length,
        completed: tracker.completedCount, errors: tracker.errorCount,
      });
      for (const item of existingResults) emit('item', item);
    } else {
      emit('start', {
        batchId, processId, projectName, total: rows.length, skipped, delimiter,
        holgura, aggressiveness, format,
      });
    }

    // ─── Navegador ───────────────────────────────────────────
    const needsBrowser = rows.some(row => row.pageUrl);
    if (needsBrowser) {
      try {
        browser = await createBrowser();
      } catch (err) {
        emit('error', {
          message: `No se pudo iniciar Puppeteer: ${err.message}. `
            + 'Las imágenes se procesarán sin medir el contenedor.',
        });
      }
    }

    // ─── Procesar ────────────────────────────────────────────
    const result = await runBatch({
      rows, projectName, batchId, tracker, emit, controller, browser,
      existingResults,
      options: { format, aggressiveness, holgura },
    });

    finalizeBatchState(batchId, result.stopped ? 'stopped' : 'completed');

    if (result.stopped) {
      emit('stopped', {
        current: tracker.completedCount,
        total: rows.length,
        batchId,
        zipUrl: result.zipUrl,
        summary: result.summary,
        message: 'Proceso detenido. Podés reanudarlo cargando el mismo CSV.',
      });
    } else {
      emit('complete', {
        batchId,
        zipUrl: result.zipUrl,
        projectName: result.projectName,
        summary: result.summary,
      });
    }

    res.end();
  } catch (err) {
    console.error('Error de procesamiento:', err);
    emit('error', { message: err.message });
    if (!res.writableEnded) res.end();
  } finally {
    clearInterval(heartbeat);
    unregisterProcess(processId);
    if (browser) await browser.close().catch(() => {});
  }
}
