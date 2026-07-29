/**
 * IMA Generator — Frontend
 *
 * Dos vistas: procesar un CSV, y explorar los proyectos ya procesados.
 * La comunicación con el backend durante el procesamiento es por SSE.
 */

// ── Estado ─────────────────────────────────────────────────────

let currentFile = null;
let currentProcessId = null;
let currentProjectName = '';
let resumeBatchId = null;
let proposedProjectName = '';
/** Último progreso conocido, para no perderlo en eventos parciales */
let lastProgress = { current: 0, total: 0 };

const els = {};
const ID_LIST = [
  'dropzone', 'dropzoneLabel', 'fileName', 'csvFile', 'btnProcess', 'btnClear',
  'executionControls', 'btnPause', 'btnResume', 'btnStop',
  'formatSelect', 'sizeLimitSelect', 'holguraSelect',
  'projectNameGroup', 'projectNameInput',
  'progressSection', 'progressFill', 'progressText', 'progressPercent',
  'statusBadge', 'logPanel', 'resultsSection', 'resultsBody', 'resultsCount',
  'emptyResults', 'statsBar', 'statTotal', 'statSuccess', 'statErrors',
  'statOverLimit', 'statUnmeasured', 'statSaved',
  'zipContainer', 'zipLink', 'toastContainer',
  'csvPreview', 'csvPreviewCount', 'csvPreviewList',
  'resumeModal', 'resumeModalDesc', 'resumeModalStats',
  'tabProcess', 'tabProjects', 'tabProjectsCount',
  'viewProcess', 'viewProjects', 'projectsList', 'projectsSummary',
  'projectDetail', 'projectDetailName', 'projectDetailMeta',
  'projectDetailBody', 'projectDetailZip', 'projectDetailDelete',
];
for (const id of ID_LIST) els[id] = document.getElementById(id);

// ── Vistas ─────────────────────────────────────────────────────

function switchView(view) {
  const isProjects = view === 'projects';
  els.viewProcess.classList.toggle('hidden', isProjects);
  els.viewProjects.classList.toggle('hidden', !isProjects);
  els.tabProcess.classList.toggle('active', !isProjects);
  els.tabProjects.classList.toggle('active', isProjects);
  els.tabProcess.setAttribute('aria-selected', String(!isProjects));
  els.tabProjects.setAttribute('aria-selected', String(isProjects));
  if (isProjects) loadProjects();
}

// ── Selección de archivo ───────────────────────────────────────

function handleFileSelect(event) {
  const file = event.target.files[0];
  if (file) setFile(file);
}

