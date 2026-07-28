/**
 * IMA Generator v3.0 - Backend
 * 
 * Servidor Express que procesa CSVs con URLs de imágenes,
 * las mide en su contexto web con Puppeteer, y las optimiza
 * con Sharp en el formato más adecuado.
 * 
 * @author OpenCode
 * @version 3.0.1
 */

import express from 'express';
import multer from 'multer';
import sharp from 'sharp';
import { parse } from 'csv-parse/sync';
import { readFileSync, unlinkSync, mkdirSync, existsSync, createWriteStream, readdirSync, statSync, writeFileSync, appendFileSync, rmdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';
import archiver from 'archiver';
import { createHash } from 'crypto';

// ─── Configuración inicial ──────────────────────────────────────

/** Directorio base del proyecto */
const __dirname = dirname(fileURLToPath(import.meta.url));

/** Instancia de Express */
const app = express();

/** Puerto del servidor (default: 3000) */
const PORT = process.env.PORT || 3000;

/** Middleware para upload de archivos CSV */
const upload = multer({ dest: join(__dirname, 'uploads') });

/** Directorio de salida para imágenes optimizadas */
const outputDir = join(__dirname, 'output');

/** Directorio temporal para archivos ZIP */
const tempZipsDir = join(__dirname, 'temp-zips');

/** Directorio para persistencia de estado de batches */
const stateDir = join(__dirname, 'state');

// Crear directorios si no existen
if (!existsSync(outputDir)) mkdirSync(outputDir, { recursive: true });
if (!existsSync(tempZipsDir)) mkdirSync(tempZipsDir, { recursive: true });
if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true });

// ─── Gestión de Estado de Batches ───────────────────────────────

/**
 * Genera un hash SHA-256 del contenido del CSV.
 */
function hashCSV(csvContent) {
  return createHash('sha256').update(csvContent).digest('hex').slice(0, 16);
}

/**
 * Genera un ID único para un batch.
 */
function generateBatchId(csvHash) {
  return `batch_${csvHash}_${Date.now()}`;
}

/**
 * Guarda el estado de un batch en disco.
 */
function saveBatchState(batchId, state) {
  const filePath = join(stateDir, `${batchId}.json`);
  writeFileSync(filePath, JSON.stringify(state, null, 2));
}

/**
 * Carga el estado de un batch desde disco.
 */
function loadBatchState(batchId) {
  const filePath = join(stateDir, `${batchId}.json`);
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch (_) {
    return null;
  }
}

/**
 * Busca batches incompletos por hash de CSV.
 * Retorna el más reciente que no esté completado.
 */
function findIncompleteBatch(csvHash) {
  const files = readdirSync(stateDir).filter(f => f.startsWith(`batch_${csvHash}_`) && f.endsWith('.json'));
  if (!files.length) return null;

  for (const file of files.sort().reverse()) {
    const batchId = file.replace('.json', '');
    const state = loadBatchState(batchId);
    if (state && state.status !== 'completed') {
      return state;
    }
  }
  return null;
}

/**
 * Agrega un item completado al log de resultados del batch.
 */
function appendBatchResult(batchId, itemData) {
  const filePath = join(stateDir, `${batchId}-results.jsonl`);
  appendFileSync(filePath, JSON.stringify(itemData) + '\n');
}

/**
 * Carga todos los resultados de un batch.
 */
function loadBatchResults(batchId) {
  const filePath = join(stateDir, `${batchId}-results.jsonl`);
  if (!existsSync(filePath)) return [];
  const lines = readFileSync(filePath, 'utf-8').trim().split('\n');
  return lines.map(line => {
    try { return JSON.parse(line); } catch (_) { return null; }
  }).filter(Boolean);
}

/**
 * Marca un batch como completado y limpia archivos temporales.
 */
function completeBatchState(batchId) {
  const state = loadBatchState(batchId);
  if (state) {
    state.status = 'completed';
    saveBatchState(batchId, state);
  }
}

/**
 * Limpia estados de batches incompletos (para limpieza manual).
 */
function cleanupIncompleteState(batchId) {
  const stateFile = join(stateDir, `${batchId}.json`);
  const resultsFile = join(stateDir, `${batchId}-results.jsonl`);
  if (existsSync(stateFile)) unlinkSync(stateFile);
  if (existsSync(resultsFile)) unlinkSync(resultsFile);
}

// Middlewares
app.use(express.static(join(__dirname, 'public')));
app.use(express.json());

// ─── Control de Procesos ────────────────────────────────────────

/**
 * Mapa de procesos activos en memoria.
 * Key: processId, Value: ProcessController
 */
const activeProcesses = new Map();

/**
 * Crea un controlador de proceso con estados: running | paused | stopped
 * Utiliza Promises para implementar pausa/reanudación asíncrona.
 * 
 * @returns {Object} Controller con métodos getStatus, updateStatus, checkStatus
 */
function createProcessController() {
  let status = 'running'; // Estados posibles: 'running' | 'paused' | 'stopped'
  let resumeResolve = null;
  let resumePromise = null;

  /**
   * Actualiza el estado del proceso.
   * Si cambia a 'running', resuelve la Promise de pausa si existe.
   */
  const updateStatus = (newStatus) => {
    status = newStatus;
    if (newStatus === 'running' && resumeResolve) {
      resumeResolve();
      resumeResolve = null;
      resumePromise = null;
    }
  };

  /**
   * Verifica el estado actual.
   * Si está pausado, espera hasta que se reanude.
   * Si está detenido, retorna inmediatamente.
   * 
   * @returns {Promise<string>} Estado actual del proceso
   */
  const checkStatus = async () => {
    if (status === 'stopped') return 'stopped';
    if (status === 'paused') {
      if (!resumePromise) {
        resumePromise = new Promise((resolve) => {
          resumeResolve = resolve;
        });
      }
      await resumePromise;
      return checkStatus(); // Recursivo por si se pausó de nuevo
    }
    return 'running';
  };

  return {
    getStatus: () => status,
    updateStatus,
    checkStatus,
  };
}

// ─── Limpieza Automática ────────────────────────────────────────

/**
 * Elimina archivos y carpetas de proyecto más antiguos que maxAgeMs.
 * Respeta la estructura de subcarpetas: output/{proyecto}/{slug}/{archivos}.
 * Solo elimina una carpeta de proyecto completa si todos sus archivos son viejos.
 * @param {string} dir - Directorio a limpiar
 * @param {number} maxAgeMs - Edad máxima en milisegundos (default: 24h)
 */
