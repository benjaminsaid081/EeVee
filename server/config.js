'use strict';

/**
 * Configuración de EV.
 * Precedencia: config/ev.config.json  >  variables de entorno (.env)  >  valores por defecto.
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const CONFIG_DIR = path.join(ROOT, 'config');
const CONFIG_FILE = path.join(CONFIG_DIR, 'ev.config.json');

// Cargar .env (Node >= 20.12 trae loadEnvFile; si no, parser mínimo).
try {
  if (typeof process.loadEnvFile === 'function') {
    process.loadEnvFile(path.join(ROOT, '.env'));
  }
} catch {
  /* sin .env: se usan las variables del sistema */
}

const AI_PRESETS = {
  openai: 'https://api.openai.com/v1',
  gemini: 'https://generativelanguage.googleapis.com/v1beta',
  anthropic: 'https://api.anthropic.com/v1',
};

const DEFAULTS = {
  assistantName: 'EV',
  aiProvider: 'openai',
  aiKeys: { openai: '', gemini: '', anthropic: '', compatible: '' },
  aiModels: {
    openai: 'gpt-4o-mini',
    gemini: 'gemini-2.5-flash',
    'gemini-live': 'gemini-3.8-live',
    anthropic: 'claude-sonnet-4-5',
    compatible: 'gpt-4o-mini',
  },
  aiBaseUrl: '',
  elevenKey: '',
  elevenVoiceId: '21m00Tcm4TlvDq8ikWAM',
  elevenModel: 'eleven_multilingual_v2',
  voiceEnabled: true,
  voiceVolume: 0.9,
  ttsProvider: 'auto',
  edgeVoice: 'es-ES-ElviraNeural',
  edgeRate: 0,
  geminiVoice: 'Kore',
  geminiTtsModel: 'gemini-2.5-flash-preview-tts',
  ttsLeadMs: 400,
  allowShell: false,
  language: 'es-ES',
  continuousListening: true,
  conversationMode: true,
  vadSilenceMs: 900,
  vadSensitivity: 1,
  sttProvider: 'auto',
  visionModel: 'gemini-3.5-flash-lite',
  allowScreenControl: true,
  speechRate: 1,
  spotifyClientId: '',
  spotifyClientSecret: '',
  spotifyRefreshToken: '',
  googleClientId: '',
  googleClientSecret: '',
  googleRefreshToken: '',
};

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

const stored = readJson(CONFIG_FILE);
const storedKeys = stored.aiKeys || {};
const storedModels = stored.aiModels || {};

const aiKeys = {
  openai: process.env.OPENAI_API_KEY || storedKeys.openai || stored.openaiKey || '',
  gemini:
    process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || storedKeys.gemini || '',
  anthropic: process.env.ANTHROPIC_API_KEY || storedKeys.anthropic || '',
  compatible: process.env.EV_COMPATIBLE_KEY || storedKeys.compatible || '',
};

const aiModels = {
  ...DEFAULTS.aiModels,
  ...storedModels,
  openai:
    process.env.OPENAI_MODEL || storedModels.openai || stored.openaiModel || DEFAULTS.aiModels.openai,
  gemini: process.env.GEMINI_MODEL || storedModels.gemini || DEFAULTS.aiModels.gemini,
  'gemini-live':
    process.env.GEMINI_LIVE_MODEL || storedModels['gemini-live'] || DEFAULTS.aiModels['gemini-live'],
  anthropic: process.env.ANTHROPIC_MODEL || storedModels.anthropic || DEFAULTS.aiModels.anthropic,
};

const aiBaseUrl = process.env.OPENAI_BASE_URL || stored.aiBaseUrl || '';

