/**
 * IMA Generator v2.1 - Frontend Application
 *
 * Interfaz web para el procesamiento de imágenes.
 * Gestiona la carga de CSVs, configuración de proyecto,
 * comunicación SSE con el backend y visualización de resultados.
 */

/** Archivo CSV seleccionado */
let currentFile = null;
/** ID del proceso SSE activo */
let currentProcessId = null;
/** Estado de pausa del proceso */
let isPaused = false;
/** ID de batch para reanudación */
let resumeBatchId = null;
/** Contenido del CSV pendiente de procesamiento */
let pendingCsvContent = '';
/** Nombre propuesto para el proyecto (derivado del nombre del CSV) */
let proposedProjectName = '';

const els = {
  dropzone: document.getElementById('dropzone'),
  dropzoneIcon: document.getElementById('dropzoneIcon'),
  dropzoneLabel: document.getElementById('dropzoneLabel'),
  fileName: document.getElementById('fileName'),
  csvFile: document.getElementById('csvFile'),
  btnProcess: document.getElementById('btnProcess'),
  btnClear: document.getElementById('btnClear'),
  executionControls: document.getElementById('executionControls'),
  btnPause: document.getElementById('btnPause'),
  btnResume: document.getElementById('btnResume'),
  btnStop: document.getElementById('btnStop'),
  formatSelect: document.getElementById('formatSelect'),
  sizeLimitSelect: document.getElementById('sizeLimitSelect'),
  /** Grupo de controles del nombre de proyecto */
  projectNameGroup: document.getElementById('projectNameGroup'),
  /** Input para el nombre del proyecto */
  projectNameInput: document.getElementById('projectNameInput'),
  progressSection: document.getElementById('progressSection'),
  progressFill: document.getElementById('progressFill'),
  progressText: document.getElementById('progressText'),
  progressPercent: document.getElementById('progressPercent'),
  statusBadge: document.getElementById('statusBadge'),
  logPanel: document.getElementById('logPanel'),
  resultsSection: document.getElementById('resultsSection'),
  resultsBody: document.getElementById('resultsBody'),
  resultsCount: document.getElementById('resultsCount'),
  emptyResults: document.getElementById('emptyResults'),
  statsBar: document.getElementById('statsBar'),
  statTotal: document.getElementById('statTotal'),
  statSuccess: document.getElementById('statSuccess'),
  statErrors: document.getElementById('statErrors'),
  statOverLimit: document.getElementById('statOverLimit'),
  statSaved: document.getElementById('statSaved'),
  zipContainer: document.getElementById('zipContainer'),
  zipLink: document.getElementById('zipLink'),
  toastContainer: document.getElementById('toastContainer'),
  csvPreview: document.getElementById('csvPreview'),
  csvPreviewCount: document.getElementById('csvPreviewCount'),
  csvPreviewList: document.getElementById('csvPreviewList'),
  resumeModal: document.getElementById('resumeModal'),
  resumeModalDesc: document.getElementById('resumeModalDesc'),
  resumeModalStats: document.getElementById('resumeModalStats'),
};

// ── File Handling ──────────────────────────────────────────────

/**
 * Maneja la selección de archivo CSV desde el input.
 * @param {Event} event - Evento change del input file
 */
function handleFileSelect(event) {
  const file = event.target.files[0];
  if (file) setFile(file);
}

/**
 * Establece el archivo CSV actual, propone nombre de proyecto
 * y verifica si existe un batch incompleto para reanudar.
 * @param {File} file - Archivo CSV seleccionado
 */
function setFile(file) {
  currentFile = file;
  els.dropzone.classList.add('has-file');
  els.dropzoneLabel.textContent = file.name;
  els.fileName.textContent = formatBytes(file.size);
  els.fileName.classList.remove('hidden');

  // Proponer nombre del proyecto desde el nombre del CSV
  const csvName = file.name.replace(/\.csv$/i, '').replace(/[^a-zA-Z0-9\s_-]/g, '').replace(/\s+/g, '-').replace(/-+/g, '-').toLowerCase().slice(0, 50);
  proposedProjectName = csvName || 'proyecto';
  els.projectNameInput.value = proposedProjectName;
  els.projectNameGroup.classList.remove('hidden');

  // Parse CSV for preview and check for incomplete batches
  const reader = new FileReader();
  reader.onload = (e) => {
    const csvContent = e.target.result;
    pendingCsvContent = csvContent;
    resumeBatchId = null;

    const lines = csvContent.split('\n').filter(l => l.trim());
    const dataRows = lines.slice(1).filter(l => {
      const cols = l.split(/[;,]/);
      return cols[0]?.trim() && cols[1]?.trim();
    });
    if (dataRows.length > 0) {
      showCsvPreview(dataRows);
    }

    // Check for incomplete batch
    checkIncompleteBatch(csvContent);
  };
  reader.readAsText(file);

  showToast(`"${file.name}" listo`, 'success');
}