function cleanupOldFiles(dir, maxAgeMs = 24 * 60 * 60 * 1000) {
  try {
    const now = Date.now();
    const entries = readdirSync(dir);
    for (const entry of entries) {
      const fpath = join(dir, entry);
      try {
        const stat = statSync(fpath);
        if (stat.isDirectory()) {
          // Si es carpeta de proyecto, verificar si toda la carpeta es vieja
          const projectFiles = readdirSync(fpath);
          let allOld = true;
          for (const pf of projectFiles) {
            const pfPath = join(fpath, pf);
            const pfStat = statSync(pfPath);
            if (pfStat.isDirectory()) {
              // Subcarpeta de slug, verificar archivos dentro
              const subFiles = readdirSync(pfPath);
              for (const sf of subFiles) {
                const sfStat = statSync(join(pfPath, sf));
                if (now - sfStat.mtimeMs <= maxAgeMs) {
                  allOld = false;
                  break;
                }
              }
            } else if (now - pfStat.mtimeMs <= maxAgeMs) {
              allOld = false;
            }
            if (!allOld) break;
          }
          if (allOld && projectFiles.length > 0) {
            // Eliminar toda la carpeta de proyecto
            for (const pf of projectFiles) {
              const pfPath = join(fpath, pf);
              const pfStat = statSync(pfPath);
              if (pfStat.isDirectory()) {
                const subFiles = readdirSync(pfPath);
                for (const sf of subFiles) unlinkSync(join(pfPath, sf));
              rmdirSync(pfPath);
              } else {
                unlinkSync(pfPath);
              }
            }
            rmdirSync(fpath);
          }
        } else if (now - stat.mtimeMs > maxAgeMs) {
          unlinkSync(fpath);
        }
      } catch (_) {}
    }
  } catch (_) {}
}

// Ejecutar limpieza cada hora
setInterval(() => {
  cleanupOldFiles(outputDir);
  cleanupOldFiles(tempZipsDir);
  cleanupOldFiles(join(__dirname, 'uploads'));
}, 60 * 60 * 1000);

// ─── Helpers ────────────────────────────────────────────────────

/**
 * Genera un slug seguro desde una URL de página.
 * @param {string} url - URL de la página
 * @returns {string} Slug para usar como nombre de subcarpeta
 * @example slugFromUrl("https://ejemplo.com/blog/mi-post") // "blog/mi-post"
 * @example slugFromUrl("https://ejemplo.com/contacto") // "contacto"
 */