const config = {
  ...DEFAULTS,
  ...stored,
  aiProvider: process.env.EV_AI_PROVIDER || stored.aiProvider || DEFAULTS.aiProvider,
  aiKeys,
  aiModels,
  aiBaseUrl,
  // Alias heredados (OpenAI también se usa para transcribir si hace falta).
  openaiKey: aiKeys.openai,
  openaiModel: aiModels.openai,
  baseUrl: aiBaseUrl || AI_PRESETS.openai,
  elevenKey: process.env.ELEVENLABS_API_KEY || stored.elevenKey || '',
  elevenVoiceId:
    process.env.ELEVENLABS_VOICE_ID || stored.elevenVoiceId || DEFAULTS.elevenVoiceId,
  elevenModel: process.env.ELEVENLABS_MODEL || stored.elevenModel || DEFAULTS.elevenModel,
  ttsProvider: process.env.EV_TTS_PROVIDER || stored.ttsProvider || DEFAULTS.ttsProvider,
  edgeVoice: process.env.EV_EDGE_VOICE || stored.edgeVoice || DEFAULTS.edgeVoice,
  geminiVoice: process.env.GEMINI_VOICE || stored.geminiVoice || DEFAULTS.geminiVoice,
  geminiTtsModel:
    process.env.GEMINI_TTS_MODEL || stored.geminiTtsModel || DEFAULTS.geminiTtsModel,
  ttsLeadMs: (() => {
    const fromEnv = Number(process.env.EV_TTS_LEAD_MS);
    if (process.env.EV_TTS_LEAD_MS !== undefined && Number.isFinite(fromEnv)) {
      return Math.min(1500, Math.max(0, fromEnv));
    }
    return stored.ttsLeadMs ?? DEFAULTS.ttsLeadMs;
  })(),
  sttProvider: process.env.EV_STT_PROVIDER || stored.sttProvider || DEFAULTS.sttProvider,
  visionModel: process.env.GEMINI_VISION_MODEL || stored.visionModel || DEFAULTS.visionModel,
  allowScreenControl: process.env.EV_ALLOW_SCREEN_CONTROL !== '0' && stored.allowScreenControl !== false,
  spotifyClientId: process.env.SPOTIFY_CLIENT_ID || stored.spotifyClientId || '',
  spotifyClientSecret: process.env.SPOTIFY_CLIENT_SECRET || stored.spotifyClientSecret || '',
  spotifyRefreshToken:
    process.env.SPOTIFY_REFRESH_TOKEN || stored.spotifyRefreshToken || '',
  googleClientId: process.env.GOOGLE_CLIENT_ID || stored.googleClientId || '',
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET || stored.googleClientSecret || '',
  googleRefreshToken: process.env.GOOGLE_REFRESH_TOKEN || stored.googleRefreshToken || '',
};

/** Proveedor de IA activo, ya resuelto. */
function aiResolved() {
  const provider = config.aiProvider || 'openai';
  const keyProvider = provider === 'gemini-live' ? 'gemini' : provider;
  const key = (config.aiKeys && config.aiKeys[keyProvider]) || '';
  const model = (config.aiModels && config.aiModels[provider]) || '';

  let baseUrl = AI_PRESETS[provider];
  if (provider === 'compatible') {
    baseUrl = process.env.EV_COMPATIBLE_BASE_URL || config.aiBaseUrl || '';
  } else if (provider === 'openai') {
    baseUrl = config.baseUrl || AI_PRESETS.openai;
  } else if (provider === 'gemini' || provider === 'gemini-live') {
    baseUrl = process.env.GEMINI_BASE_URL || AI_PRESETS.gemini;
  } else if (provider === 'anthropic') {
    baseUrl = process.env.ANTHROPIC_BASE_URL || AI_PRESETS.anthropic;
  }

  return { provider, key, model, baseUrl };
}

function saveConfig(patch) {
  Object.assign(config, patch);
  if (patch.aiKeys) config.openaiKey = patch.aiKeys.openai || '';
  if (patch.aiModels) config.openaiModel = patch.aiModels.openai || config.openaiModel;
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  const toSave = { ...config };
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(toSave, null, 2), 'utf8');
  return toSave;
}