async function checkIncompleteBatch(csvContent) {
  try {
    const resp = await fetch('/api/check-state', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ csvContent }),
    });
    const data = await resp.json();

    if (data.found && data.completed > 0) {
      showResumeModal(data);
    }
  } catch (err) {
    console.error('Error checking state:', err);
  }
}

function showResumeModal(data) {
  const remaining = data.totalRows - data.completed;
  els.resumeModalDesc.textContent = `Se encontraron ${data.completed} de ${data.totalRows} imágenes ya procesadas.`;
  els.resumeModalStats.innerHTML = `
    <div class="modal-stat">
      <span class="modal-stat-value">${data.completed}</span>
      <span class="modal-stat-label">Hechas</span>
    </div>
    <div class="modal-stat">
      <span class="modal-stat-value">${data.errors}</span>
      <span class="modal-stat-label">Errores</span>
    </div>
    <div class="modal-stat">
      <span class="modal-stat-value">${remaining}</span>
      <span class="modal-stat-label">Restantes</span>
    </div>
  `;
  els.resumeModal.classList.remove('hidden');
  resumeBatchId = data.batchId;
}

function dismissResume() {
  els.resumeModal.classList.add('hidden');
  resumeBatchId = null;
}

function resumeBatch() {
  els.resumeModal.classList.add('hidden');
  startProcess();
}

function showCsvPreview(rows) {
  els.csvPreview.classList.add('visible');
  els.csvPreviewCount.textContent = `(${rows.length} imágenes)`;
  els.csvPreviewList.innerHTML = rows.slice(0, 20).map((row, i) => {
    const cols = row.split(/[;,]/);
    const url = cols[0]?.trim() || '';
    const img = cols[1]?.trim() || '';
    const imgName = img.split('/').pop() || '';
    return `<div class="csv-preview-item">
      <span class="csv-item-num">${i + 1}</span>
      <span class="csv-item-url" title="${escapeHtml(url)}">${escapeHtml(url)}</span>
      <span class="csv-item-img" title="${escapeHtml(imgName)}">${escapeHtml(imgName)}</span>
    </div>`;
  }).join('');
  if (rows.length > 20) {
    els.csvPreviewList.innerHTML += `<div class="csv-preview-item" style="justify-content:center;color:var(--text-muted)">...y ${rows.length - 20} más</div>`;
  }
}

// ── Drag & Drop ────────────────────────────────────────────────

els.dropzone.addEventListener('dragover', (e) => {
  e.preventDefault();
  els.dropzone.classList.add('dragover');
});

els.dropzone.addEventListener('dragleave', () => {
  els.dropzone.classList.remove('dragover');
});

els.dropzone.addEventListener('drop', (e) => {
  e.preventDefault();
  els.dropzone.classList.remove('dragover');
  const file = e.dataTransfer.files[0];
  if (file && file.name.endsWith('.csv')) {
    setFile(file);
    const dt = new DataTransfer();
    dt.items.add(file);
    els.csvFile.files = dt.files;
  } else {
    showToast('Solo archivos .csv', 'error');
  }
});

// ── Logs ───────────────────────────────────────────────────────

function log(message, type = 'info') {
  const now = new Date();
  const time = now.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const entry = document.createElement('div');
  entry.className = 'log-entry';
  entry.innerHTML = `<span class="log-time">${time}</span><span class="log-${type}">${escapeHtml(message)}</span>`;
  els.logPanel.appendChild(entry);
  els.logPanel.scrollTop = els.logPanel.scrollHeight;
}

function clearLog() {
  els.logPanel.innerHTML = '';
}

// ── Toast ──────────────────────────────────────────────────────

function showToast(message, type = 'info') {
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  const icons = {
    success: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>',
    error: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>',
    info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>',
  };
  toast.innerHTML = `${icons[type] || icons.info}<span>${escapeHtml(message)}</span>`;
  els.toastContainer.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(10px)';
    toast.style.transition = 'all 0.25s ease';
    setTimeout(() => toast.remove(), 250);
  }, 3500);
}

