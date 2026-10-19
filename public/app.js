'use strict';

/* ==========================================================================
   EV · cliente
   ========================================================================== */

const $ = (sel, root = document) => root.querySelector(sel);

const els = {
  body: document.body,
  orb: $('#orb'),
  orbShell: $('#orbShell'),
  stateText: $('#stateText'),
  live: $('#liveTranscript'),
  micBtn: $('#micBtn'),
  input: $('#input'),
  sendBtn: $('#sendBtn'),
  chips: $('#chips'),
  feed: $('#feed'),
  feedSubtitle: $('#feedSubtitle'),
  btnClear: $('#btnClear'),
  btnSettings: $('#btnSettings'),
  btnScreen: $('#btnScreen'),
  drawer: $('#settingsDrawer'),
  drawerBackdrop: $('#drawerBackdrop'),
  btnCloseSettings: $('#btnCloseSettings'),
  btnSave: $('#btnSave'),
  swVoice: $('#swVoice'),
  swConversation: $('#swConversation'),
  swShell: $('#swShell'),
  selVadSilence: $('#selVadSilence'),
  selVadSensitivity: $('#selVadSensitivity'),
  inpAIKey: $('#inpAIKey'),
  aiKeyLabel: $('#aiKeyLabel'),
  inpAIModel: $('#inpAIModel'),
  aiModelsList: $('#aiModels'),
  selAIProvider: $('#selAIProvider'),
  inpAIBase: $('#inpAIBase'),
  aiBaseField: $('#aiBaseField'),
  btnTestAI: $('#btnTestAI'),
  aiHint: $('#aiHint'),
  aiKeyLink: $('#aiKeyLink'),
  inpEleven: $('#inpEleven'),
  inpVoiceId: $('#inpVoiceId'),
  selProvider: $('#selProvider'),
  selEdgeVoice: $('#selEdgeVoice'),
  geminiVoiceField: $('#geminiVoiceField'),
  selGeminiVoice: $('#selGeminiVoice'),
  edgeVoiceField: $('#edgeVoiceField'),
  elevenKeyField: $('#elevenKeyField'),
  elevenVoiceField: $('#elevenVoiceField'),
  elevenNote: $('#elevenNote'),
  elevenVoicesLink: $('#elevenVoicesLink'),
  inpVolume: $('#inpVolume'),
  volLabel: $('#volLabel'),
  voiceHint: $('#voiceHint'),
  btnTestVoice: $('#btnTestVoice'),
  pillBrain: $('#pillBrain'),
  pillVoice: $('#pillVoice'),
  inpSpotifyId: $('#inpSpotifyId'),
  inpSpotifySecret: $('#inpSpotifySecret'),
  btnTestSpotify: $('#btnTestSpotify'),
  btnConnectSpotify: $('#btnConnectSpotify'),
  spotifyStatus: $('#spotifyStatus'),
  spotifyHint: $('#spotifyHint'),
  spotifyRedirectUri: $('#spotifyRedirectUri'),
  inpGoogleId: $('#inpGoogleId'),
  inpGoogleSecret: $('#inpGoogleSecret'),
  btnConnectGoogle: $('#btnConnectGoogle'),
  googleStatus: $('#googleStatus'),
  confirmBackdrop: $('#confirmBackdrop'),
  confirmText: $('#confirmText'),
  btnCancelConfirm: $('#btnCancelConfirm'),
  btnAcceptConfirm: $('#btnAcceptConfirm'),
  toasts: $('#toasts'),
};

const state = {
  settings: null,
  health: null,
  thinking: false,
  listening: false,
  speaking: false,
  micOn: false,
  recognition: null,
  recognitionLang: 'es-ES',
  recognitionStartedAt: 0,
  audioCtx: null,
  analyser: null,
  micStream: null,
  audioEl: null,
  playbackCtx: null,
  playbackGain: null,
  playbackSource: null,
  audioFinish: null,
  speechFinish: null,
  levelMode: 'idle',
  smoothLevel: 0,
  pending: null,
  greeted: false,
  voiceMode: 'speech',
  recorder: null,
  recording: false,
  recordChunks: [],
  recordStarted: 0,
  recordTimer: null,
  edgeVoices: [],
  geminiVoices: [],
  voiceWarningShown: false,
  confirmHandler: null,
  screen: {
    active: false,
    stream: null,
    video: null,
    canvas: null,
    timer: null,
  },
  live: {
    active: false,
    ready: false,
    withMic: false,
    ws: null,
    stream: null,
    ctx: null,
    analyser: null,
    processor: null,
    sink: null,
    sources: new Set(),
    nextTime: 0,
    endTimer: null,
    queue: [],
    userEl: null,
    assistantEl: null,
    userText: '',
    assistantText: '',
  },
  sttReady: false,
  conversation: false,
  heard: false,
  vadHintShown: false,
  vad: {
    stream: null,
    ctx: null,
    source: null,
    analyser: null,
    processor: null,
    sink: null,
    sampleRate: 48000,
    captureActive: false,
    capture: [],
    preRoll: [],
    timer: null,
    silenceMs: 900,
    threshold: 0.02,
    noiseFloor: 0.008,
    voiceActive: false,
    lastVoiceAt: 0,
    speechStartedAt: 0,
    aboveCount: 0,
    recordStartedAt: 0,
    utteranceMs: 0,
    busy: false,
    resumeTimer: null,
  },
};

/* --------------------------------------------------------------------------
   Utilidades
   -------------------------------------------------------------------------- */

