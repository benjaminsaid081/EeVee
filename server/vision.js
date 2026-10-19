'use strict';

/**
 * Visión de pantalla + control de ratón/teclado.
 * Captura la pantalla, la manda a Gemini (imagen) y traduce descripciones
 * a coordenadas para poder hacer clic o escribir en el campo correcto.
 */

const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const { execFile, spawn } = require('node:child_process');
const sharp = require('sharp');
const { config } = require('./config');
const host = require('./pwsh-host');

const SCRIPTS = path.join(__dirname, 'scripts');
const TMP = path.join(__dirname, '..', '.tmp');
const POWERSHELL = 'powershell.exe';

let scrollProcess = null;
let captureSequence = 0;
let displayCache = { at: 0, value: null };
let thinkingConfigUnsupported = false;
let thinkingConfigModel = '';

function runFile(script, args = [], timeout = 30000) {
  return new Promise((resolve) => {
    execFile(
      POWERSHELL,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(SCRIPTS, script), ...args],
      { timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout, stderr) => resolve({ error, stdout: String(stdout || ''), stderr: String(stderr || '') })
    );
  });
}

async function displayInfoFallback() {
  const result = await runFile('display-info.ps1', [], 15000);
  const line = result.stdout.trim().split(/\r?\n/).pop();
  try {
    const info = JSON.parse(line);
    return { ...info, screens: Array.isArray(info.screens) ? info.screens : [] };
  } catch {
    return { x: 0, y: 0, width: 1920, height: 1080, count: 1, screens: [] };
  }
}

/**
 * Datos del escritorio virtual. Se cachean unos segundos porque el layout
 * cambia muy rara vez y así no se paga un viaje a PowerShell por cada clic.
 */
async function displayInfo(force = false) {
  if (!force && displayCache.value && Date.now() - displayCache.at < 30000) {
    return displayCache.value;
  }

  try {
    const result = await host.command('display', [], 8000);
    const value = {
      x: Number(result.x) || 0,
      y: Number(result.y) || 0,
      width: Number(result.width) || 0,
      height: Number(result.height) || 0,
      count: Number(result.count) || 1,
      screens: Array.isArray(result.screens) ? result.screens : [],
    };
    displayCache = { at: Date.now(), value };
    return value;
  } catch {
    const value = await displayInfoFallback();
    displayCache = { at: Date.now(), value };
    return value;
  }
}

async function captureScreenFallback(width) {
  const dir = path.join(TMP, 'screens');
  fs.mkdirSync(dir, { recursive: true });

  const result = await runFile('screenshot.ps1', ['-OutDir', dir], 30000);
  const file = result.stdout.trim().split(/\r?\n/).pop();
  if (!file || !fs.existsSync(file)) throw new Error('No pude capturar la pantalla');

  const meta = await sharp(file).metadata();
  const targetWidth = Math.min(width, meta.width);
  const targetHeight = Math.max(1, Math.round(meta.height * (targetWidth / meta.width)));

  const buffer = await sharp(file)
    .resize({ width: targetWidth, height: targetHeight })
    .jpeg({ quality: 72 })
    .toBuffer();

  await fsp.unlink(file).catch(() => {});

  return {
    data: buffer.toString('base64'),
    imageWidth: targetWidth,
    imageHeight: targetHeight,
    screenW: meta.width,
    screenH: meta.height,
    screenX: 0,
    screenY: 0,
  };
}

/**
 * Captura y redimensiona en el mismo proceso persistente de PowerShell.
 * Antes se guardaba un PNG a resolución completa y luego se redimensionaba
 * con sharp; ahora se escala durante la captura y se guarda JPEG directo.
 */
async function captureScreen(width = 1280) {
  const dir = path.join(TMP, 'screens');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `EV-${Date.now()}-${++captureSequence}.jpg`);

  try {
    const result = await host.command('capture', [file, String(width)], 20000);
    if (!result || !fs.existsSync(file)) throw new Error('No pude capturar la pantalla.');

    const buffer = await fsp.readFile(file);
    await fsp.unlink(file).catch(() => {});

    return {
      data: buffer.toString('base64'),
      imageWidth: Number(result.width) || width,
      imageHeight: Number(result.height) || 0,
      screenW: Number(result.screenW) || 0,
      screenH: Number(result.screenH) || 0,
      screenX: Number(result.screenX) || 0,
      screenY: Number(result.screenY) || 0,
    };
  } catch {
    await fsp.unlink(file).catch(() => {});
    return captureScreenFallback(width);
  }
}