// ── Stats ──────────────────────────────────────────────────────

function updateStats(summary) {
  els.statTotal.textContent = summary.total;
  els.statSuccess.textContent = summary.success;
  els.statErrors.textContent = summary.errors;
  els.statOverLimit.textContent = summary.overLimit || 0;
  els.statSaved.textContent = formatBytes(summary.totalSavedBytes);
}

// ── Results Table ──────────────────────────────────────────────

function addResultRow(data) {
  const tr = document.createElement('tr');
  const isOk = data.status === 'ok';

  if (!isOk) {
    tr.className = 'row-error';
    tr.innerHTML = `
      <td class="cell-num">${data.index + 1}</td>
      <td class="cell-url"><a class="url-link" href="${escapeHtml(data.pageUrl)}" target="_blank" rel="noopener" title="${escapeHtml(data.pageUrl)}">${escapeHtml(data.pageUrl)}</a></td>
      <td class="cell-image" title="${escapeHtml(data.imageUrl)}">${escapeHtml(data.imageUrl.split('/').pop())}</td>
      <td colspan="7">
        <span class="badge-error">${escapeHtml(data.error)}</span>
      </td>
    `;
  } else {
    const saved = parseFloat(data.savedPercent);
    const savedClass = saved > 30 ? 'high' : saved > 10 ? 'medium' : 'low';
    const fmtClass = `badge-${data.format}`;
    const cachedBadge = data.cached ? '<span class="badge badge-cached">cache</span>' : '';
    const methodBadge = data.measureMethod ? `<span class="badge badge-method">${escapeHtml(data.measureMethod)}</span>` : '<span style="color:var(--text-muted)">—</span>';

    // Size warning badges
    let sizeWarnBadge = '';
    let rowClass = '';
    if (data.sizeWarning) {
      const isCritical = data.optimizedSize > 300 * 1024;
      sizeWarnBadge = `<span class="badge-size-warn" title="${escapeHtml(data.sizeWarning)}">⚠ ${Math.round(data.optimizedSize / 1024)}KB</span>`;
      rowClass = isCritical ? 'row-critical' : 'row-over-limit';
    }

    // Category and quality badges
    const catLabel = data.imageCategory ? data.imageCategory.charAt(0).toUpperCase() + data.imageCategory.slice(1) : '';
    const catBadge = catLabel ? `<span class="badge-category">${catLabel}</span>` : '';
    const qualityBadge = data.qualityUsed && data.qualityUsed < 82 ? `<span class="badge-quality">q${data.qualityUsed}</span>` : '';

    let dimsHtml = '<span style="color:var(--text-muted)">—</span>';
    if (data.widthOriginal && data.heightOriginal) {
      const orig = `${data.widthOriginal}×${data.heightOriginal}`;
      if (data.widthResult && data.heightResult) {
        const result = `${data.widthResult}×${data.heightResult}`;
        const changed = data.widthOriginal !== data.widthResult || data.heightOriginal !== data.heightResult;
        dimsHtml = changed
          ? `<span style="color:var(--text-muted);text-decoration:line-through">${orig}</span> <span style="color:var(--text-muted)">→</span> <span style="font-weight:600;color:var(--success)">${result}</span>`
          : `<span style="font-weight:500">${orig}</span>`;
      } else {
        dimsHtml = `<span style="font-weight:500">${orig}</span>`;
      }
    }

    if (rowClass) tr.className = rowClass;

    tr.innerHTML = `
      <td class="cell-num">${data.index + 1}</td>
      <td class="cell-url"><a class="url-link" href="${escapeHtml(data.pageUrl)}" target="_blank" rel="noopener" title="${escapeHtml(data.pageUrl)}">${escapeHtml(data.pageUrl)}</a></td>
      <td class="cell-image" title="${escapeHtml(data.imageUrl)}">${escapeHtml(data.imageUrl.split('/').pop())}</td>
      <td class="cell-size">${formatBytes(data.originalSize)}</td>
      <td class="cell-size">${formatBytes(data.optimizedSize)}${sizeWarnBadge}</td>
      <td class="cell-saved ${savedClass}">${data.savedPercent}%</td>
      <td class="cell-dims">${dimsHtml}</td>
      <td>${methodBadge}${catBadge}${qualityBadge}</td>
      <td><span class="badge ${fmtClass}">${data.format}</span>${cachedBadge}</td>
      <td><a class="dl-btn" href="/api/output/${data.filename}" download title="Descargar"><svg class="icon icon-sm" viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg></a></td>
    `;
  }

  els.resultsBody.appendChild(tr);
  els.emptyResults.classList.add('hidden');
  updateResultsCount();
}