function toast(message, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`.trim();
  el.textContent = message;
  els.toasts.appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity .3s, transform .3s';
    el.style.opacity = '0';
    el.style.transform = 'translateY(8px)';
    setTimeout(() => el.remove(), 320);
  }, 4200);
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || data.error || `Error ${res.status}`);
  return data;
}

/* --------------------------------------------------------------------------
   Estado visual
   -------------------------------------------------------------------------- */

const STATE_LABELS = {
  idle: 'Lista para escucharte',
  listening: 'Escuchando…',
  thinking: 'Pensando…',
  speaking: 'Hablando…',
};

function renderState() {
  let next = 'idle';
  if (state.thinking) next = 'thinking';
  else if (state.speaking) next = 'speaking';
  else if (state.listening || (state.conversation && state.micOn) || (state.live.active && state.micOn)) {
    next = 'listening';
  }

  els.body.dataset.state = next;

  let label = STATE_LABELS[next];
  if (next === 'listening') {
    if (state.live.active) {
      label = state.live.withMic
        ? state.heard
          ? 'Te escucho…'
          : 'Gemini Live · escuchando'
        : 'Gemini Live · conectado';
    } else {
      label = state.heard ? 'Te escucho…' : 'Escuchando…';
    }
  } else if (next === 'idle' && state.micOn) {
    label = 'Escuchando…';
  }

  els.stateText.textContent = label;

  els.micBtn.setAttribute('aria-pressed', String(state.micOn));
  els.micBtn.setAttribute('aria-label', state.micOn ? 'Detener micrófono' : 'Activar micrófono');
}

function voiceSummary(settings) {
  if (settings.aiProvider === 'gemini-live') {
    return {
      on: Boolean(settings.hasAI?.['gemini-live']),
      label: `Live · ${settings.geminiVoice || 'Kore'}`,
    };
  }

  const provider = settings.ttsProvider || 'auto';
  if (provider === 'browser') return { on: false, label: 'Voz del navegador' };
  if (provider === 'edge') return { on: true, label: 'Edge · gratis' };
  if (provider === 'gemini') {
    return {
      on: Boolean(settings.hasGeminiKey),
      label: `Gemini · ${settings.geminiVoice || 'Kore'}`,
    };
  }
  if (provider === 'eleven') {
    return settings.hasElevenLabs ? { on: true, label: 'ElevenLabs' } : { on: true, label: 'Edge · gratis' };
  }
  return settings.hasElevenLabs ? { on: true, label: 'ElevenLabs' } : { on: true, label: 'Edge · gratis' };
}

function renderPills() {
  const s = state.settings;
  if (!s) return;

  const meta = AI_META[s.aiProvider] || AI_META.openai;
  els.pillBrain.classList.toggle('on', Boolean(s.aiHasKey));
  $('.pill-label', els.pillBrain).textContent = s.aiHasKey
    ? `${meta.short} · ${s.aiModel || meta.models[0]}`
    : 'Modo local';

  const voice = voiceSummary(s);
  els.pillVoice.classList.toggle('on', voice.on);
  $('.pill-label', els.pillVoice).textContent = voice.label;
}

const AI_META = {
  openai: {
    label: 'OpenAI',
    short: 'OpenAI',
    keyLabel: 'OpenAI API Key',
    placeholder: 'sk-…',
    link: 'https://platform.openai.com/api-keys',
    linkText: 'Obtener una clave de OpenAI ↗',
    hint: 'GPT-4o, GPT-5… EV ajusta solo los parámetros de cada modelo.',
    models: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1', 'gpt-5', 'gpt-5-mini', 'o4-mini'],
  },
  gemini: {
    label: 'Gemini',
    short: 'Gemini',
    keyLabel: 'Google AI Studio API Key',
    placeholder: 'AIza…',
    link: 'https://aistudio.google.com/apikey',
    linkText: 'Obtener una clave de Gemini ↗',
    hint: 'Gemini tiene nivel gratuito y entiende muy bien el español.',
    models: ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.0-flash', 'gemini-2.5-flash-lite'],
  },
  'gemini-live': {
    label: 'Gemini Live',
    short: 'Live',
    keyLabel: 'Google AI Studio API Key',
    placeholder: 'AIza…',
    link: 'https://aistudio.google.com/apikey',
    linkText: 'Obtener una clave de Gemini ↗',
    hint: 'Chat y voz en tiempo real con gemini-3.8-live. Usa tu clave de Gemini.',
    models: [
      'gemini-3.8-live',
      'gemini-3.8-live-extended-thinking',
      'gemini-3.1-flash-live-preview',
    ],
  },
  anthropic: {
    label: 'Claude',
    short: 'Claude',
    keyLabel: 'Anthropic API Key',
    placeholder: 'sk-ant-…',
    link: 'https://console.anthropic.com/settings/keys',
    linkText: 'Obtener una clave de Claude ↗',
    hint: 'Claude es muy natural conversando y sigue bien las instrucciones.',
    models: ['claude-sonnet-4-5', 'claude-haiku-4-5', 'claude-opus-4-1'],
  },
  compatible: {
    label: 'el proveedor compatible',
    short: 'API',
    keyLabel: 'API Key',
    placeholder: 'Tu clave',
    link: 'https://openrouter.ai/keys',
    linkText: 'Ver claves de OpenRouter ↗',
    hint: 'OpenRouter, Groq, DeepSeek, Mistral, Ollama… cualquier API compatible con OpenAI.',
    models: ['gpt-4o-mini', 'openai/gpt-4o-mini', 'llama-3.3-70b-versatile', 'deepseek-chat', 'mistral-large-latest'],
  },
};

/* --------------------------------------------------------------------------
   Nivel de audio (animación del orbe)
   -------------------------------------------------------------------------- */

function levelLoop() {
  let level = 0;

  if (state.levelMode === 'mic' && state.analyser) {
    const data = new Uint8Array(state.analyser.frequencyBinCount);
    state.analyser.getByteTimeDomainData(data);
    let sum = 0;
    for (let i = 0; i < data.length; i += 1) {
      const v = (data[i] - 128) / 128;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / data.length);
    level = Math.min(1, rms * 3.6);
  } else if (state.levelMode === 'tts') {
    const t = performance.now() / 110;
    level = 0.28 + Math.abs(Math.sin(t)) * 0.4 + Math.random() * 0.2;
  }

  state.smoothLevel = state.smoothLevel * 0.72 + level * 0.28;
  document.documentElement.style.setProperty('--level', state.smoothLevel.toFixed(3));
  requestAnimationFrame(levelLoop);
}

async function buildAnalyser(stream) {
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  if (ctx.state === 'suspended') await ctx.resume().catch(() => {});
  const source = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 512;
  analyser.smoothingTimeConstant = 0.72;
  source.connect(analyser);
  state.micStream = stream;
  state.audioCtx = ctx;
  state.analyser = analyser;
  state.levelMode = 'mic';
}

async function startMicMeter() {
  if (state.analyser) return true;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    await buildAnalyser(stream);
    return true;
  } catch {
    return false;
  }
}

function stopMicMeter() {
  if (state.levelMode === 'mic') state.levelMode = 'idle';
  if (state.micStream) {
    state.micStream.getTracks().forEach((t) => t.stop());
    state.micStream = null;
  }
  if (state.audioCtx) {
    state.audioCtx.close().catch(() => {});
    state.audioCtx = null;
  }
  state.analyser = null;
}

/* --------------------------------------------------------------------------
   Reconocimiento de voz
   -------------------------------------------------------------------------- */

function initRecognition() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    state.voiceMode = 'record';
    els.micBtn.title = 'Dictado por grabación con OpenAI';
    return;
  }

  const rec = new SR();
  rec.lang = state.settings?.language || 'es-ES';
  rec.interimResults = true;
  rec.continuous = false;
  rec.maxAlternatives = 1;

  rec.onstart = () => {
    state.listening = true;
    state.recognitionStartedAt = Date.now();
    renderState();
  };

  rec.onresult = (event) => {
    let interim = '';
    let final = '';

    for (let i = event.resultIndex; i < event.results.length; i += 1) {
      const result = event.results[i];
      const text = result[0].transcript;
      if (result.isFinal) final += text;
      else interim += text;
    }

    if (interim) els.live.textContent = interim;
    if (final) {
      els.live.textContent = '';
      const text = final.trim();
      if (text) {
        stopListening({ keepIntent: true, silent: true });
        send(text);
      }
    }
  };

  rec.onerror = (event) => {
    const code = event.error;
    if (code === 'not-allowed' || code === 'service-not-allowed') {
      toast('Necesito permiso para usar el micrófono. Actívalo en el candado de la barra de direcciones.', 'bad');
      state.micOn = false;
      stopListening({ silent: true });
    } else if (code === 'no-speech') {
      /* silencio, reintentamos */
    } else if (code === 'network' || code === 'service-not-allowed') {
      switchToRecording();
    } else if (code === 'audio-capture') {
      toast('No encuentro ningún micrófono conectado.', 'bad');
    }
  };

  rec.onend = () => {
    state.listening = false;
    renderState();

    if (
      state.micOn &&
      !state.thinking &&
      !state.speaking &&
      state.settings?.continuousListening &&
      Date.now() - state.recognitionStartedAt > 400
    ) {
      setTimeout(() => {
        if (state.micOn && !state.thinking && !state.speaking && !state.listening) startListening(true);
      }, 400);
    }
  };

  state.recognition = rec;
}

async function startListening(silent = false) {
  if (!state.recognition) {
    toast('Este navegador no permite dictado. Usa Chrome o Edge, o escribe el comando.', 'bad');
    state.micOn = false;
    renderState();
    return;
  }
  if (state.thinking) return;

  await startMicMeter();
  try {
    state.recognition.lang = state.settings?.language || 'es-ES';
    state.recognition.start();
    state.micOn = true;
    if (!silent) beep(720, 0.05);
  } catch (err) {
    // "already started" es inocuo
    if (!String(err.message || '').includes('started')) {
      toast('No pude activar el micrófono. Inténtalo otra vez.', 'bad');
      state.micOn = false;
    }
  }
  renderState();
}

function stopListening({ keepIntent = false, silent = false } = {}) {
  state.listening = false;
  if (!keepIntent) state.micOn = false;
  try {
    state.recognition?.stop();
  } catch {}
  stopMicMeter();
  els.live.textContent = '';
  if (!silent) beep(480, 0.04);
  renderState();
}

function toggleMic() {
  if (isLiveMode()) {
    if (state.live.active) {
      if (!state.live.stream) {
        startLive({ withMic: true });
        return;
      }
      stopLive();
      return;
    }
    startLive({ withMic: true });
    return;
  }

  if (state.thinking && !state.conversation) {
    toast('Espera a que termine lo que estoy haciendo.');
    return;
  }
  if (state.conversation) {
    stopConversation();
    return;
  }
  if (state.micOn) {
    stopInput();
    return;
  }
  startConversation();
}

async function startConversation() {
  // Modo clásico: pulsar para hablar, pulsar para enviar.
  if (state.settings?.conversationMode === false) {
    state.micOn = true;
    startInput();
    return;
  }

  if (canUseVad()) {
    state.conversation = true;
    state.micOn = true;
    await startVad();
    return;
  }

  // Sin grabación disponible: dictado continuo del navegador.
  if (state.recognition) {
    state.conversation = true;
    state.micOn = true;
    startListening();
    toast('Conversación continua con el dictado del navegador. Haz una pausa al terminar de hablar.');
    return;
  }

  // Último recurso: grabar y enviar a mano.
  state.conversation = false;
  state.micOn = true;
  startRecording();
}

function stopConversation() {
  state.conversation = false;
  state.heard = false;
  stopVad();
  stopPlayback();
  stopListening({ silent: true });
  if (state.recorder) stopRecording();
  state.micOn = false;
  renderState();
}

function startInput() {
  if (state.voiceMode === 'record') startRecording();
  else startListening();
}

function stopInput() {
  if (state.recorder || state.recording) stopRecording();
  else stopListening();
}

/* Respaldo: grabar audio y transcribirlo con Whisper (útil en Brave o si el
   dictado del navegador no está disponible). */
function switchToRecording() {
  if (state.voiceMode === 'record') return;
  state.voiceMode = 'record';
  state.listening = false;
  stopMicMeter();
  renderState();

  if (!(state.sttReady || state.settings?.hasOpenAI)) {
    state.micOn = false;
    renderState();
    toast('Este navegador no tiene dictado y el motor local no está listo. Revisa la consola de EV.', 'bad');
    return;
  }

  toast('El dictado del navegador no está disponible. Cambio a grabación con Whisper.', 'bad');
  startRecording();
}

function pickMime() {
  if (!window.MediaRecorder) return '';
  const options = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
  return options.find((type) => MediaRecorder.isTypeSupported(type)) || '';
}

async function startRecording() {
  if (state.recording) return;
  if (!window.MediaRecorder) {
    toast('Este navegador no puede grabar audio. Prueba con Chrome o Edge.', 'bad');
    state.micOn = false;
    renderState();
    return;
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mime = pickMime();
    const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);

    state.recordChunks = [];
    state.recordStarted = Date.now();
    recorder.ondataavailable = (event) => {
      if (event.data && event.data.size) state.recordChunks.push(event.data);
    };
    recorder.onstop = handleRecordingStop;
    recorder.start(200);

    state.recorder = recorder;
    state.recording = true;
    state.listening = true;
    state.micOn = true;

    await buildAnalyser(stream);
    state.recordTimer = setTimeout(() => stopRecording(), 60000);

    beep(760, 0.06);
    els.live.textContent = 'Grabando… pulsa otra vez para enviar';
    renderState();
  } catch {
    state.recording = false;
    state.micOn = false;
    state.listening = false;
    renderState();
    toast('No pude acceder al micrófono. Revisa los permisos del navegador.', 'bad');
  }
}

function stopRecording() {
  if (!state.recorder) return;
  clearTimeout(state.recordTimer);
  state.recordTimer = null;

  try {
    state.recorder.stop();
  } catch {}
  state.recorder = null;
  state.recording = false;
  state.listening = false;
  state.micOn = false;
  stopMicMeter();
  state.levelMode = 'idle';
  beep(520, 0.05);
  renderState();
}

function bufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/** Reduce la frecuencia de muestreo con interpolación lineal (48k -> 16k). */
function downsampleBuffer(samples, fromRate, toRate) {
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

/** Codifica PCM mono en un WAV de 16 bits. */
function encodeWav(samples, sampleRate) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);

  const writeString = (offset, text) => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  };

  writeString(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(36, 'data');
  view.setUint32(40, samples.length * 2, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i += 1) {
    const value = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, value < 0 ? value * 0x8000 : value * 0x7fff, true);
    offset += 2;
  }

  return buffer;
}

async function handleRecordingStop() {
  const chunks = state.recordChunks || [];
  state.recordChunks = [];
  const duration = Date.now() - state.recordStarted;
  state.recordStarted = 0;
  els.live.textContent = '';

  const blob = new Blob(chunks, { type: chunks[0]?.type || 'audio/webm' });
  if (!blob.size || duration < 500) {
    renderState();
    toast('No te escuché. Inténtalo otra vez.');
    return;
  }

  state.thinking = true;
  renderState();
  els.live.textContent = 'Transcribiendo…';

  try {
    const base64 = bufferToBase64(await blob.arrayBuffer());
    const data = await api('/api/transcribe', {
      method: 'POST',
      body: JSON.stringify({ audio: base64, mime: blob.type }),
    });
    state.thinking = false;
    els.live.textContent = '';
    renderState();

    if (data.text) send(data.text);
    else toast('No entendí el audio. Prueba otra vez.');
  } catch (err) {
    state.thinking = false;
    els.live.textContent = '';
    renderState();
    toast(err.message || 'No pude transcribir el audio.', 'bad');
  }
}

/* --------------------------------------------------------------------------
   Conversación continua (detección de voz + Whisper)
   -------------------------------------------------------------------------- */

function canUseVad() {
  return Boolean(
    (state.settings?.hasOpenAI || state.sttReady) &&
      window.MediaRecorder &&
      navigator.mediaDevices?.getUserMedia &&
      (window.AudioContext || window.webkitAudioContext)
  );
}

function vadRms() {
  const analyser = state.vad.analyser;
  if (!analyser) return 0;
  const data = new Uint8Array(analyser.fftSize);
  analyser.getByteTimeDomainData(data);
  let sum = 0;
  for (let i = 0; i < data.length; i += 1) {
    const value = (data[i] - 128) / 128;
    sum += value * value;
  }
  return Math.sqrt(sum / data.length);
}

async function calibrateVad() {
  const samples = [];
  for (let i = 0; i < 8; i += 1) {
    samples.push(vadRms());
    await new Promise((resolve) => setTimeout(resolve, 60));
  }
  samples.sort((a, b) => a - b);
  const median = samples[Math.floor(samples.length / 2)] || 0.006;
  const noise = Math.max(0.004, median);
  const sensitivity = Number(state.settings?.vadSensitivity) || 1;

  state.vad.noiseFloor = noise;
  state.vad.threshold = Math.min(0.16, Math.max(0.012, (noise * 3.2) / sensitivity));
}

async function startVad() {
  stopVad();

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') await ctx.resume().catch(() => {});

    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.35;
    source.connect(analyser);

    // Captura PCM continua: el buffer circular guarda el último medio segundo
    // para no perder el inicio de la frase.
    const processor = ctx.createScriptProcessor(4096, 1, 1);
    const sink = ctx.createGain();
    sink.gain.value = 0;
    source.connect(processor);
    processor.connect(sink);
    sink.connect(ctx.destination);

    processor.onaudioprocess = (event) => {
      const input = event.inputBuffer.getChannelData(0);
      const chunk = new Float32Array(input.length);
      chunk.set(input);
      const vad = state.vad;
      if (vad.captureActive) {
        vad.capture.push(chunk);
      } else {
        vad.preRoll.push(chunk);
        if (vad.preRoll.length > 8) vad.preRoll.shift();
      }
    };

    state.vad.stream = stream;
    state.vad.ctx = ctx;
    state.vad.source = source;
    state.vad.analyser = analyser;
    state.vad.processor = processor;
    state.vad.sink = sink;
    state.vad.sampleRate = ctx.sampleRate;
    state.vad.capture = [];
    state.vad.preRoll = [];
    state.vad.captureActive = false;
    state.vad.silenceMs = Number(state.settings?.vadSilenceMs) || 900;
    state.vad.busy = false;

    state.analyser = analyser;
    state.levelMode = 'mic';

    await calibrateVad();
    if (!state.conversation) {
      stopVad();
      return;
    }

    state.vad.timer = setInterval(vadTick, 70);
    startVadRecorder();
    renderState();

    if (!state.vadHintShown) {
      state.vadHintShown = true;
      toast('Te escucho. Habla normal y haz una pausa al terminar.', 'good');
    }
  } catch (err) {
    state.conversation = false;
    state.micOn = false;
    stopVad();
    renderState();
    toast('No pude abrir el micrófono para la conversación continua.', 'bad');
  }
}

function vadTick() {
  const vad = state.vad;
  if (!vad.analyser || vad.busy) return;
  if (state.thinking || state.speaking) return;

  const rms = vadRms();
  const now = performance.now();
  const threshold = vad.threshold;

  if (!vad.voiceActive) {
    if (rms > threshold) {
      vad.aboveCount += 1;
      if (vad.aboveCount >= 3) {
        vad.voiceActive = true;
        vad.speechStartedAt = now;
        vad.lastVoiceAt = now;
        vad.aboveCount = 0;
        vad.recordStartedAt = now;
        // Empezar a guardar: incluye el pre-roll para no cortar la primera sílaba.
        vad.capture = vad.preRoll.slice();
        vad.preRoll = [];
        vad.captureActive = true;
        state.heard = true;
        renderState();
      }
    } else {
      vad.aboveCount = 0;
    }
    return;
  }

  if (rms > threshold * 0.8) vad.lastVoiceAt = now;

  const silence = now - vad.lastVoiceAt;
  const duration = now - vad.speechStartedAt;

  if ((silence >= vad.silenceMs && duration >= 500) || duration >= 25000) {
    finishVadUtterance();
  }
}

function startVadRecorder() {
  const vad = state.vad;
  if (!vad.stream || !state.conversation) return;

  vad.capture = [];
  vad.preRoll = [];
  vad.captureActive = false;
  vad.voiceActive = false;
  vad.aboveCount = 0;
  vad.utteranceMs = 0;
  vad.busy = false;
  vad.recordStartedAt = 0;
}

function finishVadUtterance() {
  const vad = state.vad;
  if (!vad.captureActive) return;

  vad.captureActive = false;
  vad.voiceActive = false;
  vad.utteranceMs = performance.now() - vad.recordStartedAt;
  vad.busy = true;
  state.heard = false;
  renderState();

  handleVadStop();
}

const NOISE_PHRASES = [
  /gracias por ver/i,
  /suscr[ií]bete/i,
  /subt[ií]tulos/i,
  /amara\.org/i,
  /hasta la pr[oó]xima/i,
  /^\[.*\]$/,
  /^\(.*\)$/,
  /^[.,!?…\s]+$/,
];

function isNoisePhrase(text) {
  const value = String(text || '').trim();
  if (value.length < 2) return true;
  if (/^(mmm+|eh+|ah+|uh+)[.!?]*$/i.test(value)) return true;
  return NOISE_PHRASES.some((re) => re.test(value));
}

async function handleVadStop() {
  const vad = state.vad;
  const parts = vad.capture.slice();
  vad.capture = [];
  vad.busy = true;

  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const elapsed = vad.utteranceMs;

  if (!total || parts.length === 0 || elapsed < 400 || total < vad.sampleRate * 0.3) {
    vad.busy = false;
    resumeVad();
    return;
  }

  const merged = new Float32Array(total);
  let offset = 0;
  for (const part of parts) {
    merged.set(part, offset);
    offset += part.length;
  }

  const pcm = downsampleBuffer(merged, vad.sampleRate, 16000);
  const wav = encodeWav(pcm, 16000);

  state.thinking = true;
  renderState();

  try {
    const data = await api('/api/transcribe', {
      method: 'POST',
      body: JSON.stringify({
        audio: bufferToBase64(wav),
        mime: 'audio/wav',
        language: state.settings?.language,
      }),
    });

    state.thinking = false;
    renderState();

    const text = String(data.text || '').trim();
    if (!text || isNoisePhrase(text)) {
      vad.busy = false;
      resumeVad();
      return;
    }

    await send(text);
  } catch (err) {
    state.thinking = false;
    vad.busy = false;
    renderState();
    toast(err.message || 'No pude transcribir lo que dijiste.', 'bad');
    resumeVad();
  }
}

function resumeVad() {
  const vad = state.vad;
  if (!state.conversation || !vad.analyser) return;

  state.heard = false;
  if (vad.captureActive) return;

  vad.busy = false;
  clearTimeout(vad.resumeTimer);
  // Pequeña espera para no capturar la cola de la voz de EV.
  vad.resumeTimer = setTimeout(() => {
    if (!state.conversation || state.thinking || state.speaking) return;
    if (!vad.captureActive) startVadRecorder();
  }, 350);

  renderState();
}

function pauseVad() {
  const vad = state.vad;

  vad.captureActive = false;
  vad.capture = [];
  vad.preRoll = [];
  vad.voiceActive = false;
  vad.aboveCount = 0;
  vad.busy = true;
  state.heard = false;
  renderState();
}

function stopVad() {
  const vad = state.vad;

  if (vad.timer) {
    clearInterval(vad.timer);
    vad.timer = null;
  }
  clearTimeout(vad.resumeTimer);
  vad.resumeTimer = null;

  if (vad.processor) {
    vad.processor.onaudioprocess = null;
    try {
      vad.processor.disconnect();
    } catch {}
    vad.processor = null;
  }

  if (vad.sink) {
    try {
      vad.sink.disconnect();
    } catch {}
    vad.sink = null;
  }

  vad.capture = [];
  vad.preRoll = [];
  vad.captureActive = false;

  if (vad.source) {
    try {
      vad.source.disconnect();
    } catch {}
    vad.source = null;
  }

  if (vad.analyser) {
    try {
      vad.analyser.disconnect();
    } catch {}
    vad.analyser = null;
  }

  if (vad.ctx) {
    vad.ctx.close().catch(() => {});
    vad.ctx = null;
  }

  if (vad.stream) {
    vad.stream.getTracks().forEach((track) => track.stop());
    vad.stream = null;
  }

  vad.voiceActive = false;
  vad.busy = false;
  state.analyser = null;
  if (state.levelMode === 'mic') state.levelMode = 'idle';
}

/* --------------------------------------------------------------------------
   Gemini Live (chat + voz en tiempo real)
   -------------------------------------------------------------------------- */

function isLiveMode() {
  return state.settings?.aiProvider === 'gemini-live';
}

function liveSocketUrl() {
  const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${protocol}://${location.host}/api/live`;
}

