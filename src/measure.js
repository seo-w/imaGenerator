/**
 * Motor de medición: cuánto mide realmente cada imagen en su contenedor.
 *
 * Estrategia (reescrita en v4):
 *
 *   1. Las filas del CSV se agrupan por URL de página.
 *   2. Cada página se carga UNA sola vez y se inventaría por completo:
 *      todas las imágenes renderizadas (img, srcset, picture/source,
 *      background-image) con el rect de su contenedor.
 *   3. El cruce CSV ↔ inventario se hace en Node, con niveles de
 *      confianza explícitos.
 *
 * Por qué así: la versión anterior abría una pestaña por FILA (3.1 cargas
 * por página en lotes reales) y resolvía el matching dentro de
 * page.evaluate, donde no se puede inspeccionar ni testear. Comparaba
 * además el nombre del CSV percent-encoded contra el del DOM decodificado,
 * así que `10%20months%20(1).png` nunca hacía match con `10 months (1).png`.
 */

import puppeteer from 'puppeteer';
import {
  VIEWPORT_DESKTOP, PAGE_TIMEOUT,
  BLOCKED_RESOURCE_TYPES, BLOCKED_URL_PATTERNS,
} from './config.js';
import {
  normalizeImageUrl, imageBaseName, imageExtension, urlPathname,
  normalizeTextForMatch, nameTokens, sleep,
} from './util.js';

/** Confianza de cada método de match. Mayor gana. */
const METHOD_SCORES = {
  'selector': 100,
  'url-exact': 90,
  'path-exact': 80,
  'basename-exact': 70,
  'basename-normalized': 60,
  'basename-contains': 45,
  'token-overlap': 30,
};

/** Ancho mínimo creíble. Por debajo se considera no medido. */
const MIN_CREDIBLE_WIDTH = 8;

export async function createBrowser() {
  return puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
    ],
  });
}

/**
 * Agrupa filas por página, preservando el orden de aparición.
 * @returns {Array<{pageUrl: string, indices: number[], selectors: string[]}>}
 */
export function groupByPage(rows) {
  const groups = new Map();
  rows.forEach((row, index) => {
    const key = row.pageUrl || '';
    if (!groups.has(key)) groups.set(key, { pageUrl: key, indices: [], selectors: [] });
    const group = groups.get(key);
    group.indices.push(index);
    if (row.selector && !group.selectors.includes(row.selector)) {
      group.selectors.push(row.selector);
    }
  });
  return [...groups.values()];
}

/**
 * Carga una página e inventaría todas sus imágenes renderizadas.
 *
 * @returns {Promise<{ok: boolean, inventory: Array, selectorRects: Object, error?: string}>}
 */
export async function harvestPage(browser, pageUrl, { selectors = [] } = {}) {
  let page;
  try {
    page = await browser.newPage();
    await page.setViewport(VIEWPORT_DESKTOP);
    await page.setRequestInterception(true);

    page.on('request', request => {
      const url = request.url();
      if (BLOCKED_RESOURCE_TYPES.has(request.resourceType())
        || BLOCKED_URL_PATTERNS.some(pattern => url.includes(pattern))) {
        request.abort().catch(() => {});
      } else {
        request.continue().catch(() => {});
      }
    });

    await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT });

    // networkidle2 completo suele colgarse en sitios con polling o chat
    // widgets; con domcontentloaded + el scroll de abajo alcanza y es
    // bastante más rápido.
    await page.waitForNetworkIdle({ idleTime: 500, timeout: 8000 }).catch(() => {});

    await unblockPage(page);
    await triggerLazyLoading(page);

    const inventory = await page.evaluate(collectInventory);
    const selectorRects = selectors.length
      ? await page.evaluate(measureSelectors, selectors)
      : {};

    return { ok: true, inventory, selectorRects };
  } catch (err) {
    return { ok: false, inventory: [], selectorRects: {}, error: err.message };
  } finally {
    if (page) await page.close().catch(() => {});
  }
}

/**
 * Neutraliza lo que impide medir: overlays fijos y bloqueo de scroll.
 *
 * Deliberadamente NO se hace clic en "Aceptar" de los banners de cookies
 * — eso sería consentir en nombre del usuario en un sitio de terceros.
 * Ocultar el overlay logra lo mismo para medir, sin aceptar nada.
 */
