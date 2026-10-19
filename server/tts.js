'use strict';

/**
 * Voz de EV.
 *
 * Proveedores:
 *  - edge:    voces neuronales de Microsoft Edge. Gratis, sin clave y muy naturales.
 *  - eleven:  ElevenLabs (requiere clave; algunas voces necesitan plan de pago).
 *  - browser: la voz del sistema, en el navegador.
 *
 * Con "auto" se usa ElevenLabs si hay clave y, si falla, se cae a Edge sin cortar la conversación.
 */

const crypto = require('node:crypto');

let EdgeTTS = null;
try {
  ({ EdgeTTS } = require('@andresaya/edge-tts'));
} catch {
  EdgeTTS = null;
}

const EDGE_VOICES = [
  { id: 'es-ES-ElviraNeural', label: 'Elvira · España (mujer)' },
  { id: 'es-ES-AlvaroNeural', label: 'Álvaro · España (hombre)' },
  { id: 'es-MX-DaliaNeural', label: 'Dalia · México (mujer)' },
  { id: 'es-MX-JorgeNeural', label: 'Jorge · México (hombre)' },
  { id: 'es-AR-ElenaNeural', label: 'Elena · Argentina (mujer)' },
  { id: 'es-AR-TomasNeural', label: 'Tomás · Argentina (hombre)' },
  { id: 'es-CO-SalomeNeural', label: 'Salomé · Colombia (mujer)' },
  { id: 'es-US-PalomaNeural', label: 'Paloma · EE. UU. (mujer)' },
  { id: 'es-US-AlonsoNeural', label: 'Alonso · EE. UU. (hombre)' },
  { id: 'en-US-AriaNeural', label: 'Aria · Inglés (mujer)' },
];

const GEMINI_VOICES = [
  { id: 'Kore', label: 'Kore · femenina, cálida' },
  { id: 'Aoede', label: 'Aoede · femenina, ligera' },
  { id: 'Leda', label: 'Leda · femenina, juvenil' },
  { id: 'Zephyr', label: 'Zephyr · femenina, brillante' },
  { id: 'Callirrhoe', label: 'Callirrhoe · femenina, suave' },
  { id: 'Puck', label: 'Puck · masculina, animada' },
  { id: 'Charon', label: 'Charon · masculina, profunda' },
  { id: 'Orus', label: 'Orus · masculina, firme' },
  { id: 'Fenrir', label: 'Fenrir · masculina, intensa' },
  { id: 'Enceladus', label: 'Enceladus · masculina, grave' },
];

const cache = new Map(); // clave -> { buffer, provider, warning }
const MAX_CACHE = 60;

// Si ElevenLabs falla (402, 401, red), no lo reintentamos en 10 minutos.
let elevenDownUntil = 0;

