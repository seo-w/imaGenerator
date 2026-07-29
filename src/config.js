/**
 * Configuración central de IMA Generator.
 *
 * Todos los directorios, constantes de optimización y valores por defecto
 * viven acá para que no haya números mágicos repartidos por el código.
 */

import { mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

/** Raíz del proyecto (un nivel arriba de src/) */
export const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..');

export const PORT = process.env.PORT || 3000;

export const publicDir = join(rootDir, 'public');
export const outputDir = join(rootDir, 'output');
export const tempZipsDir = join(rootDir, 'temp-zips');
export const stateDir = join(rootDir, 'state');
export const uploadsDir = join(rootDir, 'uploads');

/** Crea los directorios de trabajo si no existen. */
export function ensureDirs() {
  for (const dir of [outputDir, tempZipsDir, stateDir, uploadsDir]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
}

// ─── Medición ───────────────────────────────────────────────────

/**
 * Viewport de medición. Hoy solo desktop: la medición en mobile está
 * pendiente (ver README → "Limitaciones conocidas").
 */
export const VIEWPORT_DESKTOP = { width: 1920, height: 1080 };

/** Timeout de navegación de Puppeteer, en ms. */
export const PAGE_TIMEOUT = 25000;

/**
 * Recursos que se bloquean al cargar una página.
 * No afectan el layout (y por lo tanto tampoco la medición), pero sí
 * dominan el tiempo de carga.
 */
export const BLOCKED_RESOURCE_TYPES = new Set(['font', 'media', 'websocket', 'manifest']);

/** Dominios de tracking/ads que solo agregan latencia. */
export const BLOCKED_URL_PATTERNS = [
  'google-analytics.com', 'googletagmanager.com', 'doubleclick.net',
  'facebook.net', 'connect.facebook', 'hotjar.com', 'clarity.ms',
  'intercom.io', 'segment.com', 'mixpanel.com', 'fullstory.com',
];

// ─── Holgura (buffer sobre el tamaño del contenedor) ────────────

/**
 * Modos de holgura disponibles.
 *
 * El ancho objetivo se calcula como `contenedor * factor + extra`.
 * El default es `+100px` para preservar el comportamiento histórico.
 */
export const HOLGURA_MODES = {
  '100px': { factor: 1, extra: 100, label: '+100px' },
  '1x':    { factor: 1, extra: 0,   label: '×1 (exacto)' },
  '1.5x':  { factor: 1.5, extra: 0, label: '×1.5' },
  '2x':    { factor: 2, extra: 0,   label: '×2 (retina)' },
};

export const DEFAULT_HOLGURA = '100px';

/**
 * Aplica el modo de holgura al ancho medido del contenedor.
 * @param {number} containerWidth - Ancho renderizado del contenedor, en px CSS
 * @param {string} mode - Clave de HOLGURA_MODES
 * @returns {number} Ancho objetivo para la imagen
 */
export function applyHolgura(containerWidth, mode = DEFAULT_HOLGURA) {
  const { factor, extra } = HOLGURA_MODES[mode] || HOLGURA_MODES[DEFAULT_HOLGURA];
  return Math.round(containerWidth * factor + extra);
}

// ─── Categorización y límites de peso ───────────────────────────

/** Umbrales de ancho (px) para clasificar una imagen. */
export const CATEGORY_THRESHOLDS = { hero: 1400, icon: 100 };

/**
 * Límites de peso por categoría y nivel de agresividad, en bytes.
 * `none` desactiva el límite por completo.
 */
export const SIZE_LIMITS = {
  conservative: { hero: 300 * 1024, content: 150 * 1024, icon: 50 * 1024 },
  balanced:     { hero: 200 * 1024, content: 100 * 1024, icon: 30 * 1024 },
  aggressive:   { hero: 100 * 1024, content: 50 * 1024,  icon: 20 * 1024 },
  none:         null,
};

export const DEFAULT_AGGRESSIVENESS = 'balanced';

/** Calidad inicial y escalones de la cascada de re-compresión. */
export const QUALITY_START = 82;
export const QUALITY_STEPS = [82, 70, 55, 40];

/**
 * Anchos de fallback cuando no se pudo medir el contenedor.
 * Se elige el primer umbral que el ancho original supere.
 * `null` como target significa "no redimensionar".
 */
export const FALLBACK_WIDTHS = [
  { minOriginal: 1920, target: 1600 },
  { minOriginal: 1200, target: 1200 },
  { minOriginal: 800,  target: 800 },
  { minOriginal: 400,  target: 600 },
];

// ─── Descarga ───────────────────────────────────────────────────

export const DOWNLOAD_TIMEOUT = 15000;
export const DOWNLOAD_RETRIES = 2;
/** Techo defensivo: nada razonable en una web pesa más que esto. */
export const MAX_IMAGE_BYTES = 40 * 1024 * 1024;

/** Cuántas imágenes se descargan/optimizan en paralelo por página. */
export const IMAGE_CONCURRENCY = 4;

// ─── Limpieza automática ────────────────────────────────────────

/**
 * Solo se limpian directorios efímeros. `output/` NUNCA se borra
 * automáticamente: contiene el trabajo del usuario y se administra
 * desde la vista de Proyectos.
 */
export const CLEANUP_DIRS = [uploadsDir, tempZipsDir];
export const CLEANUP_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

/** Tamaño máximo del CSV subido. */
export const MAX_CSV_BYTES = 10 * 1024 * 1024;
