/**
 * Control de ejecución de procesos: pausar, reanudar, detener.
 */

/** Procesos activos. Key: processId, Value: controller */
const activeProcesses = new Map();

/**
 * Crea un controlador con estados `running | paused | stopped`.
 *
 * La pausa se implementa con una Promise que el proceso espera antes de
 * cada imagen; reanudar la resuelve. No hay polling.
 */
export function createProcessController() {
  let status = 'running';
  let resumeResolve = null;
  let resumePromise = null;

  const updateStatus = (newStatus) => {
    status = newStatus;
    // Al salir de pausa (por resume o por stop) hay que liberar al que espera
    if (newStatus !== 'paused' && resumeResolve) {
      resumeResolve();
      resumeResolve = null;
      resumePromise = null;
    }
  };

  /**
   * Punto de control. Si está pausado, espera; si está detenido, lo informa.
   * @returns {Promise<'running'|'stopped'>}
   */
  const checkStatus = async () => {
    if (status === 'stopped') return 'stopped';
    if (status === 'paused') {
      if (!resumePromise) {
        resumePromise = new Promise(resolve => { resumeResolve = resolve; });
      }
      await resumePromise;
      return checkStatus();
    }
    return 'running';
  };

  return { getStatus: () => status, updateStatus, checkStatus };
}

export function registerProcess(processId, controller) {
  activeProcesses.set(processId, controller);
}

export function unregisterProcess(processId) {
  activeProcesses.delete(processId);
}

export function getProcess(processId) {
  return activeProcesses.get(processId);
}

export function newProcessId() {
  return `proc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}