function sendLive(payload) {
  const ws = state.live.ws;
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
}

function sendLiveAudio(int16) {
  const ws = state.live.ws;
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(int16.buffer);
}

function floatToPcm16(input) {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i += 1) {
    const value = Math.max(-1, Math.min(1, input[i]));
    out[i] = value < 0 ? value * 0x8000 : value * 0x7fff;
  }
  return out;
}

async function startLive({ withMic = true } = {}) {
  if (state.live.active) {
    if (withMic && !state.live.stream) {
      state.live.withMic = true;
      await startLiveMic();
    }
    return;
  }

  state.live.active = true;
  state.live.ready = false;
  state.live.withMic = withMic;
  state.live.userEl = null;
  state.live.assistantEl = null;
  state.live.userText = '';
  state.live.assistantText = '';
  state.live.nextTime = 0;
  state.live.queue = [];

  state.micOn = withMic || state.live.withMic;
  state.thinking = true;
  renderState();

  const ws = new WebSocket(liveSocketUrl());
  state.live.ws = ws;

  ws.onmessage = (event) => {
    handleLiveMessage(event).catch(() => {});
  };
  ws.onerror = () => {
    toast('No pude conectar con Gemini Live.', 'bad');
    stopLive();
  };
  ws.onclose = () => {
    if (state.live.active) {
      toast('La sesión de Gemini Live se cerró.', 'bad');
      stopLive();
    }
  };
}

