/**
 * Persistencia de batches para poder reanudar un procesamiento
 * interrumpido (por pausa, detención, o caída del servidor).
 *
 * Dos archivos por batch en `state/`:
 *   - `{batchId}.json`          → metadatos e índices completados
 *   - `{batchId}-results.jsonl` → un item por línea, append-only
 */

import {
  readFileSync, writeFileSync, appendFileSync, existsSync,
  readdirSync, unlinkSync,
} from 'fs';
import { join } from 'path';
import { createHash } from 'crypto';
import { stateDir } from './config.js';

/** Estados terminales: un batch así no se ofrece para reanudar. */
const FINAL_STATUSES = new Set(['completed']);

/** Hash corto y estable del contenido del CSV. */
export function hashCsv(csvContent) {
  return createHash('sha256').update(csvContent).digest('hex').slice(0, 16);
}

export function generateBatchId(csvHash) {
  return `batch_${csvHash}_${Date.now()}`;
}

function statePath(batchId) {
  return join(stateDir, `${batchId}.json`);
}

function resultsPath(batchId) {
  return join(stateDir, `${batchId}-results.jsonl`);
}

export function saveBatchState(batchId, state) {
  writeFileSync(statePath(batchId), JSON.stringify(state, null, 2));
}

export function loadBatchState(batchId) {
  if (!existsSync(statePath(batchId))) return null;
  try {
    return JSON.parse(readFileSync(statePath(batchId), 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Busca el batch reanudable más reciente para un CSV dado.
 *
 * Un batch detenido o pausado queda en estado `stopped`/`running` y SÍ
 * es reanudable. Solo `completed` lo descarta.
 */
export function findResumableBatch(csvHash) {
  const files = readdirSync(stateDir)
    .filter(f => f.startsWith(`batch_${csvHash}_`) && f.endsWith('.json') && !f.includes('-results'));

  for (const file of files.sort().reverse()) {
    const state = loadBatchState(file.replace('.json', ''));
    if (state && !FINAL_STATUSES.has(state.status) && (state.completedIndices?.length || 0) > 0) {
      return state;
    }
  }
  return null;
}

export function appendBatchResult(batchId, item) {
  appendFileSync(resultsPath(batchId), JSON.stringify(item) + '\n');
}

/** Lee todos los items registrados de un batch. */
export function loadBatchResults(batchId) {
  if (!existsSync(resultsPath(batchId))) return [];
  return readFileSync(resultsPath(batchId), 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map(line => { try { return JSON.parse(line); } catch { return null; } })
    .filter(Boolean);
}

/**
 * Marca el estado final del batch.
 *
 * `stopped` es deliberadamente NO terminal: detener un proceso y
 * reanudarlo después es el flujo previsto, así que el batch tiene que
 * seguir apareciendo en findResumableBatch.
 */
export function finalizeBatchState(batchId, status = 'completed') {
  const state = loadBatchState(batchId);
  if (!state) return;
  state.status = status;
  state.finishedAt = new Date().toISOString();
  saveBatchState(batchId, state);
}

export function deleteBatchState(batchId) {
  for (const path of [statePath(batchId), resultsPath(batchId)]) {
    if (existsSync(path)) unlinkSync(path);
  }
}

/** Lista todos los batches, del más reciente al más viejo. */
export function listBatches() {
  return readdirSync(stateDir)
    .filter(f => f.endsWith('.json') && !f.includes('-results'))
    .map(file => loadBatchState(file.replace('.json', '')))
    .filter(Boolean)
    .map(state => ({
      batchId: state.id,
      csvHash: state.csvHash,
      projectName: state.projectName,
      totalRows: state.totalRows,
      completed: state.completedIndices?.length || 0,
      errors: state.errorIndices?.length || 0,
      status: state.status,
      createdAt: state.createdAt,
      finishedAt: state.finishedAt || null,
    }))
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

/** Borra el estado de todos los batches de un proyecto. */
export function deleteBatchesForProject(projectName) {
  let deleted = 0;
  for (const batch of listBatches()) {
    if (batch.projectName === projectName) {
      deleteBatchState(batch.batchId);
      deleted++;
    }
  }
  return deleted;
}

/**
 * Acumulador de estado de un batch en curso.
 *
 * Encapsula el patrón que antes estaba repetido en 5 lugares del handler
 * (agregar índice → volcar arrays → guardar → append), y limita la
 * reescritura del JSON completo a una vez por segundo: con lotes de miles
 * de filas, serializar el array de índices en cada item era puro I/O.
 */
export function createBatchTracker(batchId, initialState) {
  const state = { ...initialState };
  const completed = new Set(initialState.completedIndices || []);
  const errors = new Set(initialState.errorIndices || []);
  let lastFlush = 0;
  let dirty = false;

  const flush = (force = false) => {
    if (!dirty && !force) return;
    const now = Date.now();
    if (!force && now - lastFlush < 1000) return;
    state.completedIndices = [...completed];
    state.errorIndices = [...errors];
    saveBatchState(batchId, state);
    lastFlush = now;
    dirty = false;
  };

  return {
    get completedCount() { return completed.size; },
    get errorCount() { return errors.size; },
    isCompleted: (index) => completed.has(index),

    /** Registra un item (éxito o error) y lo persiste. */
    record(item) {
      if (item.status === 'ok') {
        completed.add(item.index);
        errors.delete(item.index);
      } else {
        errors.add(item.index);
      }
      appendBatchResult(batchId, item);
      dirty = true;
      flush();
    },

    /** Fuerza el volcado del estado a disco. */
    flush: () => flush(true),
  };
}
