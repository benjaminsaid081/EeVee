'use strict';

/**
 * Transcripción local con Whisper (Transformers.js + ONNX).
 * Gratis, privada y sin conexión una vez descargado el modelo.
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const CACHE_DIR = path.join(ROOT, 'models');
const MODEL = process.env.EV_STT_MODEL || 'onnx-community/whisper-small';

let pipelinePromise = null;
let status = 'idle';
let lastError = '';

function parseWav(buffer) {
  if (buffer.length < 44) throw new Error('WAV demasiado corto');
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('No es un WAV válido');
  }

  let offset = 12;
  let fmt = null;
  let data = null;

  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const body = offset + 8;

    if (id === 'fmt ') {
      fmt = {
        format: buffer.readUInt16LE(body),
        channels: buffer.readUInt16LE(body + 2),
        sampleRate: buffer.readUInt32LE(body + 4),
        bits: buffer.readUInt16LE(body + 14),
      };
    } else if (id === 'data') {
      data = buffer.subarray(body, Math.min(body + size, buffer.length));
    }

    offset = body + size + (size % 2);
  }

  if (!fmt || !data) throw new Error('WAV sin datos');
  if (fmt.format !== 1 || fmt.bits !== 16) throw new Error('Solo se admite WAV PCM de 16 bits');

  const frames = Math.floor(data.length / 2 / fmt.channels);
  const samples = new Float32Array(frames);

  for (let i = 0; i < frames; i += 1) {
    let sum = 0;
    for (let c = 0; c < fmt.channels; c += 1) {
      sum += data.readInt16LE((i * fmt.channels + c) * 2);
    }
    samples[i] = sum / fmt.channels / 32768;
  }

  return { samples, sampleRate: fmt.sampleRate, channels: fmt.channels };
}

function resample(samples, fromRate, toRate) {
  if (fromRate === toRate) return samples;
  const ratio = fromRate / toRate;
  const length = Math.floor(samples.length / ratio);
  const out = new Float32Array(length);

  for (let i = 0; i < length; i += 1) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const i1 = Math.min(i0 + 1, samples.length - 1);
    const frac = pos - i0;
    out[i] = samples[i0] * (1 - frac) + samples[i1] * frac;
  }
  return out;
}

async function getPipeline() {
  if (pipelinePromise) return pipelinePromise;

  status = 'loading';
  pipelinePromise = (async () => {
    const { pipeline, env } = await import('@huggingface/transformers');
    env.cacheDir = CACHE_DIR;
    fs.mkdirSync(CACHE_DIR, { recursive: true });

    const asr = await pipeline('automatic-speech-recognition', MODEL, {
      dtype: 'q8',
      device: 'cpu',
    });

    status = 'ready';
    return asr;
  })().catch((err) => {
    status = 'error';
    lastError = err.message;
    pipelinePromise = null;
    throw err;
  });

  return pipelinePromise;
}

async function warmup() {
  try {
    await getPipeline();
    return true;
  } catch {
    return false;
  }
}

async function transcribeWav(buffer, language = 'es') {
  const { samples, sampleRate, channels } = parseWav(buffer);
  const audio = sampleRate === 16000 ? samples : resample(samples, sampleRate, 16000);

  if (audio.length < 1600) return '';

  const asr = await getPipeline();
  const output = await asr(audio, { language, task: 'transcribe' });
  return String(output?.text || '').trim();
}

function sttStatus() {
  return { status, model: MODEL, error: lastError, ready: status === 'ready' };
}

module.exports = { transcribeWav, warmup, sttStatus, parseWav, MODEL, CACHE_DIR };