function trimForSpeech(text) {
  return String(text || '')
    .replace(/[*_`#>]/g, '')
    .replace(/\[(.*?)\]\(.*?\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 1200);
}

function providerFor(config) {
  const selected = config.ttsProvider || 'auto';
  if (selected === 'browser') return 'browser';
  if (selected === 'edge') return 'edge';
  if (selected === 'gemini') return 'gemini';
  if (selected === 'eleven') return config.elevenKey ? 'eleven' : 'edge';
  // auto
  if (config.elevenKey && Date.now() >= elevenDownUntil) return 'eleven';
  return 'edge';
}

function cacheKey(provider, voice, rate, text) {
  return crypto.createHash('sha1').update(`${provider}|${voice}|${rate}|${text}`).digest('hex');
}

/* ------------------------------------------------------------------ */
/* ElevenLabs                                                          */
/* ------------------------------------------------------------------ */

async function elevenSynthesize(text, config) {
  if (!config.elevenKey) {
    const err = new Error('Sin clave de ElevenLabs');
    err.code = 'NO_KEY';
    throw err;
  }

  const voice = encodeURIComponent(config.elevenVoiceId || '21m00Tcm4TlvDq8ikWAM');
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${voice}?output_format=mp3_44100_128`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);

  try {
    const res = await fetch(url, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'xi-api-key': config.elevenKey,
        'Content-Type': 'application/json',
        Accept: 'audio/mpeg',
      },
      body: JSON.stringify({
        text,
        model_id: config.elevenModel || 'eleven_multilingual_v2',
        voice_settings: {
          stability: 0.45,
          similarity_boost: 0.8,
          style: 0.25,
          use_speaker_boost: true,
        },
      }),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      let message = `ElevenLabs ${res.status}`;
      try {
        message = JSON.parse(detail)?.detail?.message || message;
      } catch {}
      const err = new Error(message);
      err.status = res.status;
      err.code = 'ELEVEN_FAILED';
      throw err;
    }

    const buffer = Buffer.from(await res.arrayBuffer());
    if (!buffer.length) throw new Error('ElevenLabs devolvió audio vacío');
    return buffer;
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ */
/* Microsoft Edge (gratis)                                             */
/* ------------------------------------------------------------------ */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// El servicio de Edge limita las ráfagas: espaciamos las peticiones.
const EDGE_MIN_GAP = 1200;
let lastEdgeAt = 0;

async function edgeSynthesize(text, config) {
  if (!EdgeTTS) {
    const err = new Error('El motor de voz Edge no está instalado');
    err.code = 'EDGE_UNAVAILABLE';
    throw err;
  }

  const voice = config.edgeVoice || 'es-ES-ElviraNeural';
  const rate = Number.isFinite(Number(config.edgeRate)) ? Number(config.edgeRate) : 0;

  const wait = Math.max(0, lastEdgeAt + EDGE_MIN_GAP - Date.now());
  if (wait > 0) await sleep(wait);
  lastEdgeAt = Date.now();

  let lastError = null;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const tts = new EdgeTTS();
      await tts.synthesize(text, voice, {
        outputFormat: 'audio-24khz-48kbitrate-mono-mp3',
        rate: `${Math.max(-50, Math.min(50, rate))}%`,
        timeout: 20000,
        signal: AbortSignal.timeout(25000),
      });

      const buffer = tts.toBuffer();
      if (!buffer || !buffer.length) throw new Error('Edge devolvió audio vacío');
      return buffer;
    } catch (err) {
      lastError = err;
      const retryable = /429|Too Many Requests|ECONNRESET|ETIMEDOUT|socket hang up|503|502/i.test(err.message);
      if (!retryable || attempt === 2) break;
      await sleep(900 * (attempt + 1));
    }
  }

  const e = new Error(`Edge TTS: ${lastError?.message || 'error desconocido'}`);
  e.code = 'EDGE_FAILED';
  throw e;
}

/* ------------------------------------------------------------------ */
/* Google Gemini TTS                                                   */
/* ------------------------------------------------------------------ */

function pcmToWav(pcm, sampleRate = 24000, channels = 1, bits = 16) {
  const header = Buffer.alloc(44);
  const blockAlign = channels * (bits / 8);

  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * blockAlign, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bits, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);

  return Buffer.concat([header, pcm]);
}