function slugifyName(value) {
  return String(value || '')
    .replace(/\.csv$/i, '')
    .replace(/[^a-zA-Z0-9\s_-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
    .slice(0, 50);
}

function setFile(file) {
  currentFile = file;
  els.dropzone.classList.add('has-file');
  els.dropzoneLabel.textContent = file.name;
  els.fileName.textContent = formatBytes(file.size);
  els.fileName.classList.remove('hidden');
  els.btnClear.classList.remove('hidden');

  proposedProjectName = slugifyName(file.name) || 'proyecto';
  els.projectNameInput.value = proposedProjectName;
  els.projectNameGroup.classList.remove('hidden');

  const reader = new FileReader();
  reader.onload = (e) => {
    const csvContent = e.target.result;
    resumeBatchId = null;
    showCsvPreview(csvContent);
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
    if (data.found && data.completed > 0) showResumeModal(data);
  } catch (err) {
    console.error('Error consultando estado previo:', err);
  }
}

function showResumeModal(data) {
  const remaining = Math.max(data.totalRows - data.completed, 0);
  const wasStopped = data.status === 'stopped';
  els.resumeModalDesc.textContent = wasStopped
    ? `Este CSV se detuvo con ${data.completed} de ${data.totalRows} imágenes ya procesadas.`
    : `Se encontraron ${data.completed} de ${data.totalRows} imágenes ya procesadas.`;
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
  if (data.projectName) els.projectNameInput.value = data.projectName;
}

function dismissResume() {
  els.resumeModal.classList.add('hidden');
  resumeBatchId = null;
}

function resumeBatch() {
  els.resumeModal.classList.add('hidden');
  startProcess();
}

/** Previsualiza las filas del CSV con el delimitador que se detecte. */
function showCsvPreview(csvContent) {
  const lines = csvContent.split('\n').filter(l => l.trim());
  if (!lines.length) return;

  // Mismo criterio que el backend: el delimitador que produzca más columnas
  const delimiter = [',', ';', '\t', '|']
    .map(d => ({ d, count: (lines[0].match(new RegExp(`\\${d}`, 'g')) || []).length }))
    .sort((a, b) => b.count - a.count)[0].d;

  const rows = lines.slice(1)
    .map(line => line.split(delimiter))
    .filter(cols => cols[0]?.trim() && cols[1]?.trim());
  if (!rows.length) return;

  const pages = new Set(rows.map(cols => cols[0].trim()));
  els.csvPreview.classList.add('visible');
  els.csvPreviewCount.textContent =
    `(${rows.length} imágenes en ${pages.size} ${pages.size === 1 ? 'página' : 'páginas'})`;

  els.csvPreviewList.innerHTML = rows.slice(0, 20).map((cols, i) => {
    const url = cols[0].trim();
    const imgName = cols[1].trim().split('/').pop() || '';
    return `<div class="csv-preview-item">
      <span class="csv-item-num">${i + 1}</span>
      <span class="csv-item-url" title="${escapeHtml(url)}">${escapeHtml(url)}</span>
      <span class="csv-item-img" title="${escapeHtml(imgName)}">${escapeHtml(decodeSafe(imgName))}</span>
    </div>`;
  }).join('');

  if (rows.length > 20) {
    els.csvPreviewList.innerHTML +=
      `<div class="csv-preview-item" style="justify-content:center;color:var(--text-muted)">
        ...y ${rows.length - 20} más
      </div>`;
  }
}

// ── Drag & drop ────────────────────────────────────────────────

els.dropzone.addEventListener('dragover', (e) => {
  e.preventDefault();
  els.dropzone.classList.add('dragover');
});

els.dropzone.addEventListener('dragleave', () => els.dropzone.classList.remove('dragover'));

els.dropzone.addEventListener('drop', (e) => {
  e.preventDefault();
  els.dropzone.classList.remove('dragover');
  const file = e.dataTransfer.files[0];
  if (file && /\.(csv|tsv|txt)$/i.test(file.name)) {
    setFile(file);
    const dt = new DataTransfer();
    dt.items.add(file);
    els.csvFile.files = dt.files;
  } else {
    showToast('Solo archivos .csv', 'error');
  }
});

// ── Log y toasts ───────────────────────────────────────────────

function log(message, type = 'info') {
  const time = new Date().toLocaleTimeString('es-ES', {
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const entry = document.createElement('div');
  entry.className = 'log-entry';
  entry.innerHTML = `<span class="log-time">${time}</span><span class="log-${type}">${escapeHtml(message)}</span>`;
  els.logPanel.appendChild(entry);
  els.logPanel.scrollTop = els.logPanel.scrollHeight;
}

function clearLog() { els.logPanel.innerHTML = ''; }

const TOAST_ICONS = {
  success: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>',
  error: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>',
  info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>',
};

function showToast(message, type = 'info', duration = 3500) {
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.innerHTML = `${TOAST_ICONS[type] || TOAST_ICONS.info}<span>${escapeHtml(message)}</span>`;
  els.toastContainer.appendChild(toast);
  setTimeout(() => {
    toast.style.transition = 'all 0.25s ease';
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(10px)';
    setTimeout(() => toast.remove(), 250);
  }, duration);
}

// ── Estadísticas ───────────────────────────────────────────────

function updateStats(summary) {
  els.statTotal.textContent = summary.total ?? 0;
  els.statSuccess.textContent = summary.success ?? 0;
  els.statErrors.textContent = summary.errors ?? 0;
  els.statOverLimit.textContent = summary.overLimit ?? 0;
  els.statUnmeasured.textContent = summary.unmeasured ?? 0;
  els.statSaved.textContent = formatBytes(summary.totalSavedBytes);
}

// ── Tabla de resultados ────────────────────────────────────────

/** Etiquetas legibles de cada método de medición. */
const METHOD_LABELS = {
  'selector': 'selector CSS',
  'url-exact': 'URL exacta',
  'path-exact': 'ruta exacta',
  'basename-exact': 'nombre exacto',
  'basename-normalized': 'nombre sin acentos',
  'basename-contains': 'nombre parcial',
  'token-overlap': 'coincidencia parcial',
  'no-encontrada': 'no está en la página',
  'pagina-no-cargo': 'la página no cargó',
  'sin-pagina': 'sin URL de página',
};

function addResultRow(data) {
  const tr = document.createElement('tr');

  if (data.status !== 'ok') {
    tr.className = 'row-error';
    tr.innerHTML = `
      <td class="cell-num">${(data.csvLine ?? data.index + 1)}</td>
      <td class="cell-url">${urlLink(data.pageUrl)}</td>
      <td class="cell-image" title="${escapeHtml(data.imageUrl)}">${escapeHtml(fileNameOf(data.imageUrl))}</td>
      <td colspan="8"><span class="badge-error">${escapeHtml(data.error || 'Error')}</span></td>
    `;
    els.resultsBody.appendChild(tr);
    els.emptyResults.classList.add('hidden');
    updateResultsCount();
    return;
  }

  const saved = parseFloat(data.savedPercent);
  const savedClass = saved > 30 ? 'high' : saved > 10 ? 'medium' : 'low';
  const savedCell = formatSaved(data.savedPercent);

  // Fila coloreada si quedó sobre el límite de peso
  if (data.sizeWarning) {
    tr.className = data.optimizedSize > 300 * 1024 ? 'row-critical' : 'row-over-limit';
  }

  const sizeWarnBadge = data.sizeWarning
    ? `<span class="badge-size-warn" title="${escapeHtml(data.sizeWarning)}">⚠ ${Math.round(data.optimizedSize / 1024)}KB</span>`
    : '';

  // Contenedor medido → ancho objetivo con holgura
  let containerHtml = '<span style="color:var(--text-muted)">—</span>';
  if (data.containerWidth) {
    containerHtml = `<strong>${data.containerWidth}px</strong>
      <span style="color:var(--text-muted)">→ ${data.targetWidth}px</span>`;
  } else if (data.targetWidth) {
    containerHtml = `<span style="color:var(--warning)" title="Ancho estimado por heurística, no medido">~${data.targetWidth}px</span>`;
  }

  // Dimensiones original → resultado
  let dimsHtml = '<span style="color:var(--text-muted)">—</span>';
  if (data.widthOriginal && data.heightOriginal) {
    const orig = `${data.widthOriginal}×${data.heightOriginal}`;
    const changed = data.widthOriginal !== data.widthResult || data.heightOriginal !== data.heightResult;
    dimsHtml = changed && data.widthResult
      ? `<span style="color:var(--text-muted);text-decoration:line-through">${orig}</span>
         <span style="color:var(--text-muted)">→</span>
         <span style="font-weight:600;color:var(--success)">${data.widthResult}×${data.heightResult}</span>`
      : `<span style="font-weight:500">${orig}</span>`;
  }

  const methodLabel = METHOD_LABELS[data.measureMethod] || data.measureMethod || '—';
  const measureBadge = data.measured
    ? `<span class="badge badge-measured" title="Medida en la página: ${escapeHtml(methodLabel)}">medida</span>`
    : `<span class="badge badge-unmeasured" title="${escapeHtml(methodLabel)} — el ancho se estimó por heurística">sin medir</span>`;

  const catBadge = data.imageCategory
    ? `<span class="badge-category">${data.imageCategory}</span>` : '';
  const qualityBadge = data.qualityUsed && data.qualityUsed < 82
    ? `<span class="badge-quality">q${data.qualityUsed}</span>` : '';
  const cachedBadge = data.cached ? '<span class="badge badge-cached">cache</span>' : '';
  const noteBadge = data.note
    ? `<span class="badge badge-cached" title="${escapeHtml(data.note)}">svg</span>` : '';

  const downloadUrl = fileUrlFor(data);

  tr.innerHTML = `
    <td class="cell-num">${(data.csvLine ?? data.index + 1)}</td>
    <td class="cell-url">${urlLink(data.pageUrl)}</td>
    <td class="cell-image" title="${escapeHtml(data.imageUrl)}">${escapeHtml(fileNameOf(data.imageUrl))}</td>
    <td class="cell-size">${formatBytes(data.originalSize)}</td>
    <td class="cell-size">${formatBytes(data.optimizedSize)}${sizeWarnBadge}</td>
    <td class="cell-saved ${saved >= 0 ? savedClass : ''}">${savedCell.html || '0%'}</td>
    <td class="cell-container">${containerHtml}</td>
    <td class="cell-dims">${dimsHtml}</td>
    <td>${measureBadge}${catBadge}${qualityBadge}</td>
    <td><span class="badge badge-${data.format}">${data.format}</span>${cachedBadge}${noteBadge}</td>
    <td>${downloadUrl
      ? `<a class="dl-btn" href="${downloadUrl}" download title="Descargar">
          <svg class="icon icon-sm" viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
        </a>`
      : ''}</td>
  `;

  els.resultsBody.appendChild(tr);
  els.emptyResults.classList.add('hidden');
  updateResultsCount();
}

/**
 * URL de descarga de una imagen procesada.
 *
 * Las imágenes viven en `output/{proyecto}/{slug}/{archivo}`; el enlace
 * tiene que incluir la ruta completa. Antes apuntaba solo al nombre del
 * archivo y todas las descargas daban 404.
 */
function fileUrlFor(data) {
  if (!data.filename || !currentProjectName) return null;
  const parts = [currentProjectName, data.slug, data.filename]
    .filter(Boolean)
    .map(part => part.split('/').map(encodeURIComponent).join('/'));
  return `/api/output/${parts.join('/')}`;
}

function urlLink(url) {
  if (!url) return '<span style="color:var(--text-muted)">—</span>';
  return `<a class="url-link" href="${escapeHtml(url)}" target="_blank" rel="noopener"
    title="${escapeHtml(url)}">${escapeHtml(url)}</a>`;
}

function fileNameOf(url) {
  return decodeSafe(String(url || '').split('?')[0].split('/').pop() || '—');
}

function decodeSafe(text) {
  try { return decodeURIComponent(text); } catch { return text; }
}

function updateResultsCount() {
  const total = els.resultsBody.children.length;
  els.resultsCount.textContent = total > 0 ? `(${total} resultados)` : '';
}

// ── Progreso ───────────────────────────────────────────────────

const STATUS_LABELS = {
  measuring: 'Midiendo página',
  downloading: 'Descargando',
  optimizing: 'Optimizando',
  packaging: 'Generando ZIP',
  processing: 'Procesando',
};

const STATUS_CLASSES = {
  measuring: 'status-measuring',
  downloading: 'status-downloading',
  optimizing: 'status-optimizing',
  packaging: 'status-packaging',
  processing: 'status-running',
};

/**
 * Actualiza la barra de progreso.
 * `current`/`total` pueden venir nulos en eventos que solo informan el
 * estado (descargando, optimizando); en ese caso se conserva el último
 * valor conocido en lugar de mostrar NaN.
 */
function updateProgress(current, total, status) {
  if (current !== null && current !== undefined) lastProgress.current = current;
  if (total !== null && total !== undefined) lastProgress.total = total;

  const { current: c, total: t } = lastProgress;
  const pct = t > 0 ? Math.min(Math.round((c / t) * 100), 100) : 0;
  els.progressFill.style.width = `${pct}%`;
  els.progressText.textContent = `${c} / ${t} imágenes`;
  els.progressPercent.textContent = `${pct}%`;

  els.statusBadge.innerHTML = `<span class="status-dot"></span> ${STATUS_LABELS[status] || status}`;
  els.statusBadge.className = `status-badge ${STATUS_CLASSES[status] || 'status-running'}`;
}

// ── Procesamiento ──────────────────────────────────────────────

function startProcess() {
  if (!currentFile) {
    showToast('Seleccioná un archivo CSV primero', 'error');
    return;
  }

  const projectName = slugifyName(els.projectNameInput.value || proposedProjectName) || 'proyecto';
  currentProjectName = projectName;
  lastProgress = { current: 0, total: 0 };

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

  const url = new URL('/api/process', window.location.origin);
  url.searchParams.set('format', els.formatSelect.value);
  url.searchParams.set('aggressiveness', els.sizeLimitSelect.value);
  url.searchParams.set('holgura', els.holguraSelect.value);
  url.searchParams.set('projectName', projectName);
  if (resumeBatchId) url.searchParams.set('resumeBatchId', resumeBatchId);

  const formData = new FormData();
  formData.append('csv', currentFile);

  fetch(url, { method: 'POST', body: formData })
    .then(async (response) => {
      if (!response.ok && !response.body) {
        const text = await response.text().catch(() => '');
        throw new Error(text || `HTTP ${response.status}`);
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const chunks = buffer.split('\n\n');
        buffer = chunks.pop();
        for (const chunk of chunks) {
          if (chunk.trim()) parseSSEChunk(chunk);
        }
      }
      if (buffer.trim()) parseSSEChunk(buffer);
      finishProcess();
    })
    .catch((err) => {
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
    else showToast(data.error || 'No se pudo controlar el proceso', 'error');
  } catch (err) {
    log(`Error: ${err.message}`, 'error');
  }
}

function handleControlAction(action) {
  if (action === 'pause') {
    els.btnPause.classList.add('hidden');
    els.btnResume.classList.remove('hidden');
    els.statusBadge.innerHTML = '<span class="status-dot"></span> Pausado';
    els.statusBadge.className = 'status-badge status-paused';
    log('Proceso pausado', 'warn');
  } else if (action === 'resume') {
    els.btnPause.classList.remove('hidden');
    els.btnResume.classList.add('hidden');
    els.statusBadge.innerHTML = '<span class="status-dot"></span> Procesando';
    els.statusBadge.className = 'status-badge status-running';
    log('Proceso reanudado', 'info');
  } else {
    log('Deteniendo proceso...', 'error');
  }
}

// ── SSE ────────────────────────────────────────────────────────

function parseSSEChunk(chunk) {
  let event = 'message';
  let data = '';
  for (const line of chunk.split('\n')) {
    if (line.startsWith('event: ')) event = line.slice(7).trim();
    else if (line.startsWith('data: ')) data = line.slice(6);
  }
  if (!data) return;
  try {
    handleEvent(event, JSON.parse(data));
  } catch (err) {
    console.error('Error parseando SSE:', err, chunk);
  }
}

function handleEvent(event, data) {
  switch (event) {
    case 'start': {
      currentProcessId = data.processId;
      if (data.projectName) currentProjectName = data.projectName;
      const skipped = data.skipped > 0 ? ` (${data.skipped} ya marcadas como hechas)` : '';
      log(`Procesando ${data.total} imágenes${skipped} · holgura ${data.holgura} · límite ${data.aggressiveness}`, 'info');
      updateProgress(0, data.total, 'processing');
      break;
    }

    case 'resume':
      currentProcessId = data.processId;
      if (data.projectName) currentProjectName = data.projectName;
      log(`Reanudando: ${data.completed} de ${data.total} ya completadas`, 'info');
      updateProgress(data.completed, data.total, 'processing');
      break;

    case 'page':
      if (data.error) {
        log(`Página no cargó: ${data.pageUrl} — ${data.error}`, 'error');
      } else {
        log(`[${data.pageIndex}/${data.totalPages}] ${data.pageUrl} — ${data.inventorySize} imágenes en la página, ${data.images} del CSV`, 'info');
      }
      break;

    case 'progress':
      updateProgress(data.current, data.total, data.status);
      break;

    case 'item':
      addResultRow(data);
      if (data.status === 'ok') {
        const method = data.measured
          ? `medida ${data.containerWidth}px`
          : `SIN MEDIR (${METHOD_LABELS[data.measureMethod] || data.measureMethod})`;
        const warn = data.sizeWarning ? ' ⚠️ sobre el límite' : '';
        log(`#${data.csvLine ?? data.index + 1} -${data.savedPercent}% · ${method}${warn}`,
          data.sizeWarning || !data.measured ? 'warn' : 'ok');
      } else {
        log(`#${data.csvLine ?? data.index + 1} error: ${data.error}`, 'error');
      }
      break;

    case 'stopped':
      log(`Detenido en ${data.current}/${data.total}. ${data.message || ''}`, 'warn');
      if (data.summary) updateStats(data.summary);
      if (data.zipUrl) {
        els.zipLink.href = data.zipUrl;
        els.zipContainer.classList.remove('hidden');
      }
      showToast(`Detenido: ${data.current}/${data.total}. Podés reanudar con el mismo CSV.`, 'info', 6000);
      break;

    case 'complete':
      log('Completado', 'ok');
      updateStats(data.summary);
      if (data.zipUrl) {
        els.zipLink.href = data.zipUrl;
        els.zipContainer.classList.remove('hidden');
      }
      reportMeasurementQuality(data.summary);
      showToast(`${data.summary.success} optimizadas · ${formatBytes(data.summary.totalSavedBytes)} ahorrados`, 'success', 5000);
      break;

    case 'error':
      log(`Error: ${data.message}`, 'error');
      showToast(data.message, 'error', 6000);
      break;
  }
}

/**
 * Avisa cuando la mayoría de las imágenes no se pudo medir.
 *
 * Casi siempre significa que el CSV empareja páginas con imágenes que no
 * están en esas páginas — y en ese caso el ancho de salida es una
 * estimación, no una medición del contenedor.
 */
function reportMeasurementQuality(summary) {
  const { success = 0, unmeasured = 0 } = summary;
  if (!success || !unmeasured) return;
  const pct = Math.round((unmeasured / success) * 100);
  if (pct < 25) return;

  const message = `${unmeasured} de ${success} imágenes (${pct}%) no se encontraron en su página: `
    + 'el ancho se estimó por heurística en lugar de medir el contenedor. '
    + 'Revisá que el CSV empareje cada imagen con la página donde realmente aparece.';
  log(message, 'warn');
  showToast(`${pct}% sin medir — revisá el CSV`, 'error', 9000);
}

function finishProcess() {
  els.executionControls.classList.add('hidden');
  els.btnProcess.classList.remove('hidden');
  els.btnProcess.disabled = false;
  els.statusBadge.innerHTML = '<span class="status-dot"></span> Completado';
  els.statusBadge.className = 'status-badge status-done';
  currentProcessId = null;
}

function clearAll() {
  currentFile = null;
  currentProcessId = null;
  resumeBatchId = null;
  proposedProjectName = '';
  currentProjectName = '';
  lastProgress = { current: 0, total: 0 };
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
  els.btnClear.classList.add('hidden');
  els.resultsBody.innerHTML = '';
  els.emptyResults.classList.remove('hidden');
  els.resultsCount.textContent = '';
  els.progressFill.style.width = '0%';
  els.statusBadge.className = 'status-badge status-idle';
  els.statusBadge.innerHTML = '<span class="status-dot"></span> Esperando';
  els.resumeModal.classList.add('hidden');
  clearLog();
  updateStats({ total: 0, success: 0, errors: 0, overLimit: 0, unmeasured: 0, totalSavedBytes: 0 });
}

// ── Proyectos ──────────────────────────────────────────────────

async function loadProjects() {
  els.projectsList.innerHTML = '<div class="empty-state"><div class="empty-state-title">Cargando…</div></div>';
  try {
    const { projects } = await (await fetch('/api/projects')).json();
    renderProjects(projects);
  } catch (err) {
    els.projectsList.innerHTML =
      `<div class="empty-state"><div class="empty-state-title">No se pudieron cargar los proyectos</div>
        <p style="font-size:0.8125rem">${escapeHtml(err.message)}</p></div>`;
  }
}

function renderProjects(projects) {
  els.tabProjectsCount.textContent = projects.length || '';

  if (!projects.length) {
    els.projectsSummary.textContent = '';
    els.projectsList.innerHTML = `
      <div class="empty-state">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
        </svg>
        <div class="empty-state-title">Todavía no hay proyectos</div>
        <p style="font-size:0.8125rem">Procesá un CSV y aparecerá acá. Los proyectos no se borran solos.</p>
      </div>`;
    return;
  }

  const totalImages = projects.reduce((sum, p) => sum + p.imageCount, 0);
  const totalSaved = projects.reduce((sum, p) => sum + p.savedBytes, 0);
  const totalDisk = projects.reduce((sum, p) => sum + p.diskBytes, 0);
  els.projectsSummary.textContent =
    `(${projects.length} proyectos · ${totalImages} imágenes · ${formatBytes(totalDisk)} en disco · ${formatBytes(totalSaved)} ahorrados)`;

  els.projectsList.innerHTML = projects.map(p => {
    const date = new Date(p.modifiedAt).toLocaleDateString('es-ES',
      { day: '2-digit', month: 'short', year: 'numeric' });
    const problems = [];
    if (p.errors) problems.push(`${p.errors} err`);
    if (p.unmeasured) problems.push(`${p.unmeasured} sin medir`);
    if (p.warnings) problems.push(`${p.warnings} sobre límite`);

    return `<div class="project-row" onclick="openProject('${escapeAttr(p.name)}')">
      <div class="project-name">
        <svg class="icon icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
        </svg>
        <span>${escapeHtml(p.name)}</span>
      </div>
      <div class="project-meta"><strong>${p.imageCount}</strong>imágenes</div>
      <div class="project-meta"><strong>${formatBytes(p.diskBytes)}</strong>en disco</div>
      <div class="project-meta ${p.savedPercent > 0 ? 'good' : ''}">
        <strong>${p.savedPercent > 0 ? '−' + p.savedPercent + '%' : '—'}</strong>ahorro</div>
      <div class="project-meta ${problems.length ? 'warn' : ''}">
        <strong>${problems.length ? problems.join(' · ') : 'sin avisos'}</strong>${date}</div>
    </div>`;
  }).join('');
}

async function openProject(name) {
  try {
    const resp = await fetch(`/api/projects/${encodeURIComponent(name)}`);
    if (!resp.ok) throw new Error('Proyecto no encontrado');
    renderProjectDetail(await resp.json());
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function renderProjectDetail(project) {
  els.projectDetail.classList.remove('hidden');
  els.projectDetailName.textContent = project.name;

  const parts = [`${project.imageCount} imágenes`, `${project.slugs.length} carpetas`];
  if (project.errors.length) parts.push(`${project.errors.length} errores`);
  if (!project.hasMapping) parts.push('sin mapping.csv');
  els.projectDetailMeta.textContent = `(${parts.join(' · ')})`;

  els.projectDetailZip.href = `/api/projects/${encodeURIComponent(project.name)}/download`;
  els.projectDetailDelete.onclick = () => confirmDeleteProject(project.name);

  const groups = project.slugs.map(group => `
    <div class="slug-group">
      <div class="slug-header">
        <span>${escapeHtml(group.slug === '.' ? '(raíz)' : group.slug)}</span>
        <span>${group.images.length} · ${formatBytes(group.bytes)}</span>
      </div>
      <div class="image-grid">
        ${group.images.map(img => imageCard(project.name, img)).join('')}
      </div>
    </div>`).join('');

  const errorsBlock = project.errors.length ? `
    <div class="slug-group">
      <div class="slug-header" style="color:var(--danger)">
        <span>Filas con error (${project.errors.length})</span>
      </div>
      <div style="padding:12px 18px;font-size:0.75rem;line-height:1.7">
        ${project.errors.slice(0, 50).map(e => `
          <div style="display:flex;gap:8px;border-bottom:1px solid var(--border-light);padding:4px 0">
            <span style="color:var(--text-muted);min-width:32px">#${escapeHtml(e.fila)}</span>
            <span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"
              title="${escapeHtml(e.urlImagen)}">${escapeHtml(fileNameOf(e.urlImagen))}</span>
            <span style="color:var(--danger)">${escapeHtml(e.error)}</span>
          </div>`).join('')}
      </div>
    </div>` : '';

  els.projectDetailBody.innerHTML = groups + errorsBlock
    || '<div class="empty-state"><div class="empty-state-title">Carpeta vacía</div></div>';

  els.projectDetail.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function imageCard(projectName, img) {
  const src = `/api/projects/${encodeURIComponent(projectName)}/file/`
    + img.relativePath.split('/').map(encodeURIComponent).join('/');

  const dims = img.anchoFinal
    ? `${img.anchoFinal}px${img.anchoContenedor ? ` · cont. ${img.anchoContenedor}px` : ''}`
    : '';
  const saved = formatSaved(img.savedPercent);
  const warn = img.sizeWarning
    ? `<span title="${escapeHtml(img.sizeWarning)}" style="color:var(--warning)">⚠</span>` : '';
  const unmeasured = img.medido === false && img.metodo
    ? `<span title="No medida: ${escapeHtml(img.metodo)}" style="color:var(--warning)">~</span>` : '';

  return `<div class="image-card">
    <a href="${src}" target="_blank" rel="noopener">
      <img class="image-thumb" src="${src}" alt="${escapeAttr(img.filename)}" loading="lazy">
    </a>
    <div class="image-info">
      <span class="fname" title="${escapeAttr(img.filename)}">${escapeHtml(img.filename)}</span>
      <span class="dim">${formatBytes(img.bytes)}${dims ? ' · ' + escapeHtml(dims) : ''}</span>
      ${saved.html} ${unmeasured} ${warn}
    </div>
  </div>`;
}

/**
 * Formatea el ahorro. Un valor negativo significa que el archivo creció:
 * se muestra con `+` y en color de advertencia, no como un ahorro falso.
 */
function formatSaved(value) {
  const pct = parseFloat(value);
  if (!Number.isFinite(pct) || pct === 0) return { html: '', pct: 0 };
  const grew = pct < 0;
  const text = `${grew ? '+' : '−'}${Math.abs(pct).toFixed(1)}%`;
  const style = grew ? 'color:var(--warning);font-weight:600' : '';
  const title = grew ? ' title="El archivo optimizado quedó más grande que el original"' : '';
  return {
    html: `<span class="${grew ? '' : 'saved'}" style="${style}"${title}> ${text}</span>`,
    pct,
  };
}

function closeProjectDetail() {
  els.projectDetail.classList.add('hidden');
}

async function confirmDeleteProject(name) {
  const ok = window.confirm(
    `¿Borrar el proyecto "${name}"?\n\n`
    + 'Se eliminan del disco todas sus imágenes optimizadas, el mapping.csv '
    + 'y el estado de sus batches. Esta acción no se puede deshacer.'
  );
  if (!ok) return;

  try {
    const resp = await fetch(`/api/projects/${encodeURIComponent(name)}`, { method: 'DELETE' });
    if (!resp.ok) throw new Error((await resp.json()).error || 'No se pudo borrar');
    showToast(`Proyecto "${name}" borrado`, 'success');
    closeProjectDetail();
    loadProjects();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// ── Utilidades ─────────────────────────────────────────────────

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${parseFloat((bytes / 1024 ** i).toFixed(1))} ${units[i]}`;
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text === null || text === undefined ? '' : String(text);
  return div.innerHTML;
}

/** Escapa para usar dentro de un atributo HTML entre comillas dobles. */
function escapeAttr(text) {
  return escapeHtml(text).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Precargar el contador de proyectos en la pestaña
fetch('/api/projects')
  .then(r => r.json())
  .then(({ projects }) => { els.tabProjectsCount.textContent = projects.length || ''; })
  .catch(() => {});