function updateResultsCount() {
  const total = els.resultsBody.children.length;
  if (total > 0) {
    els.resultsCount.textContent = `(${total} resultados)`;
  }
}

// ── Progress ───────────────────────────────────────────────────

function updateProgress(current, total, status) {
  const pct = total > 0 ? Math.round((current / total) * 100) : 0;
  els.progressFill.style.width = `${pct}%`;
  els.progressText.textContent = `${current} / ${total} imágenes`;
  els.progressPercent.textContent = `${pct}%`;

  const labels = {
    measuring: 'Midiendo',
    downloading: 'Descargando',
    optimizing: 'Optimizando',
    packaging: 'Generando ZIP',
    processing: 'Procesando',
  };
  const badgeClasses = {
    measuring: 'status-measuring',
    downloading: 'status-downloading',
    optimizing: 'status-optimizing',
    packaging: 'status-packaging',
    processing: 'status-running',
  };

  const label = labels[status] || status;
  els.statusBadge.innerHTML = `<span class="status-dot"></span> ${label}`;
  els.statusBadge.className = `status-badge ${badgeClasses[status] || 'status-running'}`;
}

// ── Main Process ───────────────────────────────────────────────

/**
 * Inicia el procesamiento del CSV actual.
 * Envía el archivo, formato y nombre de proyecto al backend
 * y establece la conexión SSE para recibir eventos en tiempo real.
 */
function startProcess() {
  if (!currentFile) {
    showToast('Seleccioná un archivo CSV primero', 'error');
    return;
  }

  const format = els.formatSelect.value;
  const aggressiveness = els.sizeLimitSelect.value;
  const projectName = (els.projectNameInput.value || proposedProjectName).trim().replace(/[^a-zA-Z0-9\s_-]/g, '').replace(/\s+/g, '-').replace(/-+/g, '-').toLowerCase().slice(0, 50) || 'proyecto';
  const formData = new FormData();
  formData.append('csv', currentFile);

  clearLog();
  els.resultsBody.innerHTML = '';
  els.emptyResults.classList.remove('hidden');
  els.resultsCount.textContent = '';

  els.progressSection.classList.add('visible');
  els.resultsSection.classList.add('visible');
  els.statsBar.classList.add('visible');

  els.btnProcess.classList.add('hidden');
  els.executionControls.classList.remove('hidden');
  els.btnPause.classList.remove('hidden');
  els.btnResume.classList.add('hidden');
  els.zipContainer.classList.add('hidden');

  currentProcessId = null;
  isPaused = false;

  const url = new URL('/api/process', window.location.origin);
  url.searchParams.set('format', format);
  url.searchParams.set('aggressiveness', aggressiveness);
  url.searchParams.set('projectName', projectName);
  if (resumeBatchId) {
    url.searchParams.set('resumeBatchId', resumeBatchId);
  }

  fetch(url, {
    method: 'POST',
    body: formData,
  }).then(async (response) => {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n\n');
      buffer = lines.pop();
      for (const chunk of lines) {
        if (!chunk.trim()) continue;
        parseSSEChunk(chunk);
      }
    }

    if (buffer.trim()) parseSSEChunk(buffer);
    finishProcess();
  }).catch((err) => {
    log(`Error: ${err.message}`, 'error');
    showToast('Error de conexión', 'error');
    finishProcess();
  });
}