async function handleLiveMessage(event) {
  let message;
  try {
    message = JSON.parse(event.data);
  } catch {
    return;
  }

  if (message.type === 'ready') {
    state.live.ready = true;
    state.thinking = false;
    renderState();

    if (state.live.withMic) await startLiveMic();
    for (const text of state.live.queue.splice(0)) sendLive({ type: 'text', text });
    return;
  }

  if (message.type === 'audio') {
    playLiveAudio(message);
    return;
  }

  if (message.type === 'userText') {
    state.thinking = false;
    appendLiveText('user', message.text);
    return;
  }

  if (message.type === 'assistantText') {
    state.thinking = false;
    appendLiveText('assistant', message.text);
    return;
  }

  if (message.type === 'tool') {
    appendLiveAction(message);
    return;
  }

  if (message.type === 'interrupted') {
    stopLivePlayback();
    return;
  }

  if (message.type === 'turnComplete') {
    finalizeLiveTurn();
    return;
  }

  if (message.type === 'confirm') {
    showConfirm(message, (approved) => {
      sendLive({ type: 'confirmResult', id: message.id, approved });
    });
    return;
  }

  if (message.type === 'stopScreen') {
    stopScreenShare(false);
    return;
  }

  if (message.type === 'error') {
    toast(message.message || 'Error de Gemini Live.', 'bad');
    stopLive();
  }
}

async function startLiveMic() {
  if (state.live.stream) return;

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    const ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
    if (ctx.state === 'suspended') await ctx.resume().catch(() => {});

    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.4;
    source.connect(analyser);

    const processor = ctx.createScriptProcessor(2048, 1, 1);
    const sink = ctx.createGain();
    sink.gain.value = 0;
    source.connect(processor);
    processor.connect(sink);
    sink.connect(ctx.destination);

    let loudFrames = 0;
    let speaking = false;
    let lastVoice = 0;

    processor.onaudioprocess = (event) => {
      if (!state.live.active) return;

      const input = event.inputBuffer.getChannelData(0);
      const pcmFloat =
        ctx.sampleRate === 16000 ? input : downsampleBuffer(input, ctx.sampleRate, 16000);
      sendLiveAudio(floatToPcm16(pcmFloat));

      let sum = 0;
      for (let i = 0; i < input.length; i += 1) sum += input[i] * input[i];
      const rms = Math.sqrt(sum / input.length);
      const now = performance.now();

      if (!speaking) {
        if (rms > 0.02) {
          loudFrames += 1;
          if (loudFrames >= 2) {
            speaking = true;
            lastVoice = now;
            sendLive({ type: 'activityStart' });
            state.heard = true;
            renderState();
          }
        } else {
          loudFrames = 0;
        }
      } else {
        if (rms > 0.015) lastVoice = now;
        if (now - lastVoice > 900) {
          speaking = false;
          loudFrames = 0;
          sendLive({ type: 'activityEnd' });
          state.heard = false;
          renderState();
        }
      }
    };

    state.live.stream = stream;
    state.live.ctx = ctx;
    state.live.processor = processor;
    state.live.sink = sink;
    state.live.analyser = analyser;
    state.analyser = analyser;
    state.levelMode = 'mic';
    state.micOn = true;
    renderState();
  } catch {
    toast('No pude abrir el micrófono para Gemini Live.', 'bad');
    state.micOn = false;
    renderState();
  }
}

function stopLiveMic() {
  if (state.live.processor) {
    state.live.processor.onaudioprocess = null;
    try {
      state.live.processor.disconnect();
    } catch {}
    state.live.processor = null;
  }

  if (state.live.sink) {
    try {
      state.live.sink.disconnect();
    } catch {}
    state.live.sink = null;
  }

  if (state.live.analyser) {
    try {
      state.live.analyser.disconnect();
    } catch {}
    state.live.analyser = null;
  }

  if (state.live.stream) {
    state.live.stream.getTracks().forEach((track) => track.stop());
    state.live.stream = null;
  }

  if (state.live.ctx) {
    state.live.ctx.close().catch(() => {});
    state.live.ctx = null;
  }

  state.analyser = null;
  if (state.levelMode === 'mic') state.levelMode = 'idle';
}

function playLiveAudio(message) {
  const ctx = getPlaybackContext();
  if (!ctx) return;
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});

  const rate = Number((String(message.mimeType || '').match(/rate=(\d+)/) || [])[1] || 24000);
  const binary = atob(message.data);
  const bytes = new Uint8Array(binary.length);

  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);

  const samples = new Float32Array(Math.floor(bytes.length / 2));
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < samples.length; i += 1) {
    samples[i] = view.getInt16(i * 2, true) / 32768;
  }

  const buffer = ctx.createBuffer(1, Math.max(1, samples.length), rate);
  buffer.copyToChannel(samples, 0);

  const source = ctx.createBufferSource();
  source.buffer = buffer;

  if (state.playbackGain) {
    state.playbackGain.gain.value = Number(state.settings?.voiceVolume ?? 1);
  }
  source.connect(state.playbackGain || ctx.destination);

  const start = Math.max(ctx.currentTime + 0.03, state.live.nextTime || 0);
  source.start(start);
  state.live.nextTime = start + buffer.duration;
  state.live.sources.add(source);
  source.onended = () => state.live.sources.delete(source);

  state.speaking = true;
  state.levelMode = 'tts';
  renderState();

  clearTimeout(state.live.endTimer);
  const remaining = Math.max(0, (state.live.nextTime - ctx.currentTime) * 1000);
  state.live.endTimer = setTimeout(() => {
    if (state.live.sources.size === 0) {
      state.speaking = false;
      if (state.live.active) state.levelMode = 'mic';
      renderState();
    }
  }, remaining + 200);
}

function stopLivePlayback() {
  for (const source of state.live.sources) {
    try {
      source.stop();
    } catch {}
  }

  state.live.sources.clear();
  state.live.nextTime = 0;
  clearTimeout(state.live.endTimer);
  state.speaking = false;
  if (state.live.active) state.levelMode = 'mic';
  renderState();
}