async function geminiSynthesize(text, config) {
  const key = (config.aiKeys && config.aiKeys.gemini) || '';
  if (!key) {
    const err = new Error('Falta tu clave de Gemini. Añádela en Ajustes, en Inteligencia.');
    err.code = 'NO_KEY';
    throw err;
  }

  const base = String(
    process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta'
  ).replace(/\/+$/, '');
  const model = String(config.geminiTtsModel || 'gemini-2.5-flash-preview-tts').replace(/^models\//, '');
  const voice = config.geminiVoice || 'Kore';
  const url = `${base}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`;

  const body = {
    contents: [{ parts: [{ text: `Di con voz natural y cercana: ${text}` }] }],
    generationConfig: {
      responseModalities: ['AUDIO'],
      speechConfig: {
        voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } },
      },
    },
  };

  let res;
  let lastError;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(45000),
    });

    if (res.ok) break;

    const raw = await res.text().catch(() => '');
    let detail = raw;
    try {
      detail = JSON.parse(raw)?.error?.message || raw;
    } catch {}
    lastError = new Error(String(detail || `Gemini TTS ${res.status}`).slice(0, 300));
    lastError.status = res.status;
    lastError.code = 'GEMINI_FAILED';

    // La vista previa de Gemini TTS limita las peticiones por minuto.
    if (res.status === 429 && attempt === 0) {
      await sleep(1600);
      continue;
    }
    throw lastError;
  }

  if (!res || !res.ok) throw lastError || new Error('Gemini TTS no respondió');

  const data = await res.json();
  const part = (data?.candidates?.[0]?.content?.parts || []).find((p) => p.inlineData?.data);
  if (!part) throw new Error('Gemini no devolvió audio');

  const pcm = Buffer.from(part.inlineData.data, 'base64');
  if (!pcm.length) throw new Error('Gemini devolvió audio vacío');

  const mime = String(part.inlineData.mimeType || '');
  const rate = Number((mime.match(/rate=(\d+)/) || [])[1] || 24000);
  return pcmToWav(pcm, rate);
}

/* ------------------------------------------------------------------ */
/* Entrada principal                                                   */
/* ------------------------------------------------------------------ */

async function synthesize(text, config) {
  const clean = trimForSpeech(text);
  if (!clean) {
    const err = new Error('Texto vacío');
    err.code = 'EMPTY';
    throw err;
  }

  const provider = providerFor(config);
  if (provider === 'browser') {
    const err = new Error('Voz del navegador');
    err.code = 'BROWSER';
    throw err;
  }

  const voice =
    provider === 'eleven'
      ? config.elevenVoiceId
      : provider === 'gemini'
        ? config.geminiVoice || 'Kore'
        : config.edgeVoice;
  const key = cacheKey(provider, voice, provider === 'gemini' ? config.geminiTtsModel : config.edgeRate, clean);
  const cached = cache.get(key);
  if (cached) return { ...cached, cached: true };

  const store = (buffer, actualProvider, warning) => {
    const value = { buffer, provider: actualProvider, warning };
    if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value);
    cache.set(key, value);
    return value;
  };

  if (provider === 'gemini') {
    try {
      return store(await geminiSynthesize(clean, config), 'gemini');
    } catch (err) {
      if (err.code === 'NO_KEY') throw err;
      console.warn(`[EV] Gemini TTS no disponible (${err.message}); usando Edge.`);
      const buffer = await edgeSynthesize(clean, config);
      return store(buffer, 'edge', err.message);
    }
  }

  if (provider === 'eleven') {
    try {
      return store(await elevenSynthesize(clean, config), 'eleven');
    } catch (err) {
      if (config.ttsProvider === 'eleven') throw err;

      elevenDownUntil = Date.now() + 10 * 60 * 1000;
      console.warn(`[EV] ElevenLabs no disponible (${err.message}); usando Edge.`);
      const buffer = await edgeSynthesize(clean, config);
      return store(buffer, 'edge', err.message);
    }
  }

  try {
    return store(await edgeSynthesize(clean, config), 'edge');
  } catch (err) {
    if (config.elevenKey && config.ttsProvider === 'auto') {
      try {
        return store(await elevenSynthesize(clean, config), 'eleven');
      } catch {}
    }
    throw err;
  }
}

function clearCache() {
  cache.clear();
}

const edgeAvailable = Boolean(EdgeTTS);

module.exports = {
  synthesize,
  clearCache,
  trimForSpeech,
  providerFor,
  EDGE_VOICES,
  GEMINI_VOICES,
  edgeAvailable,
};