async function unblockPage(page) {
  await page.evaluate(() => {
    for (const el of [document.documentElement, document.body]) {
      if (!el) continue;
      el.style.setProperty('overflow', 'auto', 'important');
      el.style.setProperty('position', 'static', 'important');
    }

    const viewportArea = window.innerWidth * window.innerHeight;
    for (const el of document.querySelectorAll('body *')) {
      const style = window.getComputedStyle(el);
      if (style.position !== 'fixed' && style.position !== 'sticky') continue;
      const rect = el.getBoundingClientRect();
      const coversViewport = rect.width * rect.height > viewportArea * 0.5;
      const isHighLayer = Number(style.zIndex) > 500;
      // Un overlay que tapa medio viewport, o una capa muy alta que
      // además menciona cookies/consent en su markup
      const looksLikeConsent = /cookie|consent|gdpr|privacy|modal|overlay|backdrop/i
        .test(`${el.id} ${el.className}`);
      if ((coversViewport && (isHighLayer || looksLikeConsent)) || (isHighLayer && looksLikeConsent)) {
        el.style.setProperty('display', 'none', 'important');
      }
    }
  }).catch(() => {});
}

/**
 * Fuerza la carga de imágenes diferidas: promueve los `loading=lazy` a
 * eager, copia los data-attributes al src, y recorre la página por pasos.
 */
async function triggerLazyLoading(page) {
  await page.evaluate(() => {
    for (const img of document.querySelectorAll('img')) {
      img.loading = 'eager';
      const lazySrc = img.dataset.src || img.dataset.lazySrc || img.dataset.original
        || img.getAttribute('data-lazy-src') || img.getAttribute('data-echo');
      if (lazySrc && !img.src) img.src = lazySrc;
      const lazySrcset = img.dataset.srcset || img.getAttribute('data-lazy-srcset');
      if (lazySrcset && !img.srcset) img.srcset = lazySrcset;
    }
  }).catch(() => {});

  // Scroll por pasos de un viewport: dispara IntersectionObserver, que es
  // lo que usan casi todas las librerías de lazy loading.
  const steps = await page.evaluate(() => {
    const total = Math.max(document.body?.scrollHeight || 0, document.documentElement.scrollHeight);
    return Math.min(Math.ceil(total / window.innerHeight), 14);
  }).catch(() => 3);

  for (let i = 1; i <= steps; i++) {
    await page.evaluate(step => window.scrollTo(0, window.innerHeight * step), i).catch(() => {});
    await sleep(160);
  }

  await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
  // Margen para que terminen de decodificarse las que acaban de entrar
  await sleep(500);

  await page.evaluate(async () => {
    const pending = [...document.querySelectorAll('img')]
      .filter(img => !img.complete)
      .map(img => new Promise(resolve => {
        img.addEventListener('load', resolve, { once: true });
        img.addEventListener('error', resolve, { once: true });
      }));
    await Promise.race([
      Promise.all(pending),
      new Promise(resolve => setTimeout(resolve, 2500)),
    ]);
  }).catch(() => {});
}

/**
 * Se ejecuta DENTRO de la página. Devuelve el inventario completo de
 * imágenes renderizadas. No hace matching: solo recolecta.
 *
 * Debe ser autocontenida (se serializa al navegador).
 */