function ensureLiveBubble(role) {
  const key = role === 'user' ? 'userEl' : 'assistantEl';

  if (!state.live[key]) {
    state.live[key] = addMessage(role, '');
  }
  return state.live[key];
}

function appendLiveText(role, text) {
  if (!text) return;

  const wrap = ensureLiveBubble(role);
  const paragraph = wrap.querySelector('.msg-text');

  if (role === 'user') {
    state.live.userText += text;
    if (paragraph) paragraph.textContent = state.live.userText;
  } else {
    state.live.assistantText += text;
    if (paragraph) paragraph.textContent = state.live.assistantText;
  }

  scrollFeed();
}

function appendLiveAction(action) {
  if (!state.live.assistantEl) {
    state.live.assistantEl = addMessage('assistant', state.live.assistantText || '');
  }

  const body = state.live.assistantEl.querySelector('.msg-body');
  if (!body) return;

  let list = body.querySelector('.msg-actions');
  if (!list) {
    list = document.createElement('div');
    list.className = 'msg-actions';
    body.appendChild(list);
  }

  const pill = document.createElement('div');
  pill.className = `action-pill ${action.ok ? '' : 'bad'}`.trim();

  const dot = document.createElement('span');
  dot.className = 'dot';

  const label = document.createElement('span');
  const strong = document.createElement('strong');
  strong.textContent = action.label || action.name;
  label.append(strong, document.createTextNode(` · ${action.summary}`));

  pill.append(dot, label);
  list.appendChild(pill);
  scrollFeed();
}

function finalizeLiveTurn() {
  state.thinking = false;

  if (state.live.assistantEl) {
    const paragraph = state.live.assistantEl.querySelector('.msg-text');
    if (paragraph) paragraph.textContent = state.live.assistantText.trim();
  }

  if (state.live.userEl) {
    const paragraph = state.live.userEl.querySelector('.msg-text');
    if (paragraph) paragraph.textContent = state.live.userText.trim();
  }

  state.live.userEl = null;
  state.live.assistantEl = null;
  state.live.userText = '';
  state.live.assistantText = '';
  state.heard = false;
  renderState();
}

function stopLive() {
  state.live.active = false;
  state.live.ready = false;
  state.live.queue = [];

  const ws = state.live.ws;
  if (ws) {
    try {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'stop' }));
      ws.close();
    } catch {}
  }
  state.live.ws = null;

  stopScreenShare(false);
  stopLiveMic();
  stopLivePlayback();
  finalizeLiveTurn();

  state.thinking = false;
  state.speaking = false;
  state.heard = false;
  state.micOn = false;
  state.levelMode = 'idle';
  state.analyser = null;
  renderState();
}

/* --------------------------------------------------------------------------
   Compartir pantalla con Gemini Live
   -------------------------------------------------------------------------- */

async function toggleScreenShare() {
  if (!isLiveMode()) {
    toast('Compartir pantalla funciona con Gemini Live. Elige ese proveedor en Ajustes.', 'bad');
    return;
  }

  if (state.screen.active) {
    stopScreenShare(true);
    return;
  }

  if (!state.live.active) {
    await startLive({ withMic: false });
  }

  for (let attempt = 0; attempt < 30 && !state.live.ready; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  if (!state.live.ready) {
    toast('La sesión de Gemini Live aún no está lista.', 'bad');
    return;
  }

  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: 5 },
      audio: false,
    });

    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    await video.play().catch(() => {});

    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');

    const timer = setInterval(() => {
      if (!state.live.active || !state.live.ws) return;

      const width = 1280;
      const height = video.videoHeight
        ? Math.round((video.videoHeight / video.videoWidth) * width)
        : 720;

      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }

      try {
        context.drawImage(video, 0, 0, width, height);
      } catch {
        return;
      }

      const data = canvas.toDataURL('image/jpeg', 0.68).split(',')[1];
      if (data) sendLive({ type: 'screen', data });
    }, 1000);

    const track = stream.getVideoTracks()[0];
    if (track) track.addEventListener('ended', () => stopScreenShare(false));

    state.screen = { active: true, stream, video, canvas, timer };
    els.btnScreen.classList.add('active');
    toast('Compartiendo pantalla: Gemini ya puede verla.', 'good');
  } catch {
    toast('No se compartió la pantalla (permiso cancelado o bloqueado).', 'bad');
  }
}

function stopScreenShare(notify = false) {
  if (state.screen.timer) clearInterval(state.screen.timer);
  if (state.screen.stream) {
    state.screen.stream.getTracks().forEach((track) => track.stop());
  }

  state.screen = { active: false, stream: null, video: null, canvas: null, timer: null };
  if (els.btnScreen) els.btnScreen.classList.remove('active');

  if (notify) toast('Pantalla dejada de compartir.');
}

/* --------------------------------------------------------------------------
   Voz de EV
   -------------------------------------------------------------------------- */

function beep(freq, duration) {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    gain.gain.value = 0.03;
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + duration);
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + duration);
    osc.onended = () => ctx.close().catch(() => {});
  } catch {}
}

function stopPlayback() {
  if (state.audioEl) {
    try {
      state.audioEl.pause();
    } catch {}
    state.audioEl = null;
  }

  if (state.playbackSource) {
    try {
      state.playbackSource.stop();
    } catch {}
    state.playbackSource = null;
  }

  if ('speechSynthesis' in window) window.speechSynthesis.cancel();

  // Resolver las promesas pendientes para que la conversación no se quede colgada.
  const finishAudio = state.audioFinish;
  const finishSpeech = state.speechFinish;
  state.audioFinish = null;
  state.speechFinish = null;

  if (state.levelMode === 'tts') state.levelMode = 'idle';
  state.speaking = false;
  renderState();

  if (finishAudio) finishAudio();
  if (finishSpeech) finishSpeech();
}

/* Contexto de audio persistente: mantiene el dispositivo "caliente" entre frases. */
function getPlaybackContext() {
  if (!state.playbackCtx) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    state.playbackCtx = new Ctx();
    state.playbackGain = state.playbackCtx.createGain();
    state.playbackGain.connect(state.playbackCtx.destination);
  }
  return state.playbackCtx;
}

function browserSpeak(text) {
  if (!('speechSynthesis' in window)) return Promise.resolve();

  return new Promise((resolve) => {
    const utter = new SpeechSynthesisUtterance(text);
    const voices = window.speechSynthesis.getVoices();
    const spanish =
      voices.find((v) => /^es(-|_)/i.test(v.lang) && /google|m[oó]nica|paulina|helena|sabina|laura|jorge|diego/i.test(v.name)) ||
      voices.find((v) => /^es/i.test(v.lang));
    if (spanish) utter.voice = spanish;
    utter.lang = state.settings?.language || 'es-ES';
    utter.rate = Number(state.settings?.speechRate) || 1;
    utter.volume = Number(state.settings?.voiceVolume ?? 0.9);
    utter.onstart = () => {
      state.speaking = true;
      state.levelMode = 'tts';
      renderState();
    };
    const finish = () => {
      if (state.speechFinish === finish) state.speechFinish = null;
      if (state.levelMode === 'tts') state.levelMode = 'idle';
      state.speaking = false;
      renderState();
      resolve();
    };
    state.speechFinish = finish;
    utter.onend = finish;
    utter.onerror = finish;
    window.speechSynthesis.speak(utter);
  });
}

async function playAudioBlob(blob) {
  const ctx = getPlaybackContext();

  if (!ctx) return playAudioElement(blob);

  if (ctx.state === 'suspended') {
    await ctx.resume().catch(() => {});
  }

  let decoded;
  try {
    decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
  } catch {
    return playAudioElement(blob);
  }

  return new Promise((resolve) => {
    // Silencio inicial para que el dispositivo de audio termine de arrancar y no
    // se pierdan las primeras sílabas (el "fade" del principio).
    const padSeconds = Math.max(0, Number(state.settings?.ttsLeadMs ?? 400)) / 1000;
    const padFrames = Math.max(0, Math.ceil(padSeconds * decoded.sampleRate));
    const buffer = ctx.createBuffer(1, decoded.length + padFrames, decoded.sampleRate);
    buffer.copyToChannel(decoded.getChannelData(0), 0, padFrames);

    const source = ctx.createBufferSource();
    source.buffer = buffer;

    if (state.playbackGain) {
      state.playbackGain.gain.value = Number(state.settings?.voiceVolume ?? 1);
    }
    source.connect(state.playbackGain || ctx.destination);

    const finish = () => {
      if (state.audioFinish === finish) state.audioFinish = null;
      if (state.playbackSource === source) state.playbackSource = null;
      if (state.levelMode === 'tts') state.levelMode = 'idle';
      state.speaking = false;
      renderState();
      resolve();
    };

    state.audioFinish = finish;
    state.playbackSource = source;
    source.onended = finish;

    state.speaking = true;
    state.levelMode = 'tts';
    renderState();

    try {
      source.start();
    } catch {
      finish();
    }
  });
}

/* Reserva para navegadores sin Web Audio: reproduce el archivo tal cual. */
function playAudioElement(blob) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    audio.volume = Number(state.settings?.voiceVolume ?? 0.9);
    state.audioEl = audio;

    const finish = () => {
      if (state.audioFinish === finish) state.audioFinish = null;
      URL.revokeObjectURL(url);
      if (state.audioEl === audio) state.audioEl = null;
      if (state.levelMode === 'tts') state.levelMode = 'idle';
      state.speaking = false;
      renderState();
      resolve();
    };
    state.audioFinish = finish;

    audio.onplay = () => {
      state.speaking = true;
      state.levelMode = 'tts';
      renderState();
    };
    audio.onended = finish;
    audio.onerror = finish;

    audio.play().catch(() => {
      toast('El navegador bloqueó la voz. Pulsa la pantalla y vuelve a intentarlo.', 'bad');
      finish();
    });
  });
}

