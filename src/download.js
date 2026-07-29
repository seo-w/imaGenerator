/**
 * Descarga de imágenes con reintentos.
 */

import { DOWNLOAD_TIMEOUT, DOWNLOAD_RETRIES, MAX_IMAGE_BYTES } from './config.js';
import { sleep } from './util.js';

const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

/**
 * Descarga una imagen.
 *
 * Manda `Referer` con la página de origen: varios CDN (HubSpot, Cloudflare
 * con hotlink protection, Shopify) devuelven 403 a peticiones sin referer.
 *
 * @param {string} url - URL de la imagen
 * @param {Object} options
 * @param {string} [options.referer] - URL de la página donde aparece
 * @returns {Promise<Buffer>}
 */
export async function downloadImage(url, { referer = '' } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT);

  try {
    const headers = {
      'User-Agent': USER_AGENT,
      'Accept': 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
    };
    if (referer) {
      headers.Referer = referer;
      try { headers.Origin = new URL(referer).origin; } catch { /* referer inválido */ }
    }

    const response = await fetch(url, { signal: controller.signal, headers, redirect: 'follow' });
    if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`.trim());

    // Un servidor que responde HTML a una URL de imagen suele ser una
    // página de error 200. Sin este chequeo, el fallo aparece más tarde
    // como un error confuso de Sharp.
    const contentType = (response.headers.get('content-type') || '').toLowerCase();
    if (contentType.includes('text/html')) {
      throw new Error('El servidor devolvió HTML en lugar de una imagen');
    }

    const declaredLength = Number(response.headers.get('content-length') || 0);
    if (declaredLength > MAX_IMAGE_BYTES) {
      throw new Error(`Imagen demasiado grande (${Math.round(declaredLength / 1024 / 1024)}MB)`);
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    if (!buffer.length) throw new Error('Respuesta vacía');
    if (buffer.length > MAX_IMAGE_BYTES) {
      throw new Error(`Imagen demasiado grande (${Math.round(buffer.length / 1024 / 1024)}MB)`);
    }
    return buffer;
  } finally {
    clearTimeout(timer);
  }
}

/** Códigos de error que no mejoran reintentando. */
const PERMANENT_ERRORS = /HTTP 4(0[0-9]|1[0-8])|devolvió HTML|demasiado grande/;

/**
 * Descarga con reintentos y backoff exponencial.
 * No reintenta ante errores permanentes (404, 403, 410...).
 */
export async function downloadImageWithRetry(url, options = {}) {
  let lastError;
  for (let attempt = 0; attempt <= DOWNLOAD_RETRIES; attempt++) {
    try {
      if (attempt > 0) await sleep(Math.min(1000 * 2 ** (attempt - 1), 5000));
      return await downloadImage(url, options);
    } catch (err) {
      lastError = err;
      if (PERMANENT_ERRORS.test(err.message)) break;
    }
  }
  throw lastError;
}