function slugFromUrl(url) {
  try {
    const u = new URL(url);
    let path = u.pathname.replace(/^\/|\/$/g, '');
    if (!path) return '_inicio';
    return path.replace(/[^a-zA-Z0-9\u00C0-\u024F/_-]/g, '-').replace(/-+/g, '-').toLowerCase();
  } catch (_) {
    const clean = (url || '').replace(/^https?:\/\//, '').replace(/[^a-zA-Z0-9\u00C0-\u024F/_-]/g, '-').replace(/-+/g, '-').toLowerCase();
    return clean || '_sin-pagina';
  }
}

/**
 * Extrae el dominio de una URL para usar como prefijo en colisiones de slug.
 * @param {string} url - URL de la página
 * @returns {string} Dominio sanitizado para usar como prefijo
 * @example domainPrefix("https://www.ejemplo.com/page") // "ejemplo-com"
 */
function domainPrefix(url) {
  try {
    const u = new URL(url);
    return u.hostname.replace(/^www\./, '').replace(/\./g, '-');
  } catch (_) {
    return 'desconocido';
  }
}

/**
 * Sanitiza un nombre de proyecto para usar como nombre de carpeta.
 * @param {string} name - Nombre propuesto por el usuario
 * @returns {string} Nombre sanitizado seguro para sistema de archivos
 */
function sanitizeProjectName(name) {
  return (name || 'sin-nombre')
    .replace(/[^a-zA-Z0-9\u00C0-\u024F\s_-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 50)
    .toLowerCase();
}

/**
 * Detecta si una fila es encabezado comparando contra keywords comunes.
 * @param {string[]} row - Fila del CSV
 * @returns {boolean} True si parece ser encabezado
 */
function isHeaderRow(row) {
  if (!row || row.length < 2) return false;
  const headerKeywords = ['url', 'page', 'image', 'imagen', 'img', 'size', 'tamano', 'tamaño', 'width', 'height', 'selector', 'status', 'estado', 'hecho', 'done'];
  const firstTwo = [row[0], row[1]].map(v => (v || '').toString().toLowerCase().trim());
  return headerKeywords.some(kw => firstTwo[0].includes(kw) || firstTwo[1].includes(kw));
}

/**
 * Detecta el CMS de una URL para elegir el formato óptimo.
 * @param {string} url - URL de la página
 * @returns {string} CMS detectado: 'hubspot' | 'wordpress' | 'auto'
 */
function detectCMS(url) {
  const u = (url || '').toLowerCase();
  if (u.includes('hubspot') || u.includes('hs-scripts') || u.includes('hubspotusercontent')) return 'hubspot';
  if (u.includes('wp-content') || u.includes('wordpress') || u.includes('wp.com')) return 'wordpress';
  return 'auto';
}

/**
 * Determina el formato de salida según el CMS detectado.
 * @param {string} cms - CMS detectado
 * @returns {string} Formato recomendado: 'webp' | 'avif' | 'auto'
 */
function formatFromCMS(cms) {
  return 'auto'; // Comparar ambos formatos y elegir el más pequeño
}

/**
 * Descarga una imagen desde una URL con timeout.
 * @param {string} url - URL de la imagen
 * @param {number} timeout - Timeout en ms (default: 15000)
 * @returns {Promise<Buffer>} Buffer de la imagen descargada
 */
async function downloadImage(url, timeout = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const resp = await fetch(url, { signal: controller.signal, headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' } });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return Buffer.from(await resp.arrayBuffer());
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Descarga una imagen con reintentos y backoff exponencial.
 */
async function downloadImageWithRetry(url, maxRetries = 2) {
  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      if (attempt > 0) {
        const delay = Math.min(1000 * Math.pow(2, attempt - 1), 5000);
        await new Promise(r => setTimeout(r, delay));
      }
      return await downloadImage(url);
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

/**
 * Normaliza una URL de imagen: quita query params, fragmentos, espacios, trailing slashes.
 */
function normalizeImageUrl(url) {
  try {
    const u = new URL(url.trim());
    u.search = '';
    u.hash = '';
    return decodeURIComponent(u.href).replace(/\/+$/, '');
  } catch (_) {
    return url.trim().replace(/\?.*$/, '').replace(/#.*$/, '').replace(/\/+$/, '');
  }
}

/**
 * Limpia caracteres corruptos/inválidos de una URL.
 * Reemplaza U+FFFD (replacement char) y caracteres de control.
 */
function sanitizeUrl(url) {
  return url
    .replace(/\uFFFD/g, '')       // Quitar replacement characters
    .replace(/[\x00-\x1F\x7F]/g, '') // Quitar caracteres de control
    .trim();
}

/**
 * Normaliza texto para comparación: quita acentos, lower case.
 * "Fibra óptica" → "fibra optica"
 */
function normalizeTextForMatch(text) {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // Quitar diacríticos
    .toLowerCase();
}

/**
 * Extrae el basename de una URL de imagen (sin extensión, sin sufijo de tamaño).
 */
function getImageBaseName(url) {
  const clean = normalizeImageUrl(sanitizeUrl(url));
  try {
    const pathname = new URL(clean).pathname;
    const basename = pathname.split('/').pop();
    let name = basename.replace(/\.\w+$/, '');
    name = name.replace(/-\d+x\d+$/, '');
    return name;
  } catch (_) {
    return clean.split('/').pop().replace(/\.\w+$/, '').replace(/-\d+x\d+$/, '');
  }
}

/**
 * Categoriza una imagen por su tipo basado en dimensiones y contexto.
 * @param {number} width - Ancho medido en la página (o null si no se midió)
 * @param {number} origWidth - Ancho original de la imagen
 * @returns {string} 'hero' | 'content' | 'icon'
 */
function categorizeImage(width, origWidth) {
  const effectiveWidth = width || origWidth || 0;
  if (effectiveWidth >= 1400) return 'hero';
  if (effectiveWidth <= 100) return 'icon';
  return 'content';
}

/**
 * Retorna el límite de tamaño en bytes según categoría y configuración.
 * @param {string} category - 'hero' | 'content' | 'icon'
 * @param {string} aggressiveness - 'conservative' | 'balanced' | 'aggressive'
 * @returns {number} Límite en bytes (null = sin límite)
 */
function getSizeLimitForCategory(category, aggressiveness) {
  const limits = {
    conservative: { hero: 300 * 1024, content: 150 * 1024, icon: 50 * 1024 },
    balanced:     { hero: 200 * 1024, content: 100 * 1024, icon: 30 * 1024 },
    aggressive:   { hero: 100 * 1024, content: 50 * 1024,  icon: 20 * 1024 },
  };
  return (limits[aggressiveness] || limits.balanced)[category] || null;
}

/**
 * Optimización inteligente: intenta múltiples combinaciones de calidad/formato
 * para mantener la imagen por debajo del límite de tamaño sin perder calidad visible.
 *
 * Estrategia en cascada:
 * 1. Intenta con calidad 82 (default)
 * 2. Si supera el límite, baja a 70 → 55 → 40
 * 3. Si sigue superando, prueba AVIF vs WebP y elige el más pequeño
 * 4. NUNCA reduce dimensiones por debajo del targetWidth (retina buffer)
 *
 * @param {Buffer} inputBuffer - Buffer de la imagen original
 * @param {number|null} targetWidth - Ancho objetivo (null = original)
 * @param {string} format - Formato preferido
 * @param {number|null} sizeLimitBytes - Límite máximo en bytes (null = sin límite)
 * @param {number} quality - Calidad inicial (default: 82)
 * @returns {Promise<{buffer, format, widthOriginal, heightOriginal, widthResult, heightResult, qualityUsed, sizeWarning}>}
 */
async function optimizeImage(inputBuffer, targetWidth, format, sizeLimitBytes = null, quality = 82) {
  const meta = await sharp(inputBuffer).metadata();
  const widthOriginal = Math.round(meta.width);
  const heightOriginal = Math.round(meta.height);

  const tryFormat = async (fmt, pipe, q) => {
    if (fmt === 'webp') return pipe.webp({ quality: q }).toBuffer();
    if (fmt === 'avif') return pipe.avif({ quality: q, effort: 6 }).toBuffer();
    if (fmt === 'jpeg' || fmt === 'jpg') return pipe.jpeg({ quality: q, progressive: true }).toBuffer();
    if (fmt === 'png') return pipe.png({ compressionLevel: 9 }).toBuffer();
    return pipe.webp({ quality: q }).toBuffer();
  };

  const makePipeline = (buf, q) => {
    let p = sharp(buf);
    if (targetWidth && meta.width > targetWidth) {
      p = p.resize(targetWidth, null, { fit: 'inside', withoutEnlargement: true });
    }
    return p;
  };

  // Sin límite de tamaño: optimización directa
  if (!sizeLimitBytes) {
    if (format === 'auto') {
      const webpPipeline = makePipeline(inputBuffer, quality);
      const avifPipeline = makePipeline(inputBuffer, quality);
      const [webpBuf, avifBuf] = await Promise.all([
        tryFormat('webp', webpPipeline, quality),
        tryFormat('avif', avifPipeline, quality),
      ]);
      const winner = avifBuf.length < webpBuf.length
        ? { buffer: avifBuf, format: 'avif' }
        : { buffer: webpBuf, format: 'webp' };
      const resultMeta = await sharp(winner.buffer).metadata();
      return {
        buffer: winner.buffer,
        format: winner.format,
        widthOriginal, heightOriginal,
        widthResult: Math.round(resultMeta.width),
        heightResult: Math.round(resultMeta.height),
        qualityUsed: quality,
        sizeWarning: null,
      };
    }

    const pipeline = makePipeline(inputBuffer, quality);
    const buffer = await tryFormat(format, pipeline, quality);
    const resultMeta = await sharp(buffer).metadata();
    return {
      buffer,
      format,
      widthOriginal, heightOriginal,
      widthResult: Math.round(resultMeta.width),
      heightResult: Math.round(resultMeta.height),
      qualityUsed: quality,
      sizeWarning: null,
    };
  }

  // Con límite de tamaño: estrategia en cascada
  const qualitySteps = [quality, 70, 55, 40];
  const formatsToTry = format === 'auto' ? ['webp', 'avif'] : [format];

  let bestResult = null;
  let bestSize = Infinity;

  for (const q of qualitySteps) {
    for (const fmt of formatsToTry) {
      try {
        const pipeline = makePipeline(inputBuffer, q);
        const buffer = await tryFormat(fmt, pipeline, q);

        if (buffer.length < bestSize) {
          bestSize = buffer.length;
          const resultMeta = await sharp(buffer).metadata();
          bestResult = {
            buffer,
            format: fmt,
            widthOriginal, heightOriginal,
            widthResult: Math.round(resultMeta.width),
            heightResult: Math.round(resultMeta.height),
            qualityUsed: q,
          };
        }

        // Si ya está por debajo del límite, retornar inmediatamente
        if (buffer.length <= sizeLimitBytes) {
          const resultMeta = await sharp(buffer).metadata();
          return {
            buffer,
            format: fmt,
            widthOriginal, heightOriginal,
            widthResult: Math.round(resultMeta.width),
            heightResult: Math.round(resultMeta.height),
            qualityUsed: q,
            sizeWarning: null,
          };
        }
      } catch (_) {}
    }
  }

  // Si nada funcionó para bajar del límite, retornar el mejor resultado con warning
  if (bestResult) {
    const sizeWarning = bestSize > sizeLimitBytes
      ? `No se pudo bajar de ${Math.round(bestSize / 1024)}KB (límite: ${Math.round(sizeLimitBytes / 1024)}KB). Imagen compleja o muy grande.`
      : null;

    return {
      ...bestResult,
      sizeWarning,
    };
  }

  // Fallback extremo
  const fallbackPipeline = makePipeline(inputBuffer, 30);
  const fallbackBuffer = await tryFormat('webp', fallbackPipeline, 30);
  const resultMeta = await sharp(fallbackBuffer).metadata();
  return {
    buffer: fallbackBuffer,
    format: 'webp',
    widthOriginal, heightOriginal,
    widthResult: Math.round(resultMeta.width),
    heightResult: Math.round(resultMeta.height),
    qualityUsed: 30,
    sizeWarning: fallbackBuffer.length > sizeLimitBytes
      ? `Imagen no reducible: ${Math.round(fallbackBuffer.length / 1024)}KB`
      : null,
  };
}

// ─── Puppeteer - Medición de Imágenes ───────────────────────────

/**
 * Crea una instancia de navegador Puppeteer.
 * @returns {Promise<Browser>} Instancia de navegador
 */
async function createBrowser() {
  return puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
}

/**
 * Mide el tamaño de una imagen en una página web.
 * 
 * Estrategias de búsqueda (en orden):
 * 1. Selector CSS explícito
 * 2. Match exacto de URL en <img src>
 * 3. Match por nombre de archivo (basename)
 * 4. Match parcial de URL
 * 5. Búsqueda en background-image
 * 6. Búsqueda en <picture>/<source>
 * 
 * @param {Browser} browser - Instancia de Puppeteer
 * @param {string} pageUrl - URL de la página
 * @param {string} imageUrl - URL de la imagen a medir
 * @param {string} selector - Selector CSS opcional
 * @returns {Promise<Object>} Resultado con width, height, method o found: false
 */
async function measureImage(browser, pageUrl, imageUrl, selector) {
  let page;
  try {
    page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });
    await page.goto(pageUrl, { waitUntil: 'networkidle2', timeout: 20000 });

    // Scroll para activar lazy loading (múltiples pasadas)
    await page.evaluate(() => {
      window.scrollTo(0, document.body.scrollHeight / 3);
    });
    await new Promise(r => setTimeout(r, 400));
    await page.evaluate(() => {
      window.scrollTo(0, document.body.scrollHeight / 1.5);
    });
    await new Promise(r => setTimeout(r, 400));
    await page.evaluate(() => {
      window.scrollTo(0, document.body.scrollHeight);
    });
    await new Promise(r => setTimeout(r, 800));

    // Normalizar URL de imagen: quitar query params para comparación
    const normalizedImageUrl = normalizeImageUrl(imageUrl);
    const imageBaseName = getImageBaseName(imageUrl);
    // Versión "segura": sin acentos ni caracteres especiales para fallback
    const imageBaseNameSafe = normalizeTextForMatch(imageBaseName);

    const result = await page.evaluate((imgUrl, imgUrlNormalized, imgBaseName, imgBaseNameSafe, sel) => {
      const normalizeUrl = (u) => {
        try {
          const url = new URL(u);
          url.search = '';
          url.hash = '';
          return decodeURIComponent(url.href);
        } catch (_) {
          return u;
        }
      };
      const normalizeText = (t) => t.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
      const targetNormalized = normalizeUrl(imgUrlNormalized);
      const targetBasename = (() => {
        try {
          const u = new URL(imgUrl);
          let name = u.pathname.split('/').pop().replace(/\.\w+$/, '');
          name = name.replace(/-\d+x\d+$/, '');
          return name;
        } catch (_) {
          let name = imgUrl.split('/').pop().replace(/\.\w+$/, '');
          return name.replace(/-\d+x\d+$/, '');
        }
      })();
      const targetBasenameSafe = normalizeText(targetBasename);

      // 1. Selector CSS explícito
      if (sel) {
        const el = document.querySelector(sel);
        if (el) {
          const rect = el.getBoundingClientRect();
          return { found: true, width: Math.round(rect.width), height: Math.round(rect.height), method: 'selector' };
        }
      }

      // 2. Buscar en tags <img>
      const imgs = document.querySelectorAll('img');
      let fallbackMatch = null;
      for (const img of imgs) {
        const candidates = [
          img.currentSrc,
          img.src,
          img.dataset?.src,
          img.dataset?.lazySrc,
          img.dataset?.original,
          img.getAttribute('srcset')?.split(',')[0]?.trim()?.split(' ')[0],
        ].filter(Boolean);

        for (const src of candidates) {
          if (!src) continue;

          let method = null;
          // Match exact con URL normalizada (sin query params)
          if (normalizeUrl(src) === targetNormalized) {
            method = 'src-exact';
          } else {
            try {
              const srcUrl = new URL(src);
              let srcName = srcUrl.pathname.split('/').pop().replace(/\.\w+$/, '');
              srcName = srcName.replace(/-\d+x\d+$/, '');
              // Match por nombre base (sin extensión ni sufijo de tamaño)
              if (srcName === targetBasename && targetBasename.length > 3) {
                method = 'basename-match';
              }
              // Match fuzzy: contener el nombre base
              else if (srcName.includes(imgBaseName) && imgBaseName.length > 5) {
                method = 'name-partial';
              }
              // Fallback: match sin acentos ni caracteres especiales
              else if (targetBasenameSafe.length > 5) {
                const srcNameSafe = normalizeText(srcName);
                if (srcNameSafe === targetBasenameSafe || srcNameSafe.includes(targetBasenameSafe)) {
                  method = 'basename-fuzzy';
                }
              }
              // Fallback agresivo: match por partes (maneja caracteres corruptos)
              if (!method && targetBasename.length > 5) {
                // Split por espacios, verificar que la primera palabra esté en el src
                // y que la extensión coincida
                const parts = targetBasename.split(/[\s\-_]+/).filter(p => p.length > 2);
                const srcLower = srcName.toLowerCase();
                const targetLower = targetBasename.toLowerCase();
                // Si la primera palabra coincide y la extensión es la misma
                if (parts.length >= 1 && srcLower.includes(parts[0].toLowerCase())) {
                  // Verificar que la extensión coincida
                  const csvExt = targetBasename.split('.').pop().toLowerCase();
                  const srcExt = srcName.split('.').pop().toLowerCase();
                  if (csvExt === srcExt || (csvExt === 'jpg' && srcExt === 'jpeg') || (csvExt === 'jpeg' && srcExt === 'jpg')) {
                    method = 'parts-match';
                  }
                }
                // Fallback: match por primera palabra + extensión sin acentos
                if (!method && parts.length >= 1) {
                  const srcNameNoAccent = normalizeText(srcName);
                  const firstWord = normalizeText(parts[0]);
                  if (srcNameNoAccent.includes(firstWord) && srcNameNoAccent.length > firstWord.length) {
                    method = 'first-word-match';
                  }
                }
              }
            } catch (_) {}
          }
          // Fallback: match parcial en URL completa
          if (!method) {
            const srcNormalized = normalizeUrl(src);
            if (srcNormalized.includes(imgUrlNormalized) || imgUrlNormalized.includes(srcNormalized)) {
              method = 'url-partial';
            }
          }

          if (method) {
            const rect = img.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) {
              return { found: true, width: Math.round(rect.width), height: Math.round(rect.height), method };
            }
            if (!fallbackMatch) {
              fallbackMatch = { found: true, width: Math.round(rect.width), height: Math.round(rect.height), method };
            }
          }
        }
      }
      if (fallbackMatch) return fallbackMatch;

      // 3. Buscar en background-image
      let bgFallback = null;
      const allEls = document.querySelectorAll('*');
      for (const el of allEls) {
        const style = window.getComputedStyle(el);
        const bg = style.backgroundImage;
        if (bg && bg !== 'none' && (bg.includes(targetBasename) || bg.includes(imgBaseName))) {
          const rect = el.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) {
            return { found: true, width: Math.round(rect.width), height: Math.round(rect.height), method: 'background-image' };
          }
          if (!bgFallback) {
            bgFallback = { found: true, width: Math.round(rect.width), height: Math.round(rect.height), method: 'background-image' };
          }
        }
      }
      if (bgFallback) return bgFallback;

      // 4. Buscar en <picture>/<source>
      let picFallback = null;
      const sources = document.querySelectorAll('source');
      for (const src of sources) {
        const srcset = src.getAttribute('srcset') || '';
        if (srcset.includes(targetBasename) || srcset.includes(imgBaseName)) {
          const picture = src.closest('picture');
          const img = picture?.querySelector('img');
          if (img) {
            const rect = img.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) {
              return { found: true, width: Math.round(rect.width), height: Math.round(rect.height), method: 'picture-source' };
            }
            if (!picFallback) {
              picFallback = { found: true, width: Math.round(rect.width), height: Math.round(rect.height), method: 'picture-source' };
            }
          }
        }
      }
      if (picFallback) return picFallback;

      // 5. Búsqueda agresiva: substring del basename en cualquier atributo de cualquier elemento
      // Maneja casos donde la URL en el CSV tiene extensión/sufijo diferente al de la página
      const aggressiveFallback = null;
      const keyParts = targetBasename
        .split(/[\-_]/)
        .filter(p => p.length > 4)
        .map(p => p.toLowerCase());

      if (keyParts.length > 0) {
        const allElements = document.querySelectorAll('img, source, div, span, section, article, picture');
        for (const el of allElements) {
          const attrs = el.attributes;
          for (const attr of attrs) {
            const val = attr.value.toLowerCase();
            if (!val) continue;
            let matchCount = 0;
            for (const part of keyParts) {
              if (val.includes(part)) matchCount++;
            }
            if (matchCount >= Math.min(2, keyParts.length)) {
              const rect = el.getBoundingClientRect();
              if (rect.width > 0 && rect.height > 0) {
                return { found: true, width: Math.round(rect.width), height: Math.round(rect.height), method: 'aggressive-match' };
              }
            }
          }
        }
      }

      return { found: false };
    }, imageUrl, normalizedImageUrl, imageBaseName, imageBaseNameSafe, selector);

    return result;
  } finally {
    if (page) await page.close();
  }
}

// ─── Helpers de SSE ─────────────────────────────────────────────

/**
 * Envía un evento SSE al cliente.
 * @param {Response} res - Objeto response de Express
 * @param {string} event - Nombre del evento
 * @param {Object} data - Datos a enviar
 */
function sendEvent(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

// ─── Generación de ZIP ──────────────────────────────────────────

/**
 * Crea un archivo ZIP desde la carpeta de un proyecto.
 * Incluye todas las subcarpetas con imágenes y el mapping.csv.
 * @param {string} projectDir - Ruta de la carpeta del proyecto
 * @param {string} batchId - ID del batch para nombrar el ZIP
 * @returns {Promise<string>} Ruta del archivo ZIP creado
 */
async function createZipFromProject(projectDir, batchId) {
  const zipPath = join(tempZipsDir, `${batchId}.zip`);
  const output = createWriteStream(zipPath);
  const archive = archiver('zip', { zlib: { level: 9 } });

  return new Promise((resolve, reject) => {
    output.on('close', () => resolve(zipPath));
    archive.on('error', reject);
    archive.on('warning', (err) => { if (err.code !== 'ENOENT') reject(err); });

    archive.pipe(output);
    archive.directory(projectDir, false);
    archive.finalize();
  });
}

/**
 * Crea un archivo ZIP con las imágenes optimizadas.
 * @deprecated Usar createZipFromProject en su lugar.
 * @param {string} batchId - ID único del lote
 * @param {string[]} filenames - Nombres de archivo a incluir
 * @returns {Promise<string>} Ruta del archivo ZIP creado
 */
async function createZip(batchId, filenames) {
  const zipPath = join(tempZipsDir, `${batchId}.zip`);
  const output = createWriteStream(zipPath);
  const archive = archiver('zip', { zlib: { level: 9 } });

  return new Promise((resolve, reject) => {
    output.on('close', () => resolve(zipPath));
    archive.on('error', reject);
    archive.on('warning', (err) => { if (err.code !== 'ENOENT') reject(err); });

    archive.pipe(output);

    for (const filename of filenames) {
      const filePath = join(outputDir, filename);
      if (existsSync(filePath)) {
        archive.file(filePath, { name: filename });
      }
    }

    archive.finalize();
  });
}

// ─── Endpoint Principal: Procesamiento SSE ──────────────────────

/**
 * POST /api/process
 *
 * Procesa un CSV de imágenes y devuelve eventos SSE en tiempo real.
 * Query params:
 *   - format: 'auto' | 'webp' | 'avif' | 'jpeg' | 'png' (default: 'auto')
 *   - projectName: Nombre del proyecto para organizar la salida (default: 'sin-nombre')
 *   - resumeBatchId: ID de batch para reanudar procesamiento interrumpido
 *
 * Body: multipart/form-data con campo 'csv'
 *
 * Las imágenes se guardan en: output/{projectName}/{slug-pagina}/{nro-imagen}.{ext}
 * Se genera mapping.csv con trazabilidad completa en la carpeta del proyecto.
 */
app.post('/api/process', upload.single('csv'), async (req, res) => {
  const formatOverride = (req.query.format || 'auto').toLowerCase();
  const projectName = sanitizeProjectName(req.query.projectName);
  const aggressiveness = (req.query.aggressiveness || 'balanced').toLowerCase();
  const sizeLimitMode = (req.query.sizeLimit || 'auto').toLowerCase();
  const processId = `proc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const controller = createProcessController();
  activeProcesses.set(processId, controller);

  // Configurar headers SSE
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  let rows = [];
  let browser;

  // Carpeta del proyecto
  const projectDir = join(outputDir, projectName);
  if (!existsSync(projectDir)) mkdirSync(projectDir, { recursive: true });

  try {
    // ─── 1. Parsear CSV ─────────────────────────────────────────
    let csvContent = '';
    if (req.file) {
      csvContent = readFileSync(req.file.path, 'utf-8');
      // Normalizar saltos de línea (Windows → Unix)
      csvContent = csvContent.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
      // Eliminar BOM si existe
      if (csvContent.charCodeAt(0) === 0xFEFF) {
        csvContent = csvContent.slice(1);
      }

      // Auto-detectar delimitador probando en orden
      const delimiters = [';', ',', '\t'];
      let detectedDelimiter = ',';
      for (const delim of delimiters) {
        const testRows = parse(csvContent, { columns: false, skip_empty_lines: true, trim: true, delimiter: delim });
        if (testRows.some(r => r.length >= 2)) {
          detectedDelimiter = delim;
          break;
        }
      }

      rows = parse(csvContent, { columns: false, skip_empty_lines: true, trim: true, delimiter: detectedDelimiter });
      unlinkSync(req.file.path);
    } else {
      sendEvent(res, 'error', { message: 'No se recibió archivo CSV.' });
      res.end();
      activeProcesses.delete(processId);
      return;
    }

    if (!rows.length) {
      sendEvent(res, 'error', { message: 'El CSV está vacío.' });
      res.end();
      activeProcesses.delete(processId);
      return;
    }

    // Limpiar cada celda: trim, quitar \r, espacios extra
    rows = rows.map(row => row.map(cell => (cell || '').trim().replace(/\r/g, '')));

    // Saltar fila de encabezados si se detecta
    let dataRows = rows;
    if (rows.length > 0 && isHeaderRow(rows[0])) {
      dataRows = rows.slice(1);
    }

    // Filtrar filas válidas: al menos URL + imagen, y saltar filas "hechas"
    const validRows = [];
    const skippedRows = [];
    for (const row of dataRows) {
      if (row.length < 2 || !row[0] || !row[1]) continue;

      // Si hay columna de estado (3ra o 4ta), verificar si ya está hecha
      const statusCol = row[3] || row[2] || '';
      if (['true', '1', 'hecho', 'done', 'completado', 'ok', 'sí', 'si'].includes(statusCol.toLowerCase())) {
        skippedRows.push(row);
        continue;
      }

      validRows.push(row);
    }

    if (!validRows.length) {
      sendEvent(res, 'error', { message: 'El CSV no tiene filas válidas. Se requieren al menos 2 columnas: url, imagen' });
      res.end();
      activeProcesses.delete(processId);
      return;
    }

    // ─── Estado del batch ────────────────────────────────────────
    const csvHash = hashCSV(csvContent);
    const resumeBatchId = req.query.resumeBatchId || null;
    let batchId;
    let completedIndices = new Set();
    let errorIndices = new Set();
    let existingResults = [];

    if (resumeBatchId) {
      // Reanudar batch existente
      const existingState = loadBatchState(resumeBatchId);
      if (!existingState) {
        sendEvent(res, 'error', { message: 'Batch anterior no encontrado' });
        res.end();
        activeProcesses.delete(processId);
        return;
      }
      batchId = resumeBatchId;
      completedIndices = new Set(existingState.completedIndices || []);
      errorIndices = new Set(existingState.errorIndices || []);
      existingResults = loadBatchResults(batchId);
    } else {
      // Nuevo batch
      batchId = generateBatchId(csvHash);
    }

    // Inicializar estado
    const batchState = {
      id: batchId,
      csvHash,
      createdAt: resumeBatchId ? (loadBatchState(resumeBatchId)?.createdAt || new Date().toISOString()) : new Date().toISOString(),
      totalRows: validRows.length,
      status: 'running',
      completedIndices: [...completedIndices],
      errorIndices: [...errorIndices],
      format: formatOverride,
      projectName,
    };
    saveBatchState(batchId, batchState);

    // Si es reanudación, enviar resultados existentes primero
    if (existingResults.length > 0) {
      sendEvent(res, 'resume', {
        batchId,
        total: validRows.length,
        completed: existingResults.length,
        processId,
      });
      for (const item of existingResults) {
        sendEvent(res, 'item', item);
      }
    } else {
      sendEvent(res, 'start', { total: validRows.length, processId, batchId, skipped: skippedRows.length });
    }

    // ─── 2. Iniciar Puppeteer ───────────────────────────────────
    try {
      browser = await createBrowser();
    } catch (err) {
      sendEvent(res, 'error', { message: `Error iniciando Puppeteer: ${err.message}` });
      res.end();
      return;
    }

    // ─── 3. Procesar cada fila ──────────────────────────────────
    const savedFilenames = [];
    const mappingRows = []; // Para mapping.csv
    let successCount = completedIndices.size;
    let errorCount = errorIndices.size;
    let overLimitCount = 0;
    let totalSaved = 0;
    const imageCache = new Map(); // Cache para evitar descargas repetidas
    const slugCounter = new Map(); // Para evitar colisiones de nombre de archivo por slug

    for (let i = 0; i < validRows.length; i++) {
      // Verificar estado de control antes de cada imagen
      const statusCheck = await controller.checkStatus();
      if (statusCheck === 'stopped') {
        sendEvent(res, 'stopped', { current: i, total: validRows.length, message: 'Proceso detenido por el usuario' });
        break;
      }

      // Saltar filas ya completadas en una ejecución anterior
      if (completedIndices.has(i)) {
        continue;
      }

      const row = validRows[i];
      const pageUrl = row[0]?.trim() || '';
      const imageUrl = row[1]?.trim() || '';
      // Solo usar como selector si parece un selector CSS válido
      const rawSelector = row[2]?.trim() || '';
      const selector = /^[\.\#a-zA-Z\[\*]/.test(rawSelector) ? rawSelector : '';

      sendEvent(res, 'progress', {
        current: i + 1,
        total: validRows.length,
        status: 'processing',
        pageUrl,
        imageUrl,
      });

      if (!imageUrl) {
        const errorItem = {
          index: i,
          status: 'error',
          error: 'Falta URL de imagen',
          pageUrl,
          imageUrl,
        };
        sendEvent(res, 'item', errorItem);
        errorCount++;
        errorIndices.add(i);
        batchState.completedIndices = [...completedIndices];
        batchState.errorIndices = [...errorIndices];
        saveBatchState(batchId, batchState);
        appendBatchResult(batchId, errorItem);
        continue;
      }

      // Determinar formato de salida
      let format = 'webp';
      if (formatOverride === 'auto') {
        const cms = detectCMS(pageUrl);
        format = formatFromCMS(cms);
      } else if (['webp', 'avif', 'jpeg', 'jpg', 'png'].includes(formatOverride)) {
        format = formatOverride === 'jpg' ? 'jpeg' : formatOverride;
      }

      let targetWidth = null;
      let measureMethod = null;

      // Medir imagen en la página
      if (pageUrl) {
        sendEvent(res, 'progress', {
          current: i + 1,
          total: validRows.length,
          status: 'measuring',
          pageUrl,
          imageUrl,
        });

        const measure = await measureImage(browser, pageUrl, imageUrl, selector);
        if (measure.found && measure.width > 10) {
          // Tamaño óptimo: display + 100px para retina (margen ~50-100px)
          targetWidth = measure.width + 100;
          measureMethod = measure.method;
        } else if (!measure.found) {
          // Imagen no encontrada en la página — usar fallback de redimensionamiento
          measureMethod = 'fallback-resize';
          sendEvent(res, 'progress', {
            current: i + 1,
            total: validRows.length,
            status: 'fallback-resize',
            pageUrl,
            imageUrl,
          });
        }
      }

      // Verificar cache
      const cacheKey = `${imageUrl}|${format}|${targetWidth || 'orig'}`;
      const cached = imageCache.get(cacheKey);

      let optBuffer, finalFormat, originalSize, optimizedSize, savedPercent;
      let widthOriginal, heightOriginal, widthResult, heightResult;

      if (cached) {
        // ─── Usar cache ───────────────────────────────────────
        sendEvent(res, 'progress', {
          current: i + 1,
          total: validRows.length,
          status: 'optimizing',
          pageUrl,
          imageUrl,
        });
        ({ optBuffer, finalFormat, originalSize, optimizedSize, savedPercent, widthOriginal, heightOriginal, widthResult, heightResult } = cached);
      } else {
        // ─── Descargar imagen ─────────────────────────────────
        sendEvent(res, 'progress', {
          current: i + 1,
          total: validRows.length,
          status: 'downloading',
          pageUrl,
          imageUrl,
        });

        let inputBuffer;
        try {
          inputBuffer = await downloadImageWithRetry(imageUrl);
        } catch (err) {
          const errorItem = {
            index: i,
            status: 'error',
            error: `Error descargando: ${err.message}`,
            pageUrl,
            imageUrl,
          };
          sendEvent(res, 'item', errorItem);
          errorCount++;
          errorIndices.add(i);
          batchState.completedIndices = [...completedIndices];
          batchState.errorIndices = [...errorIndices];
          saveBatchState(batchId, batchState);
          appendBatchResult(batchId, errorItem);
          continue;
        }

        // ─── Fallback resize si no se pudo medir en la página ──
        if (!targetWidth && measureMethod === 'fallback-resize') {
          try {
            const imgMeta = await sharp(inputBuffer).metadata();
            const origW = Math.round(imgMeta.width);
            const origH = Math.round(imgMeta.height);
            if (origW > 1920) {
              targetWidth = 1600; // Hero/banner grande
            } else if (origW > 1200) {
              targetWidth = 1200; // Contenido principal
            } else if (origW > 800) {
              targetWidth = 800; // Card/sidebar
            } else if (origW > 400) {
              targetWidth = 600; // Thumbnail/pequeño
            }
            // Si es <= 400px, no redimensionar
          } catch (_) {}
        }

        // ─── Optimizar imagen ─────────────────────────────────
        sendEvent(res, 'progress', {
          current: i + 1,
          total: validRows.length,
          status: 'optimizing',
          pageUrl,
          imageUrl,
        });

        try {
          // Determinar límite de tamaño según categoría y agresividad
          let sizeLimitBytes = null;
          let imageCategory = 'content';
          if (sizeLimitMode !== 'none') {
            imageCategory = categorizeImage(targetWidth, widthOriginal || 0);
            sizeLimitBytes = getSizeLimitForCategory(imageCategory, aggressiveness);
          }

          const result = await optimizeImage(inputBuffer, targetWidth, format, sizeLimitBytes);
          optBuffer = result.buffer;
          finalFormat = result.format;
          originalSize = inputBuffer.length;
          optimizedSize = optBuffer.length;
          savedPercent = inputBuffer.length > 0
            ? ((1 - optBuffer.length / inputBuffer.length) * 100).toFixed(1)
            : '0.0';
          widthOriginal = result.widthOriginal;
          heightOriginal = result.heightOriginal;
          widthResult = result.widthResult;
          heightResult = result.heightResult;

          // Guardar en cache con dimensiones y warning
          imageCache.set(cacheKey, {
            optBuffer,
            finalFormat,
            originalSize,
            optimizedSize,
            savedPercent,
            widthOriginal,
            heightOriginal,
            widthResult,
            heightResult,
            sizeWarning: result.sizeWarning,
            imageCategory,
            qualityUsed: result.qualityUsed,
          });
        } catch (err) {
          const errorItem = {
            index: i,
            status: 'error',
            error: `Error optimizando: ${err.message}`,
            pageUrl,
            imageUrl,
          };
          sendEvent(res, 'item', errorItem);
          errorCount++;
          errorIndices.add(i);
          batchState.completedIndices = [...completedIndices];
          batchState.errorIndices = [...errorIndices];
          saveBatchState(batchId, batchState);
          appendBatchResult(batchId, errorItem);
          continue;
        }
      }

      // ─── Guardar en disco ─────────────────────────────────────
      try {
        const ext = finalFormat === 'jpeg' ? 'jpg' : finalFormat;
        const origName = (() => {
          try { return new URL(imageUrl).pathname.split('/').pop().replace(/\.\w+$/, ''); } catch (_) { return imageUrl.split('/').pop().replace(/\.\w+$/, ''); }
        })();

        // Generar slug y subcarpeta
        const slug = pageUrl ? slugFromUrl(pageUrl) : '_sin-pagina';
        const domain = pageUrl ? domainPrefix(pageUrl) : '';

        // Detectar colisión de slug: si otro dominio tiene el mismo slug, prefijar con dominio
        const slugKey = `${domain}/${slug}`;
        const subfolder = join(projectDir, slug);
        if (!existsSync(subfolder)) mkdirSync(subfolder, { recursive: true });

        // Contador por slug para prefijo de fila
        const counter = (slugCounter.get(slugKey) || 0) + 1;
        slugCounter.set(slugKey, counter);
        const prefix = String(counter).padStart(3, '0');

        let filename = `${prefix}-${origName}.${ext}`;
        // Evitar colisiones con archivos existentes
        let fileCounter = 1;
        while (existsSync(join(subfolder, filename))) {
          filename = `${prefix}-${origName}_${fileCounter}.${ext}`;
          fileCounter++;
        }
        const filePath = join(subfolder, filename);
        writeFileSync(filePath, optBuffer);
        savedFilenames.push({ filename, subfolder: slug, fullPath: filePath });

        totalSaved += originalSize - optimizedSize;

        const cacheEntry = imageCache.get(cacheKey);
        const successItem = {
          index: i,
          status: 'ok',
          pageUrl,
          imageUrl,
          originalSize,
          optimizedSize,
          savedPercent,
          targetWidth: targetWidth || 'original',
          format: finalFormat,
          filename,
          slug,
          cached: !!cached,
          measureMethod: measureMethod || null,
          widthOriginal,
          heightOriginal,
          widthResult,
          heightResult,
          sizeWarning: cacheEntry?.sizeWarning || null,
          imageCategory: cacheEntry?.imageCategory || 'content',
          qualityUsed: cacheEntry?.qualityUsed || 82,
        };
        sendEvent(res, 'item', successItem);
        successCount++;
        if (successItem.sizeWarning) overLimitCount++;
        completedIndices.add(i);
        batchState.completedIndices = [...completedIndices];
        batchState.errorIndices = [...errorIndices];
        saveBatchState(batchId, batchState);
        appendBatchResult(batchId, successItem);

        // Agregar fila al mapping
        mappingRows.push({
          fila: i + 1,
          url_pagina: pageUrl,
          url_imagen: imageUrl,
          slug,
          archivo: filename,
          formato: finalFormat,
          original_bytes: originalSize,
          optimizado_bytes: optimizedSize,
          ahorro_pct: savedPercent,
          metodo: measureMethod || 'directo',
          categoria: cacheEntry?.imageCategory || 'content',
          calidad: cacheEntry?.qualityUsed || 82,
          size_warning: cacheEntry?.sizeWarning || '',
        });
      } catch (err) {
        const errorItem = {
          index: i,
          status: 'error',
          error: `Error guardando: ${err.message}`,
          pageUrl,
          imageUrl,
        };
        sendEvent(res, 'item', errorItem);
        errorCount++;
        errorIndices.add(i);
        batchState.completedIndices = [...completedIndices];
        batchState.errorIndices = [...errorIndices];
        saveBatchState(batchId, batchState);
        appendBatchResult(batchId, errorItem);

        // Agregar error al mapping también
        const slug = pageUrl ? slugFromUrl(pageUrl) : '_sin-pagina';
        mappingRows.push({
          fila: i + 1,
          url_pagina: pageUrl,
          url_imagen: imageUrl,
          slug,
          archivo: 'ERROR',
          formato: '-',
          original_bytes: '-',
          optimizado_bytes: '-',
          ahorro_pct: '-',
          metodo: '-',
        });
      }
    }

    // ─── 4. Finalizar ───────────────────────────────────────────
    if (browser) {
      try { await browser.close(); } catch (_) {}
    }

    sendEvent(res, 'progress', {
      current: validRows.length,
      total: validRows.length,
      status: 'packaging',
    });

    // Generar mapping.csv dentro de la carpeta del proyecto
    if (mappingRows.length > 0) {
      const csvHeader = 'fila,url_pagina,url_imagen,slug,archivo,formato,original_bytes,optimizado_bytes,ahorro_pct,metodo,categoria,calidad,size_warning';
      const csvLines = mappingRows.map(r =>
        `${r.fila},"${r.url_pagina}","${r.url_imagen}","${r.slug}","${r.archivo}","${r.formato}","${r.original_bytes}","${r.optimizado_bytes}","${r.ahorro_pct}","${r.metodo}","${r.categoria || ''}","${r.calidad || ''}","${r.size_warning || ''}"`
      );
      const mappingContent = csvHeader + '\n' + csvLines.join('\n') + '\n';
      writeFileSync(join(projectDir, 'mapping.csv'), mappingContent, 'utf-8');
    }

    let zipUrl = null;
    if (savedFilenames.length > 0) {
      try {
        await createZipFromProject(projectDir, batchId);
        zipUrl = `/api/download/${batchId}.zip`;
      } catch (err) {
        console.error('ZIP error:', err);
      }
    }

    completeBatchState(batchId);

    sendEvent(res, 'complete', {
      zipUrl,
      batchId,
      summary: {
        total: validRows.length,
        success: successCount,
        errors: errorCount,
        overLimit: overLimitCount,
        totalSavedBytes: totalSaved,
      },
    });

    res.end();
  } catch (err) {
    console.error('Process error:', err);
    sendEvent(res, 'error', { message: err.message });
    res.end();
  } finally {
    activeProcesses.delete(processId);
    if (browser) {
      try { await browser.close(); } catch (_) {}
    }
  }
});

// ─── Endpoint de Control ────────────────────────────────────────

/**
 * POST /api/control/:processId
 * 
 * Controla un proceso en ejecución.
 * Body: { action: 'pause' | 'resume' | 'stop' }
 */
app.post('/api/control/:processId', (req, res) => {
  const { processId } = req.params;
  const { action } = req.body;
  const controller = activeProcesses.get(processId);

  if (!controller) {
    return res.status(404).json({ error: 'Proceso no encontrado o ya finalizado' });
  }

  if (!['pause', 'resume', 'stop'].includes(action)) {
    return res.status(400).json({ error: 'Acción no válida. Use: pause, resume, stop' });
  }

  controller.updateStatus(action === 'stop' ? 'stopped' : action === 'pause' ? 'paused' : 'running');
  res.json({ ok: true, action, status: controller.getStatus() });
});

// ─── Endpoints de Estado y Reanudación ──────────────────────────

/**
 * POST /api/check-state
 * 
 * Verifica si hay un batch incompleto para un CSV dado.
 * Body: { csvContent: string }
 */
app.post('/api/check-state', (req, res) => {
  const { csvContent } = req.body;
  if (!csvContent) {
    return res.status(400).json({ error: 'Se requiere csvContent' });
  }

  const csvHash = hashCSV(csvContent);
  const incomplete = findIncompleteBatch(csvHash);

  if (!incomplete) {
    return res.json({ found: false });
  }

  res.json({
    found: true,
    batchId: incomplete.id,
    totalRows: incomplete.totalRows,
    completed: incomplete.completedIndices?.length || 0,
    errors: incomplete.errorIndices?.length || 0,
    createdAt: incomplete.createdAt,
  });
});

/**
 * GET /api/batches
 * 
 * Lista todos los batches (completados e incompletos).
 */
app.get('/api/batches', (req, res) => {
  const files = readdirSync(stateDir).filter(f => f.endsWith('.json') && !f.includes('-results'));
  const batches = files.map(file => {
    const batchId = file.replace('.json', '');
    const state = loadBatchState(batchId);
    if (!state) return null;
    return {
      batchId: state.id,
      csvHash: state.csvHash,
      totalRows: state.totalRows,
      completed: state.completedIndices?.length || 0,
      errors: state.errorIndices?.length || 0,
      status: state.status,
      createdAt: state.createdAt,
    };
  }).filter(Boolean).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  res.json({ batches });
});

// ─── Endpoints de Descarga ──────────────────────────────────────

/**
 * GET /api/output/:filename
 * 
 * Descarga una imagen optimizada individual.
 */
app.get('/api/output/:filename', (req, res) => {
  const filePath = join(outputDir, req.params.filename);
  if (!existsSync(filePath)) {
    return res.status(404).json({ error: 'Archivo no encontrado' });
  }
  res.sendFile(filePath);
});

/**
 * GET /api/download/:batchId.zip
 * 
 * Descarga el ZIP con todas las imágenes optimizadas.
 */
app.get('/api/download/:batchId.zip', (req, res) => {
  const zipPath = join(tempZipsDir, `${req.params.batchId}.zip`);
  if (!existsSync(zipPath)) {
    return res.status(404).json({ error: 'ZIP no encontrado' });
  }
  res.download(zipPath, `imagenes_optimizadas_${req.params.batchId}.zip`);
});

// ─── Endpoint para listar proyectos ─────────────────────────────

/**
 * GET /api/projects
 *
 * Lista todos los proyectos disponibles en output/.
 */
app.get('/api/projects', (req, res) => {
  if (!existsSync(outputDir)) {
    return res.json({ projects: [] });
  }
  const projects = readdirSync(outputDir).filter(name => {
    const fpath = join(outputDir, name);
    return statSync(fpath).isDirectory();
  }).map(name => {
    const fpath = join(outputDir, name);
    const stat = statSync(fpath);
    return {
      name,
      createdAt: stat.birthtime.toISOString(),
      modifiedAt: stat.mtime.toISOString(),
    };
  }).sort((a, b) => new Date(b.modifiedAt) - new Date(a.modifiedAt));

  res.json({ projects });
});

// ─── Iniciar Servidor ───────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`✅ IMA Generator v3.0.1 corriendo en http://localhost:${PORT}`);
  console.log(`📁 Output: ${outputDir}`);
  console.log(`📦 Temp ZIPs: ${tempZipsDir}`);
});