async function geminiVision(prompt, image, options = {}) {
  const key = config.aiKeys.gemini;
  if (!key) {
    const error = new Error('Necesito tu clave de Gemini para ver la pantalla (Ajustes → Inteligencia).');
    error.code = 'NO_KEY';
    throw error;
  }

  const base = String(process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/+$/, '');
  const model = String(config.visionModel || 'gemini-3.8-flash').replace(/^models\//, '');
  if (thinkingConfigModel !== model) {
    thinkingConfigModel = model;
    thinkingConfigUnsupported = false;
  }
  const url = `${base}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`;

  const generationConfig = {
    temperature: 0.2,
    maxOutputTokens: options.maxTokens || 800,
  };
  // En modelos Flash el "thinking" añade segundos de espera sin mejorar la
  // localización visual. Si el modelo lo rechaza, no se vuelve a intentar.
  if (!thinkingConfigUnsupported) {
    generationConfig.thinkingConfig = { thinkingBudget: 0 };
  }
  if (options.json) generationConfig.responseMimeType = 'application/json';

  const body = {
    contents: [
      {
        role: 'user',
        parts: [{ inlineData: { mimeType: 'image/jpeg', data: image.data } }, { text: prompt }],
      },
    ],
    generationConfig,
  };

  let response = null;
  let lastError = null;
  let thinkingConfigAccepted = true;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(45000),
    });

    if (response.ok) break;

    const raw = await response.text().catch(() => '');
    let detail = raw;
    try {
      detail = JSON.parse(raw)?.error?.message || raw;
    } catch {}

    lastError = new Error(String(detail || `Gemini ${response.status}`).slice(0, 300));
    lastError.status = response.status;

    // Algunos modelos rechazan thinkingConfig con un 400 genérico. Se quita y
    // se repite una sola vez; si el 400 era por otro motivo, volverá a fallar.
    if (thinkingConfigAccepted && response.status === 400) {
      thinkingConfigAccepted = false;
      thinkingConfigUnsupported = true;
      delete generationConfig.thinkingConfig;
      attempt -= 1;
      continue;
    }

    // Saturación o límite temporal: reintentar con espera.
    if ([429, 500, 502, 503, 504].includes(response.status) && attempt < 2) {
      await new Promise((resolve) => setTimeout(resolve, 700 * (attempt + 1)));
      continue;
    }

    throw lastError;
  }

  if (!response || !response.ok) {
    throw lastError || new Error('Gemini no respondió.');
  }

  const data = await response.json();
  const parts = data?.candidates?.[0]?.content?.parts || [];
  const text = parts.map((part) => part.text || '').join('').trim();

  if (!text) {
    throw new Error('Gemini no devolvió texto (puede estar saturado).');
  }

  return text;
}

function parseJson(text) {
  const value = String(text || '').trim();
  try {
    return JSON.parse(value);
  } catch {}

  const match = value.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      return JSON.parse(match[0]);
    } catch {}
  }
  return null;
}

async function lookAtScreen(question) {
  const image = await captureScreen();
  const prompt = [
    'Estás viendo una captura de la pantalla del usuario.',
    'Responde en español, de forma breve y concreta (máximo 4 frases).',
    'Si te piden dónde está algo, indícalo con palabras; no inventes.',
    `Petición del usuario: ${question || 'Describe qué hay en la pantalla.'}`,
  ].join('\n');

  const text = await geminiVision(prompt, image);
  return { text: text || 'No pude interpretar la pantalla.', image };
}