function publicConfig() {
  const active = aiResolved();

  return {
    assistantName: config.assistantName,
    aiProvider: active.provider,
    aiModels: config.aiModels,
    aiModel: active.model,
    aiBaseUrl: config.aiBaseUrl,
    aiHasKey: Boolean(active.key),
    hasAI: {
      openai: Boolean(config.aiKeys.openai),
      gemini: Boolean(config.aiKeys.gemini),
      'gemini-live': Boolean(config.aiKeys.gemini),
      anthropic: Boolean(config.aiKeys.anthropic),
      compatible: Boolean(config.aiKeys.compatible),
    },
    elevenVoiceId: config.elevenVoiceId,
    elevenModel: config.elevenModel,
    voiceEnabled: config.voiceEnabled,
    voiceVolume: config.voiceVolume,
    ttsProvider: config.ttsProvider,
    edgeVoice: config.edgeVoice,
    edgeRate: config.edgeRate,
    geminiVoice: config.geminiVoice,
    geminiTtsModel: config.geminiTtsModel,
    ttsLeadMs: config.ttsLeadMs,
    hasGeminiKey: Boolean(config.aiKeys.gemini),
    allowShell: config.allowShell,
    language: config.language,
    continuousListening: config.continuousListening,
    conversationMode: config.conversationMode,
    vadSilenceMs: config.vadSilenceMs,
    vadSensitivity: config.vadSensitivity,
    sttProvider: config.sttProvider,
    visionModel: config.visionModel,
    allowScreenControl: config.allowScreenControl,
    speechRate: config.speechRate,
    hasOpenAI: Boolean(config.aiKeys.openai),
    hasElevenLabs: Boolean(config.elevenKey),
    spotifyClientId: config.spotifyClientId,
    hasSpotifyKey: Boolean(config.spotifyClientId && config.spotifyClientSecret),
    hasSpotifyConnected: Boolean(config.spotifyRefreshToken),
    googleClientId: config.googleClientId,
    hasGoogleConnected: Boolean(config.googleRefreshToken),
  };
}

/** Carpetas del sistema (Escritorio, Documentos, etc.) resueltas por Windows. */
function loadShellFolders() {
  const fallback = {
    desktop: path.join(os.homedir(), 'Desktop'),
    documents: path.join(os.homedir(), 'Documents'),
    downloads: path.join(os.homedir(), 'Downloads'),
    pictures: path.join(os.homedir(), 'Pictures'),
    music: path.join(os.homedir(), 'Music'),
    videos: path.join(os.homedir(), 'Videos'),
    home: os.homedir(),
  };
  if (process.platform !== 'win32') return fallback;

  try {
    const ps = [
      "$OutputEncoding=[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);",
      '$names=@("Desktop","MyDocuments","MyPictures","MyMusic","MyVideos");',
      '$out=@{};',
      'foreach($n in $names){ $out[$n]=[Environment]::GetFolderPath($n) };',
      '$out["Downloads"]=(New-Object -ComObject Shell.Application).NameSpace("shell:Downloads").Self.Path;',
      '$out | ConvertTo-Json -Compress',
    ].join(' ');
    const raw = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
      encoding: 'utf8',
      timeout: 15000,
      windowsHide: true,
    });
    const data = JSON.parse(raw);
    return {
      desktop: data.Desktop || fallback.desktop,
      documents: data.MyDocuments || fallback.documents,
      downloads: data.Downloads || fallback.downloads,
      pictures: data.MyPictures || fallback.pictures,
      music: data.MyMusic || fallback.music,
      videos: data.MyVideos || fallback.videos,
      home: os.homedir(),
    };
  } catch {
    return fallback;
  }
}

const folders = loadShellFolders();

module.exports = {
  ROOT,
  config,
  DEFAULTS,
  AI_PRESETS,
  aiResolved,
  saveConfig,
  publicConfig,
  folders,
  CONFIG_FILE,
};