async function controlProcess(action) {
  if (!currentProcessId) return;
  try {
    const resp = await fetch(`/api/control/${currentProcessId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action }),
    });
    const data = await resp.json();
    if (data.ok) handleControlAction(action);
    else showToast(data.error || 'Error al controlar el proceso', 'error');
  } catch (err) {
    log(`Error: ${err.message}`, 'error');
  }
}

function handleControlAction(action) {
  switch (action) {
    case 'pause':
      isPaused = true;
      els.btnPause.classList.add('hidden');
      els.btnResume.classList.remove('hidden');
      els.statusBadge.innerHTML = '<span class="status-dot"></span> Pausado';
      els.statusBadge.className = 'status-badge status-paused';
      log('Proceso pausado', 'warn');
      break;
    case 'resume':
      isPaused = false;
      els.btnPause.classList.remove('hidden');
      els.btnResume.classList.add('hidden');
      els.statusBadge.innerHTML = '<span class="status-dot"></span> Procesando';
      els.statusBadge.className = 'status-badge status-running';
      log('Proceso reanudado', 'info');
      break;
    case 'stop':
      log('Deteniendo proceso...', 'error');
      break;
  }
}

// ── SSE Parsing ────────────────────────────────────────────────

function parseSSEChunk(chunk) {
  const lines = chunk.split('\n');
  let event = 'message';
  let data = '';
  for (const line of lines) {
    if (line.startsWith('event: ')) event = line.slice(7);
    else if (line.startsWith('data: ')) data = line.slice(6);
  }
  if (!data) return;
  try {
    handleEvent(event, JSON.parse(data));
  } catch (err) {
    console.error('SSE parse error:', err);
  }
}

function handleEvent(event, data) {
  switch (event) {
    case 'start':
      currentProcessId = data.processId;
      const skippedMsg = data.skipped > 0 ? ` (${data.skipped} saltadas)` : '';
      log(`Procesando ${data.total} imágenes${skippedMsg}...`, 'info');
      updateProgress(0, data.total, 'processing');
      break;
    case 'resume':
      currentProcessId = data.processId;
      log(`Reanudando batch: ${data.completed} de ${data.total} ya completadas`, 'info');
      updateProgress(data.completed, data.total, 'processing');
      break;
    case 'progress':
      updateProgress(data.current, data.total, data.status);
      break;
    case 'item':
      addResultRow(data);
      if (data.status === 'ok') {
        const methodLabel = data.measureMethod ? ` (${data.measureMethod})` : '';
        const sizeWarn = data.sizeWarning ? ` ⚠️ ${data.sizeWarning}` : '';
        log(`#${data.index + 1} optimizada: -${data.savedPercent}%${methodLabel}${sizeWarn}`, data.sizeWarning ? 'warn' : 'ok');
      } else {
        log(`#${data.index + 1} error: ${data.error}`, 'error');
      }
      break;
    case 'stopped':
      log(`Detenido en ${data.current}/${data.total}`, 'error');
      showToast(`Detenido. ${data.current}/${data.total} procesadas`, 'info');
      finishProcess();
      break;
    case 'complete':
      log('Completado', 'ok');
      updateStats(data.summary);
      if (data.zipUrl) {
        els.zipLink.href = data.zipUrl;
        els.zipContainer.classList.remove('hidden');
      }
      showToast(`${data.summary.success} optimizadas, ${data.summary.errors} errores`, 'success');
      break;
    case 'error':
      log(`Error: ${data.message}`, 'error');
      showToast(data.message, 'error');
      break;
  }
}

// ── Finish ─────────────────────────────────────────────────────

function finishProcess() {
  els.executionControls.classList.add('hidden');
  els.btnProcess.classList.remove('hidden');
  els.btnProcess.disabled = false;
  els.statusBadge.innerHTML = '<span class="status-dot"></span> Completado';
  els.statusBadge.className = 'status-badge status-done';
  currentProcessId = null;
  isPaused = false;
}

function clearAll() {
  currentFile = null;
  currentProcessId = null;
  isPaused = false;
  resumeBatchId = null;
  pendingCsvContent = null;
  proposedProjectName = '';
  els.csvFile.value = '';
  els.dropzone.classList.remove('has-file');
  els.dropzoneLabel.textContent = 'Arrastrá un CSV o hacé clic';
  els.fileName.classList.add('hidden');
  els.progressSection.classList.remove('visible');
  els.resultsSection.classList.remove('visible');
  els.statsBar.classList.remove('visible');
  els.csvPreview.classList.remove('visible');
  els.zipContainer.classList.add('hidden');
  els.executionControls.classList.add('hidden');
  els.projectNameGroup.classList.add('hidden');
  els.projectNameInput.value = '';
  els.btnProcess.classList.remove('hidden');
  els.btnProcess.disabled = false;
  els.resultsBody.innerHTML = '';
  els.emptyResults.classList.remove('hidden');
  els.resultsCount.textContent = '';
  clearLog();
  els.btnClear.classList.add('hidden');
  els.progressFill.style.width = '0%';
  els.statusBadge.className = 'status-badge status-idle';
  els.statusBadge.innerHTML = '<span class="status-dot"></span> Esperando';
  els.resumeModal.classList.add('hidden');
  els.statOverLimit.textContent = '0';
}

// ── Utilities ──────────────────────────────────────────────────

function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text || '';
  return div.innerHTML;
}