function collectInventory() {
  const entries = [];

  const absolutize = (url) => {
    if (!url) return null;
    const trimmed = String(url).trim();
    if (!trimmed || trimmed.startsWith('data:') || trimmed.startsWith('blob:')) return null;
    try { return new URL(trimmed, document.baseURI).href; } catch { return null; }
  };

  /** Extrae todas las URLs candidatas de un srcset. */
  const parseSrcset = (srcset) => {
    if (!srcset) return [];
    return String(srcset)
      .split(',')
      .map(part => absolutize(part.trim().split(/\s+/)[0]))
      .filter(Boolean);
  };

  const push = (kind, urls, element, extra = {}) => {
    const unique = [...new Set(urls.filter(Boolean))];
    if (!unique.length) return;
    const rect = element.getBoundingClientRect();
    entries.push({
      kind,
      urls: unique,
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      visible: rect.width > 0 && rect.height > 0,
      tag: element.tagName.toLowerCase(),
      ...extra,
    });
  };

  // ── <img> y su <picture> contenedor ──────────────────────────
  for (const img of document.querySelectorAll('img')) {
    const urls = [
      absolutize(img.currentSrc),
      absolutize(img.getAttribute('src')),
      absolutize(img.dataset.src),
      absolutize(img.dataset.lazySrc),
      absolutize(img.dataset.original),
      absolutize(img.getAttribute('data-lazy-src')),
      ...parseSrcset(img.getAttribute('srcset')),
      ...parseSrcset(img.dataset.srcset),
    ];

    // Los <source> del <picture> describen la MISMA imagen renderizada,
    // así que comparten el rect del <img>.
    const picture = img.closest('picture');
    if (picture) {
      for (const source of picture.querySelectorAll('source')) {
        urls.push(...parseSrcset(source.getAttribute('srcset')));
        urls.push(absolutize(source.getAttribute('src')));
      }
    }

    push('img', urls, img, {
      naturalWidth: img.naturalWidth || 0,
      naturalHeight: img.naturalHeight || 0,
    });
  }

  // ── background-image ─────────────────────────────────────────
  // Se resuelve vía CSSOM en vez de recorrer todo el DOM con
  // getComputedStyle: es órdenes de magnitud más barato.
  const extractUrls = (cssValue) => {
    if (!cssValue || cssValue === 'none') return [];
    const found = [];
    const regex = /url\((['"]?)(.*?)\1\)/g;
    let match;
    while ((match = regex.exec(cssValue)) !== null) {
      const abs = absolutize(match[2]);
      if (abs) found.push(abs);
    }
    return found;
  };

  const bgSelectors = new Set();
  let readableSheets = 0;

  const walkRules = (rules) => {
    for (const rule of rules) {
      if (rule.cssRules) { walkRules(rule.cssRules); continue; }
      if (!rule.style || !rule.selectorText) continue;
      const bg = rule.style.backgroundImage || rule.style.background;
      if (bg && bg.includes('url(')) bgSelectors.add(rule.selectorText);
    }
  };

  for (const sheet of document.styleSheets) {
    try {
      if (!sheet.cssRules) continue;
      readableSheets++;
      walkRules(sheet.cssRules);
    } catch { /* hoja cross-origin sin CORS: ilegible */ }
  }

  const seenBgElements = new Set();
  const addBackground = (el) => {
    if (seenBgElements.has(el)) return;
    seenBgElements.add(el);
    const urls = extractUrls(window.getComputedStyle(el).backgroundImage);
    if (urls.length) push('background', urls, el);
  };

  for (const selector of bgSelectors) {
    try {
      for (const el of document.querySelectorAll(selector)) addBackground(el);
    } catch { /* selector no soportado por querySelectorAll (::before, etc.) */ }
  }

  for (const el of document.querySelectorAll('[style*="background"]')) addBackground(el);

  // Si ninguna hoja fue legible (CSS en CDN sin CORS), recorrer un
  // subconjunto acotado del DOM como último recurso.
  if (readableSheets === 0) {
    const candidates = document.querySelectorAll(
      'div, section, header, footer, figure, a, li, article, aside, span'
    );
    const limit = Math.min(candidates.length, 4000);
    for (let i = 0; i < limit; i++) addBackground(candidates[i]);
  }

  // ── <svg><image> ─────────────────────────────────────────────
  for (const image of document.querySelectorAll('svg image')) {
    const href = image.getAttribute('href') || image.getAttribute('xlink:href');
    push('svg-image', [absolutize(href)], image);
  }

  return entries;
}

/** Se ejecuta dentro de la página: mide los selectores CSS explícitos. */
function measureSelectors(selectors) {
  const rects = {};
  for (const selector of selectors) {
    try {
      const el = document.querySelector(selector);
      if (!el) continue;
      const rect = el.getBoundingClientRect();
      rects[selector] = { width: Math.round(rect.width), height: Math.round(rect.height) };
    } catch { /* selector inválido */ }
  }
  return rects;
}

// ─── Matching (en Node, testeable) ──────────────────────────────

/**
 * Precomputa las claves de comparación de una URL.
 * Se hace una vez por entrada de inventario y una vez por fila del CSV.
 */
export function urlKeys(url) {
  const normalized = normalizeImageUrl(url);
  const base = imageBaseName(url);
  return {
    normalized,
    pathname: urlPathname(url),
    base,
    baseNormalized: normalizeTextForMatch(base),
    extension: imageExtension(url),
    tokens: nameTokens(url),
  };
}

/** Indexa el inventario una sola vez por página. */
export function indexInventory(inventory) {
  return inventory.map(entry => ({
    ...entry,
    keys: entry.urls.map(urlKeys),
  }));
}

/**
 * Compara las claves de una URL del inventario contra las del CSV.
 * @returns {string|null} Nombre del método que hizo match, o null
 */
function compareKeys(target, candidate) {
  if (candidate.normalized === target.normalized) return 'url-exact';
  if (target.pathname && candidate.pathname === target.pathname) return 'path-exact';

  if (target.base.length > 2) {
    if (candidate.base === target.base) return 'basename-exact';
    if (candidate.baseNormalized === target.baseNormalized) return 'basename-normalized';

    // Contención: exige longitud para no matchear "logo" con "logotipo-x"
    if (target.baseNormalized.length > 5 && candidate.baseNormalized.length > 5
      && (candidate.baseNormalized.includes(target.baseNormalized)
        || target.baseNormalized.includes(candidate.baseNormalized))) {
      return 'basename-contains';
    }
  }

  // Solapamiento de tokens: al menos 2 (o todos, si hay uno solo) y la
  // extensión debe coincidir cuando ambas se conocen, para no confundir
  // derivados distintos del mismo nombre.
  if (target.tokens.length && candidate.tokens.length) {
    const shared = target.tokens.filter(t => candidate.tokens.includes(t)).length;
    const needed = Math.min(2, target.tokens.length);
    const extensionsAgree = !target.extension || !candidate.extension
      || target.extension === candidate.extension;
    if (shared >= needed && extensionsAgree) return 'token-overlap';
  }

  return null;
}

/**
 * Busca en el inventario la entrada que corresponde a `imageUrl`.
 *
 * Ante varias coincidencias del mismo nivel de confianza gana la de mayor
 * área visible: si la imagen aparece como thumbnail de 100px y como hero
 * de 1200px, generamos UN solo archivo, y quedarse corto produce una
 * imagen borrosa mientras que sobrar solo cuesta unos KB.
 *
 * @param {Array} indexed - Inventario ya indexado con indexInventory()
 * @param {string} imageUrl - URL de la imagen buscada
 * @param {string} [selector] - Selector CSS explícito del CSV
 * @param {Object} [selectorRects] - Rects resueltos en la página
 * @returns {{width, height, method, score, kind}|null}
 */
export function matchInventory(indexed, imageUrl, selector = '', selectorRects = {}) {
  // El selector explícito manda: lo puso una persona a propósito.
  if (selector && selectorRects[selector]?.width > MIN_CREDIBLE_WIDTH) {
    const rect = selectorRects[selector];
    return { ...rect, method: 'selector', score: METHOD_SCORES.selector, kind: 'selector' };
  }

  const target = urlKeys(imageUrl);
  let best = null;

  for (const entry of indexed) {
    let entryMethod = null;
    let entryScore = -1;
    for (const candidate of entry.keys) {
      const method = compareKeys(target, candidate);
      if (!method) continue;
      const score = METHOD_SCORES[method] || 0;
      if (score > entryScore) { entryScore = score; entryMethod = method; }
    }
    if (!entryMethod) continue;

    const area = entry.visible ? entry.width * entry.height : 0;
    const contender = {
      width: entry.width, height: entry.height,
      method: entryMethod, score: entryScore,
      kind: entry.kind, visible: entry.visible, area,
    };

    if (!best) { best = contender; continue; }
    // Visible siempre le gana a no visible; luego confianza; luego área
    if (contender.visible !== best.visible) {
      if (contender.visible) best = contender;
      continue;
    }
    if (contender.score > best.score) { best = contender; continue; }
    if (contender.score === best.score && contender.area > best.area) best = contender;
  }

  if (!best || best.width < MIN_CREDIBLE_WIDTH) return null;
  return best;
}

export { METHOD_SCORES, MIN_CREDIBLE_WIDTH };