async function speak(text) {
  if (!text || !state.settings?.voiceEnabled) return;
  stopPlayback();

  if ((state.settings.ttsProvider || 'auto') === 'browser') {
    await browserSpeak(text);
    return;
  }

  try {
    const res = await fetch('/api/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });

    if (res.ok) {
      const warning = res.headers.get('x-ev-voice-warning');
      if (warning && !state.voiceWarningShown) {
        state.voiceWarningShown = true;
        let detail = '';
        try {
          detail = decodeURIComponent(warning);
        } catch {}
        toast(`ElevenLabs no está disponible (${detail.slice(0, 90)}). Uso la voz gratis de Edge.`, 'bad');
      }
      const blob = await res.blob();
      await playAudioBlob(blob);
      return;
    }

    const data = await res.json().catch(() => ({}));
    if (res.status !== 501) {
      toast(`Voz: ${data.message || 'no disponible'}. Uso la voz del navegador.`, 'bad');
    }
  } catch {
    toast('No pude conectar con el motor de voz. Uso la voz del navegador.', 'bad');
  }

  await browserSpeak(text);
}

/* --------------------------------------------------------------------------
   Conversación
   -------------------------------------------------------------------------- */

function addMessage(role, text, actions = []) {
  const empty = $('.feed-empty', els.feed);
  if (empty) empty.remove();

  const wrap = document.createElement('div');
  wrap.className = `msg ${role}`;

  if (role === 'assistant') {
    const avatar = document.createElement('div');
    avatar.className = 'msg-avatar';
    avatar.textContent = 'EV';
    wrap.appendChild(avatar);
  }

  const body = document.createElement('div');
  body.className = 'msg-body';

  const p = document.createElement('p');
  p.className = 'msg-text';
  p.textContent = text;
  body.appendChild(p);

  if (actions.length) {
    const list = document.createElement('div');
    list.className = 'msg-actions';
    for (const action of actions) {
      const pill = document.createElement('div');
      pill.className = `action-pill ${action.ok ? '' : 'bad'}`.trim();
      const dot = document.createElement('span');
      dot.className = 'dot';
      const label = document.createElement('span');
      const strong = document.createElement('strong');
      strong.textContent = action.label;
      label.append(strong, document.createTextNode(` · ${action.summary}`));
      pill.append(dot, label);
      list.appendChild(pill);
    }
    body.appendChild(list);
  }

  wrap.appendChild(body);
  els.feed.appendChild(wrap);
  scrollFeed();
  return wrap;
}

function addTyping() {
  const wrap = document.createElement('div');
  wrap.className = 'msg assistant';
  wrap.innerHTML =
    '<div class="msg-avatar">EV</div><div class="msg-body"><span class="typing"><i></i><i></i><i></i></span></div>';
  els.feed.appendChild(wrap);
  scrollFeed();
  return wrap;
}

function scrollFeed() {
  requestAnimationFrame(() => {
    els.feed.scrollTop = els.feed.scrollHeight;
  });
}

function renderWelcome() {
  if (state.settings?.aiProvider === 'gemini-live') {
    addMessage(
      'assistant',
      'Modo Gemini Live: pulsa el micrófono y habla, o escríbeme. La voz y las respuestas las genera Gemini en tiempo real.'
    );
    return;
  }

  addMessage(
    'assistant',
    'Hola, soy EV. Pulsa el micrófono una vez y habla conmigo: te escucho, detecto cuando terminas y te respondo. También puedes escribirme.'
  );
  if (state.settings && !state.settings.aiHasKey) {
    addMessage(
      'assistant',
      'Ahora mismo estoy en modo local. Abre Ajustes y conecta tu clave de OpenAI, Gemini o Claude para conversar sin límites. La voz gratis de Edge ya está activada.'
    );
  }
}

async function send(text) {
  const message = String(text || '').trim();
  if (!message) return;

  if (isLiveMode()) {
    addMessage('user', message);
    els.input.value = '';
    els.live.textContent = '';
    state.thinking = true;
    renderState();

    if (!state.live.active) {
      await startLive({ withMic: false });
    }

    if (state.live.ready) sendLive({ type: 'text', text: message });
    else state.live.queue.push(message);
    return;
  }

  if (state.thinking) {
    toast('Dame un segundo, sigo con lo anterior.');
    return;
  }

  // Pausar la escucha mientras pensamos y hablamos (evita oírse a sí misma).
  if (state.conversation && state.vad.analyser) pauseVad();

  addMessage('user', message);
  els.input.value = '';
  els.live.textContent = '';

  state.thinking = true;
  renderState();
  const typing = addTyping();

  try {
    const data = await api('/api/chat', {
      method: 'POST',
      body: JSON.stringify({ text: message }),
    });

    typing.remove();
    state.thinking = false;

    if (data.reply) addMessage('assistant', data.reply, data.actions || []);
    if (data.pending) showConfirm(data.pending);

    renderState();
    await speak(data.reply);

    if (state.conversation && state.vad.analyser) resumeVad();
    else if (state.voiceMode === 'speech' && state.micOn && state.settings?.continuousListening) startListening(true);
  } catch (err) {
    typing.remove();
    state.thinking = false;
    renderState();
    toast(err.message || 'No pude procesar el comando.', 'bad');
    addMessage('assistant', 'Se me cruzó un cable. ¿Puedes repetirlo?');
    if (state.conversation && state.vad.analyser) resumeVad();
    else if (state.voiceMode === 'speech' && state.micOn) startListening(true);
  }
}

/* --------------------------------------------------------------------------
   Confirmaciones
   -------------------------------------------------------------------------- */

function showConfirm(pending, handler = null) {
  state.pending = pending;
  state.confirmHandler = handler;
  const name = pending?.name;
  const args = pending?.args || {};

  let text = 'Esta acción necesita tu permiso.';
  if (name === 'power' && args.action === 'shutdown') text = 'Voy a apagar el equipo. Guarda lo que necesites, se apagará en 5 segundos.';
  else if (name === 'power' && args.action === 'restart') text = 'Voy a reiniciar el equipo en 5 segundos.';
  else if (name === 'delete_path') text = `Voy a enviar «${args.path}» a la papelera de reciclaje.`;
  else if (name === 'run_shell') text = `Voy a ejecutar este comando de PowerShell:\n${args.command}`;

  els.confirmText.textContent = text;
  els.confirmBackdrop.classList.add('open');
  els.btnAcceptConfirm.focus();
}

function closeConfirm() {
  els.confirmBackdrop.classList.remove('open');
  state.pending = null;
}

function resolveConfirm(approved) {
  const handler = state.confirmHandler;
  state.confirmHandler = null;
  closeConfirm();

  if (handler) handler(approved);
  else send(approved ? 'sí' : 'no');
}

/* --------------------------------------------------------------------------
   Ajustes
   -------------------------------------------------------------------------- */

function openSettings() {
  els.drawer.classList.add('open');
  els.drawer.setAttribute('aria-hidden', 'false');
  els.drawerBackdrop.classList.add('open');
  if (state.settings) {
    els.inpEleven.value = '';
    els.inpEleven.placeholder = state.settings.hasElevenLabs ? '•••••••••••• (guardada)' : 'Tu clave de ElevenLabs';
    els.inpVoiceId.value = state.settings.elevenVoiceId || '';
    els.selAIProvider.value = state.settings.aiProvider || 'openai';
    els.inpAIBase.value = state.settings.aiBaseUrl || '';
    renderAIProvider();
    els.selProvider.value = state.settings.ttsProvider || 'auto';
    fillEdgeVoices(state.settings.edgeVoice);
    fillGeminiVoices(state.settings.geminiVoice);
    updateVoiceFields();
    setSwitch(els.swVoice, state.settings.voiceEnabled);
    setSwitch(els.swConversation, state.settings.conversationMode !== false);
    setSwitch(els.swShell, state.settings.allowShell);
    els.selVadSilence.value = String(state.settings.vadSilenceMs ?? 900);
    els.selVadSensitivity.value = String(state.settings.vadSensitivity ?? 1);
    els.inpVolume.value = String(Math.round((state.settings.voiceVolume ?? 0.9) * 100));
    els.volLabel.textContent = `${els.inpVolume.value}%`;

    // Spotify & Google
    if (els.inpSpotifyId) {
      if (els.spotifyRedirectUri) {
        els.spotifyRedirectUri.textContent = 'http://127.0.0.1/api/spotify/oauth/callback';
      }
      els.inpSpotifyId.value = state.settings.spotifyClientId || '';
      els.inpSpotifySecret.value = '';
      els.inpSpotifySecret.placeholder = state.settings.hasSpotifyKey ? '•••••••••••• (guardada)' : 'Tu Client Secret';
      if (els.spotifyStatus) {
        els.spotifyStatus.textContent = state.settings.hasSpotifyConnected
          ? '✓ Conectado a Spotify'
          : 'No conectado';
        els.spotifyStatus.style.color = state.settings.hasSpotifyConnected ? '#4ade80' : 'inherit';
      }
      if (els.spotifyHint) {
        els.spotifyHint.textContent = state.settings.hasSpotifyConnected
          ? 'Control de reproducción activo: EV cambia de canción por la API, sin abrir la ventana.'
          : state.settings.hasSpotifyKey
            ? 'Credenciales guardadas. Pulsa «Conectar con Spotify» para controlar la reproducción.'
            : 'Añade tus credenciales y pulsa «Conectar con Spotify» para cambiar de canción sin ventana.';
      }
    }

    if (els.inpGoogleId) {
      els.inpGoogleId.value = state.settings.googleClientId || '';
      els.inpGoogleSecret.value = '';
      els.inpGoogleSecret.placeholder = state.settings.hasGoogleConnected ? '•••••••••••• (guardada)' : 'Tu Client Secret';
      if (els.googleStatus) {
        els.googleStatus.textContent = state.settings.hasGoogleConnected ? '✓ Conectado a Google' : 'No conectado';
        els.googleStatus.style.color = state.settings.hasGoogleConnected ? '#4ade80' : 'inherit';
      }
    }

    syncClearButtons();
  }
}

function renderAIProvider() {
  const provider = els.selAIProvider.value;
  const meta = AI_META[provider] || AI_META.openai;
  const hasKey = Boolean(state.settings?.hasAI?.[provider]);

  els.aiKeyLabel.textContent = meta.keyLabel;
  els.inpAIKey.value = '';
  els.inpAIKey.placeholder = hasKey ? '•••••••••••• (guardada)' : meta.placeholder;

  els.inpAIModel.value = state.settings?.aiModels?.[provider] || meta.models[0] || '';
  els.inpAIModel.placeholder = meta.models[0] || '';
  els.aiModelsList.innerHTML = meta.models.map((model) => `<option value="${model}"></option>`).join('');

  els.aiBaseField.hidden = provider !== 'compatible';
  if (provider === 'compatible') els.inpAIBase.value = state.settings?.aiBaseUrl || '';

  els.aiHint.textContent = meta.hint;
  els.aiKeyLink.href = meta.link;
  els.aiKeyLink.textContent = meta.linkText;

  updateVoiceFields();
}

async function testAI() {
  const provider = els.selAIProvider.value;
  els.btnTestAI.disabled = true;
  els.btnTestAI.textContent = 'Probando…';

  try {
    const data = await api('/api/ai/test', {
      method: 'POST',
      body: JSON.stringify({
        provider,
        key: els.inpAIKey.value.trim() || undefined,
        model: els.inpAIModel.value.trim() || undefined,
        baseUrl: els.aiBaseField.hidden ? undefined : els.inpAIBase.value.trim() || undefined,
      }),
    });

    if (data.ok) {
      const reply = String(data.reply || '').slice(0, 40);
      toast(`Conexión correcta con ${AI_META[provider].label}. Respondió: «${reply}»`, 'good');
    } else {
      toast(data.error || 'No pude conectar con ese proveedor.', 'bad');
    }
  } catch (err) {
    toast(err.message || 'No pude probar la conexión.', 'bad');
  } finally {
    els.btnTestAI.disabled = false;
    els.btnTestAI.textContent = 'Probar conexión';
  }
}

function fillEdgeVoices(preferred) {
  const fallback = [
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

  const voices = state.edgeVoices.length ? state.edgeVoices : fallback;
  const current = preferred || els.selEdgeVoice.value || 'es-ES-ElviraNeural';
  els.selEdgeVoice.innerHTML = '';
  for (const voice of voices) {
    const option = document.createElement('option');
    option.value = voice.id;
    option.textContent = voice.label;
    els.selEdgeVoice.appendChild(option);
  }
  els.selEdgeVoice.value = voices.some((v) => v.id === current) ? current : voices[0].id;
}

function fillGeminiVoices(preferred) {
  const fallback = [
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

  const voices = state.geminiVoices.length ? state.geminiVoices : fallback;
  const current = preferred || els.selGeminiVoice.value || 'Kore';
  els.selGeminiVoice.innerHTML = '';
  for (const voice of voices) {
    const option = document.createElement('option');
    option.value = voice.id;
    option.textContent = voice.label;
    els.selGeminiVoice.appendChild(option);
  }
  els.selGeminiVoice.value = voices.some((v) => v.id === current) ? current : voices[0].id;
}

function updateVoiceFields() {
  const provider = els.selProvider.value;
  const liveMode = els.selAIProvider.value === 'gemini-live';
  const showEdge = !liveMode && (provider === 'edge' || provider === 'auto');
  const showGemini = liveMode || provider === 'gemini';
  const showEleven = !liveMode && (provider === 'eleven' || provider === 'auto');

  els.edgeVoiceField.hidden = !showEdge;
  els.geminiVoiceField.hidden = !showGemini;
  els.elevenKeyField.hidden = !showEleven;
  els.elevenVoiceField.hidden = !showEleven;
  els.elevenNote.hidden = !showEleven;
  els.elevenVoicesLink.hidden = !showEleven;

  const geminiLabel = els.geminiVoiceField.querySelector('span');
  if (geminiLabel) geminiLabel.textContent = liveMode ? 'Voz de Gemini Live' : 'Voz de Gemini';

  updateVoiceHint();
  if (state.settings) syncClearButtons();
}

function updateVoiceHint() {
  const provider = els.selProvider.value;
  const hasEleven = Boolean(state.settings?.hasElevenLabs);

  if (els.selAIProvider.value === 'gemini-live') {
    els.voiceHint.textContent = 'En modo Live la voz la genera Gemini; el motor de voz no se usa.';
    return;
  }

  let text = 'Edge es gratis y no necesita clave.';
  if (provider === 'browser') text = 'Usa las voces instaladas en Windows.';
  else if (provider === 'edge') text = 'Voz neuronal de Microsoft Edge: gratis y sin clave.';
  else if (provider === 'gemini') {
    text = state.settings?.hasGeminiKey
      ? 'Voz de Gemini con tu clave de Inteligencia.'
      : 'Añade tu clave de Gemini en Inteligencia para usarla.';
  } else if (provider === 'eleven') {
    text = hasEleven ? 'Usando tu clave de ElevenLabs.' : 'Pega tu clave para usar ElevenLabs.';
  } else if (hasEleven) text = 'ElevenLabs si responde; si falla, Edge gratis.';

  els.voiceHint.textContent = text;
}

function closeSettings() {
  els.drawer.classList.remove('open');
  els.drawer.setAttribute('aria-hidden', 'true');
  els.drawerBackdrop.classList.remove('open');
}

function setSwitch(el, on) {
  el.setAttribute('aria-checked', String(Boolean(on)));
}

function isSwitchOn(el) {
  return el.getAttribute('aria-checked') === 'true';
}

function syncClearButtons() {
  const provider = els.selProvider.value;
  const items = [
    {
      id: 'ai',
      group: els.inpAIKey.closest('.settings-group'),
      has: Boolean(state.settings?.hasAI?.[els.selAIProvider.value]),
    },
    {
      id: 'eleven',
      group: els.inpEleven.closest('.settings-group'),
      has: Boolean(state.settings?.hasElevenLabs),
      hidden: provider !== 'auto' && provider !== 'eleven',
    },
  ];

  for (const item of items) {
    const existing = document.getElementById(`clear-${item.id}`);
    if (existing) existing.remove();
    if (!item.has || item.hidden) continue;

    const btn = document.createElement('button');
    btn.id = `clear-${item.id}`;
    btn.className = 'ghost-btn';
    btn.style.alignSelf = 'flex-start';
    btn.style.height = '28px';
    btn.textContent = 'Borrar clave guardada';

    btn.addEventListener('click', async () => {
      const patch =
        item.id === 'ai'
          ? { clearAIKey: true, aiProvider: els.selAIProvider.value }
          : { clearEleven: true };
      const data = await api('/api/settings', { method: 'POST', body: JSON.stringify(patch) });
      state.settings = data.settings;
      renderPills();
      openSettings();
      toast('Clave eliminada.', 'good');
    });

    item.group.insertBefore(btn, item.group.querySelector('.hint-link'));
  }
}

async function saveSettings() {
  const payload = {
    voiceEnabled: isSwitchOn(els.swVoice),
    conversationMode: isSwitchOn(els.swConversation),
    vadSilenceMs: Number(els.selVadSilence.value),
    vadSensitivity: Number(els.selVadSensitivity.value),
    allowShell: isSwitchOn(els.swShell),
    voiceVolume: Number(els.inpVolume.value) / 100,
    ttsProvider: els.selProvider.value,
    edgeVoice: els.selEdgeVoice.value,
    geminiVoice: els.selGeminiVoice.value,
    aiProvider: els.selAIProvider.value,
    aiBaseUrl: els.inpAIBase.value.trim(),
  };

  if (els.inpAIModel.value.trim()) payload.aiModel = els.inpAIModel.value.trim();
  if (els.inpAIKey.value.trim()) payload.aiKey = els.inpAIKey.value.trim();
  if (els.inpEleven.value.trim()) payload.elevenKey = els.inpEleven.value.trim();
  if (els.inpVoiceId.value.trim()) payload.elevenVoiceId = els.inpVoiceId.value.trim();

  if (els.inpSpotifyId) {
    payload.spotifyClientId = els.inpSpotifyId.value.trim();
    if (els.inpSpotifySecret.value.trim()) payload.spotifyClientSecret = els.inpSpotifySecret.value.trim();
  }
  if (els.inpGoogleId) {
    payload.googleClientId = els.inpGoogleId.value.trim();
    if (els.inpGoogleSecret.value.trim()) payload.googleClientSecret = els.inpGoogleSecret.value.trim();
  }

  els.btnSave.disabled = true;
  els.btnSave.textContent = 'Guardando…';

  try {
    const data = await api('/api/settings', { method: 'POST', body: JSON.stringify(payload) });
    state.settings = data.settings;
    renderPills();
    if (!isLiveMode() && state.live.active) stopLive();
    if (state.recognition) state.recognition.lang = state.settings.language || 'es-ES';
    closeSettings();
    toast('Ajustes guardados.', 'good');
  } catch (err) {
    toast(err.message || 'No pude guardar los ajustes.', 'bad');
  } finally {
    els.btnSave.disabled = false;
    els.btnSave.textContent = 'Guardar ajustes';
  }
}

async function testVoice() {
  const sample = 'Hola, soy EV. Así suena mi voz cuando me configuras.';
  els.btnTestVoice.disabled = true;
  try {
    const res = await fetch('/api/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: sample,
        provider: els.selProvider.value,
        edgeVoice: els.selEdgeVoice.value,
        geminiVoice: els.selGeminiVoice.value,
        elevenVoiceId: els.inpVoiceId.value.trim() || undefined,
      }),
    });

    if (res.ok) {
      const used = res.headers.get('x-ev-voice');
      await playAudioBlob(await res.blob());
      const names = {
        eleven: 'Voz de ElevenLabs',
        gemini: 'Voz de Gemini',
        edge: 'Voz gratis de Edge',
      };
      toast(`${names[used] || 'Voz'} reproduciéndose.`, 'good');
      return;
    }

    const data = await res.json().catch(() => ({}));
    if (res.status === 502) toast(`No pude usar esa voz: ${data.message || 'error'}.`, 'bad');
    else toast(data.message ? `${data.message}.` : 'Esa voz no está disponible.');
  } catch {
    toast('No pude conectar con el motor de voz.', 'bad');
  } finally {
    els.btnTestVoice.disabled = false;
  }

  await browserSpeak(sample);
}