async function locateOnScreen(target) {
  const image = await captureScreen();
  const prompt = [
    'Eres un localizador de elementos de interfaz sobre una captura de pantalla.',
    `Dimensiones de la imagen: ${image.imageWidth}x${image.imageHeight} píxeles.`,
    `Encuentra con máxima precisión el centro exacto del siguiente elemento: "${target}".`,
    'Devuelve ÚNICAMENTE un JSON válido con este formato exacto:',
    '{"found": true, "x": 0.5, "y": 0.5, "label": "nombre o texto del elemento"}',
    'Donde "x" e "y" representan el CENTRO geométrico exacto del elemento en coordenadas normalizadas de 0.0 a 1.0 (0.0 = borde superior/izquierdo, 1.0 = borde inferior/derecho).',
    'Importante: No devuelvas coordenadas más abajo del elemento ni incluyas sombras. Si es un botón, texto o campo, apunta exactamente al centro del texto o del cuadro interactivo.',
    'Si no se encuentra visible en la pantalla: {"found": false, "reason": "descripción de por qué no está"}',
    'No uses markdown ni explicaciones adicionales, solo el objeto JSON.',
  ].join('\n');

  const raw = await geminiVision(prompt, image, { json: true, maxTokens: 400 });
  const data = parseJson(raw);

  if (!data || !data.found) {
    return { found: false, reason: data?.reason || 'No lo encontré en la pantalla.', image };
  }

  // Soporte si el modelo devuelve box_2d o point [ymin, xmin, ymax, xmax] o [y, x]
  let nx = data.x;
  let ny = data.y;

  if (data.box_2d && Array.isArray(data.box_2d) && data.box_2d.length === 4) {
    // [ymin, xmin, ymax, xmax] normalizado a 1000
    const [ymin, xmin, ymax, xmax] = data.box_2d;
    ny = ((ymin + ymax) / 2) / 1000;
    nx = ((xmin + xmax) / 2) / 1000;
  } else if (data.point && Array.isArray(data.point) && data.point.length === 2) {
    // [y, x]
    ny = data.point[0] > 1 ? data.point[0] / 1000 : data.point[0];
    nx = data.point[1] > 1 ? data.point[1] / 1000 : data.point[1];
  }

  nx = Number(nx);
  ny = Number(ny);
  if (!Number.isFinite(nx) || !Number.isFinite(ny)) {
    return { found: false, reason: 'El modelo no devolvió coordenadas válidas.', image };
  }

  // Si devuelve coordenadas en escala 0-1000 (estándar de detección de objetos en Gemini).
  if (nx > 1 || ny > 1) {
    if (nx <= 1000 && ny <= 1000 && image.imageWidth !== 1000) {
      nx /= 1000;
      ny /= 1000;
    } else {
      nx /= image.imageWidth || 1;
      ny /= image.imageHeight || 1;
    }
  }

  nx = Math.max(0, Math.min(1, nx));
  ny = Math.max(0, Math.min(1, ny));

  // La captura ya trae el tamaño y el origen del escritorio virtual, así que
  // no hace falta otra llamada a PowerShell para consultar los monitores.
  const screenW = image.screenW || image.imageWidth;
  const screenH = image.screenH || image.imageHeight;
  const originX = image.screenX || 0;
  const originY = image.screenY || 0;

  return {
    found: true,
    label: data.label || target,
    x: Math.round(originX + nx * screenW),
    y: Math.round(originY + ny * screenH),
    nx,
    ny,
    image,
  };
}

async function clickAt(x, y, button = 'left') {
  const action = button === 'right' ? 'right' : 'click';
  const px = Math.round(x);
  const py = Math.round(y);

  try {
    await host.command(action, [px, py], 8000);
    return { ok: true };
  } catch {
    return runFile('mouse.ps1', ['-Action', action, '-X', String(px), '-Y', String(py)], 15000);
  }
}

async function doubleClickAt(x, y) {
  const px = Math.round(x);
  const py = Math.round(y);

  try {
    await host.command('double', [px, py], 8000);
    return { ok: true };
  } catch {
    return runFile('mouse.ps1', ['-Action', 'double', '-X', String(px), '-Y', String(py)], 15000);
  }
}

async function typeText(text) {
  const value = String(text);

  try {
    const encoded = Buffer.from(value, 'utf8').toString('base64');
    await host.command('type', [encoded], 15000);
    return { ok: true };
  } catch {
    return runFile('keys.ps1', ['-Text', value], 30000);
  }
}

async function pressKeys(keys) {
  const value = String(keys);

  try {
    await host.command('keys', [value], 10000);
    return { ok: true };
  } catch {
    return runFile('keys.ps1', ['-Keys', value], 15000);
  }
}

async function scroll(direction = 'down', amount = 120) {
  const dir = direction === 'up' ? 'up' : 'down';
  const value = Math.abs(amount) || 120;

  try {
    await host.command('scroll', [dir, value], 8000);
    return { ok: true };
  } catch {
    return runFile('mouse.ps1', ['-Action', 'scroll', '-Direction', dir, '-Amount', String(value)], 15000);
  }
}

function startAutoScroll({ direction = 'down', step = 120, intervalMs = 350 } = {}) {
  stopAutoScroll();

  scrollProcess = spawn(
    POWERSHELL,
    [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      path.join(SCRIPTS, 'autoscroll.ps1'),
      '-Direction',
      direction === 'up' ? 'up' : 'down',
      '-Step',
      String(Math.max(30, Math.min(400, Number(step) || 120))),
      '-IntervalMs',
      String(Math.max(150, Math.min(2000, Number(intervalMs) || 350))),
    ],
    { windowsHide: true }
  );

  scrollProcess.on('exit', () => {
    scrollProcess = null;
  });

  return true;
}

function stopAutoScroll() {
  if (!scrollProcess) return false;
  try {
    scrollProcess.kill();
  } catch {}
  scrollProcess = null;
  return true;
}

function isAutoScrolling() {
  return Boolean(scrollProcess);
}

module.exports = {
  captureScreen,
  displayInfo,
  geminiVision,
  lookAtScreen,
  locateOnScreen,
  clickAt,
  doubleClickAt,
  typeText,
  pressKeys,
  scroll,
  startAutoScroll,
  stopAutoScroll,
  isAutoScrolling,
  warmUp: () => host.warmUp(),
  shutdown: () => host.shutdown(),
};