/* --------------------------------------------------------------------------
   Eventos
   -------------------------------------------------------------------------- */

function bindEvents() {
  els.micBtn.addEventListener('click', toggleMic);
  els.sendBtn.addEventListener('click', () => send(els.input.value));
  els.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      send(els.input.value);
    }
  });

  els.chips.addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (chip) send(chip.dataset.cmd);
  });

  els.btnClear.addEventListener('click', async () => {
    stopPlayback();
    await api('/api/reset', { method: 'POST', body: '{}' }).catch(() => {});
    els.feed.innerHTML = '';
    renderWelcome();
    toast('Conversación reiniciada.');
  });

  els.btnSettings.addEventListener('click', openSettings);
  els.btnScreen.addEventListener('click', toggleScreenShare);
  els.btnCloseSettings.addEventListener('click', closeSettings);
  els.drawerBackdrop.addEventListener('click', closeSettings);
  els.btnSave.addEventListener('click', saveSettings);
  els.btnTestVoice.addEventListener('click', testVoice);

  els.swVoice.addEventListener('click', () => setSwitch(els.swVoice, !isSwitchOn(els.swVoice)));
  els.selProvider.addEventListener('change', updateVoiceFields);
  els.selAIProvider.addEventListener('change', renderAIProvider);
  els.btnTestAI.addEventListener('click', testAI);
  els.swConversation.addEventListener('click', () =>
    setSwitch(els.swConversation, !isSwitchOn(els.swConversation))
  );
  els.swShell.addEventListener('click', () => setSwitch(els.swShell, !isSwitchOn(els.swShell)));

  els.inpVolume.addEventListener('input', () => {
    els.volLabel.textContent = `${els.inpVolume.value}%`;
    if (state.audioEl) state.audioEl.volume = Number(els.inpVolume.value) / 100;
    if (state.playbackGain) state.playbackGain.gain.value = Number(els.inpVolume.value) / 100;
  });

  els.btnAcceptConfirm.addEventListener('click', () => {
    resolveConfirm(true);
  });
  els.btnCancelConfirm.addEventListener('click', () => {
    resolveConfirm(false);
  });
  els.confirmBackdrop.addEventListener('click', (e) => {
    if (e.target === els.confirmBackdrop) {
      resolveConfirm(false);
    }
  });

  els.pillBrain.addEventListener('click', openSettings);
  els.pillVoice.addEventListener('click', openSettings);

  if (els.btnTestSpotify) {
    els.btnTestSpotify.addEventListener('click', async () => {
      els.btnTestSpotify.disabled = true;
      els.btnTestSpotify.textContent = 'Probando…';
      try {
        const patch = {};
        if (els.inpSpotifyId.value.trim()) patch.spotifyClientId = els.inpSpotifyId.value.trim();
        if (els.inpSpotifySecret.value.trim()) patch.spotifyClientSecret = els.inpSpotifySecret.value.trim();
        if (Object.keys(patch).length) {
          await api('/api/settings', { method: 'POST', body: JSON.stringify(patch) });
        }
        const data = await api('/api/spotify/test', { method: 'POST' });
        if (data.ok) {
          toast(data.message, 'good');
          if (els.spotifyHint) els.spotifyHint.textContent = 'API oficial de Spotify conectada.';
        } else {
          toast(data.error || 'No se pudo conectar a Spotify.', 'bad');
        }
      } catch (err) {
        toast(err.message || 'Error probando Spotify.', 'bad');
      } finally {
        els.btnTestSpotify.disabled = false;
        els.btnTestSpotify.textContent = 'Probar Spotify API';
      }
    });
  }

  if (els.btnConnectSpotify) {
    els.btnConnectSpotify.addEventListener('click', async () => {
      const clientId = els.inpSpotifyId.value.trim();
      const clientSecret = els.inpSpotifySecret.value.trim();
      if (!clientId) {
        toast('Introduce primero tu Spotify Client ID.', 'bad');
        return;
      }

      const popup = window.open('', 'spotify_oauth', 'width=640,height=760');
      els.btnConnectSpotify.disabled = true;
      els.btnConnectSpotify.textContent = 'Conectando…';
      try {
        const patch = { spotifyClientId: clientId };
        if (clientSecret) patch.spotifyClientSecret = clientSecret;
        await api('/api/settings', { method: 'POST', body: JSON.stringify(patch) });

        const res = await api('/api/spotify/oauth/url');
        if (!res.url) throw new Error('Spotify no devolvió la URL de autorización.');
        if (popup) {
          popup.location.href = res.url;
        } else {
          throw new Error('Permite las ventanas emergentes para conectar Spotify.');
        }
      } catch (err) {
        if (popup) popup.close();
        toast(err.message || 'Error iniciando la conexión con Spotify.', 'bad');
      } finally {
        els.btnConnectSpotify.disabled = false;
        els.btnConnectSpotify.textContent = 'Conectar con Spotify';
      }
    });

    window.addEventListener('message', async (e) => {
      if (e.data?.type === 'spotify_connected') {
        toast('¡Spotify conectado!', 'good');
        const st = await api('/api/settings');
        state.settings = st.settings;
        openSettings();
      }
    });
  }

  if (els.btnConnectGoogle) {
    els.btnConnectGoogle.addEventListener('click', async () => {
      const clientId = els.inpGoogleId.value.trim();
      const clientSecret = els.inpGoogleSecret.value.trim();
      if (!clientId) {
        toast('Introduce primero tu Google Client ID.', 'bad');
        return;
      }
      try {
        const patch = { googleClientId: clientId };
        if (clientSecret) patch.googleClientSecret = clientSecret;
        await api('/api/settings', { method: 'POST', body: JSON.stringify(patch) });
        const res = await api('/api/google/oauth/url');
        if (res.url) {
          window.open(res.url, 'google_oauth', 'width=600,height=700');
        }
      } catch (err) {
        toast(err.message || 'Error iniciando conexión con Google.', 'bad');
      }
    });

    window.addEventListener('message', async (e) => {
      if (e.data?.type === 'google_connected') {
        toast('¡Google Calendar conectado!', 'good');
        const st = await api('/api/settings');
        state.settings = st.settings;
        if (els.googleStatus) {
          els.googleStatus.textContent = '✓ Conectado a Google';
          els.googleStatus.style.color = '#4ade80';
        }
      }
    });
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeSettings();
      if (els.confirmBackdrop.classList.contains('open')) {
        resolveConfirm(false);
      }
      if (state.speaking) stopPlayback();
      if (state.screen.active) stopScreenShare(true);
      fetch('/api/stop-actions', { method: 'POST' }).catch(() => {});
    }
    if (e.ctrlKey && e.code === 'Space') {
      e.preventDefault();
      toggleMic();
    }
  });

  window.addEventListener('beforeunload', () => {
    try {
      state.recognition?.stop();
    } catch {}
  });
}

/* --------------------------------------------------------------------------
   Arranque
   -------------------------------------------------------------------------- */

async function init() {
  bindEvents();
  requestAnimationFrame(levelLoop);

  try {
    const data = await api('/api/settings');
    state.settings = data.settings;
    state.health = data;
    state.sttReady = Boolean(data.stt?.ready || data.stt?.status === 'loading');
    renderPills();
  } catch {
    toast('No pude conectar con el servidor de EV.', 'bad');
  }

  try {
    const voices = await api('/api/voices');
    state.edgeVoices = voices.edge || [];
    state.geminiVoices = voices.gemini || [];
  } catch {
    state.edgeVoices = [];
    state.geminiVoices = [];
  }

  renderWelcome();
  initRecognition();
  renderState();

  els.input.focus({ preventScroll: true });
}

document.addEventListener('DOMContentLoaded', init);
