'use strict';

/**
 * EV · servidor local
 * Escucha solo en 127.0.0.1 para que nada salga de tu equipo sin permiso.
 */

const path = require('node:path');
const crypto = require('node:crypto');
const { exec } = require('node:child_process');
const express = require('express');

const { config, publicConfig, saveConfig, aiResolved, AI_PRESETS } = require('./config');
const { respond, executePending, testProvider, AFFIRMATIVE, NEGATIVE } = require('./brain');
const { attachLive, broadcastStopScreen, testLiveConnection } = require('./live');
const vision = require('./vision');
const {
  synthesize,
  trimForSpeech,
  providerFor,
  EDGE_VOICES,
  GEMINI_VOICES,
  edgeAvailable,
} = require('./tts');
const { transcribeWav, warmup: sttWarmup, sttStatus } = require('./stt');
const { toolCatalog } = require('./tools');
const spotify = require('./spotify');
const google = require('./google');

const app = express();
const PORT_START = Number(process.env.EV_PORT) || 4173;

app.disable('x-powered-by');
app.use(express.json({ limit: '20mb' }));
app.use(express.static(path.join(__dirname, '..', 'public'), { extensions: ['html'] }));

/* Estado de la sesión (un solo usuario local) */
let history = [];
let pending = null;
let spotifyOAuthState = null;

function pushHistory(role, content) {
  history.push({ role, content });
  if (history.length > 24) history = history.slice(-24);
}

/* ------------------------------------------------------------------ */
/* API                                                                 */
/* ------------------------------------------------------------------ */

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    app: 'EV',
    hasOpenAI: Boolean(config.aiKeys.openai),
    ai: aiResolved(),
    hasElevenLabs: Boolean(config.elevenKey),
    voiceEnabled: Boolean(config.voiceEnabled),
    tts: {
      provider: providerFor(config),
      selected: config.ttsProvider,
      edgeAvailable,
    },
    stt: sttStatus(),
    tools: toolCatalog().length,
  });
});

app.get('/api/voices', (req, res) => {
  res.json({
    edge: EDGE_VOICES,
    gemini: GEMINI_VOICES,
    provider: providerFor(config),
    ttsProvider: config.ttsProvider,
    edgeVoice: config.edgeVoice,
    geminiVoice: config.geminiVoice,
    edgeAvailable,
    hasGeminiKey: Boolean(config.aiKeys.gemini),
  });
});

app.get('/api/settings', (req, res) => {
  res.json({ settings: publicConfig(), tools: toolCatalog(), stt: sttStatus() });
});

app.post('/api/settings', (req, res) => {
  const body = req.body || {};
  const patch = {};
  const AI_PROVIDERS = ['openai', 'gemini', 'gemini-live', 'anthropic', 'compatible'];
  const provider = AI_PROVIDERS.includes(body.aiProvider) ? body.aiProvider : config.aiProvider;

  const strings = ['assistantName', 'elevenVoiceId', 'elevenModel', 'language'];
  for (const field of strings) {
    if (typeof body[field] === 'string' && body[field].trim()) patch[field] = body[field].trim();
  }

  // Proveedor de IA y sus datos por proveedor.
  if (AI_PROVIDERS.includes(body.aiProvider)) patch.aiProvider = body.aiProvider;
  if (typeof body.aiModel === 'string' && body.aiModel.trim()) {
    patch.aiModels = { ...config.aiModels, [provider]: body.aiModel.trim() };
  }
  if (typeof body.openaiModel === 'string' && body.openaiModel.trim()) {
    patch.aiModels = { ...(patch.aiModels || config.aiModels), openai: body.openaiModel.trim() };
  }
  if (typeof body.aiKey === 'string' && body.aiKey.trim()) {
    patch.aiKeys = { ...config.aiKeys, [provider]: body.aiKey.trim() };
  }
  if (typeof body.openaiKey === 'string' && body.openaiKey.trim()) {
    patch.aiKeys = { ...(patch.aiKeys || config.aiKeys), openai: body.openaiKey.trim() };
  }
  if (body.clearAIKey) {
    patch.aiKeys = { ...config.aiKeys, [provider]: '' };
  }
  if (body.clearOpenAI) {
    patch.aiKeys = { ...(patch.aiKeys || config.aiKeys), openai: '' };
  }
  if (typeof body.aiBaseUrl === 'string') patch.aiBaseUrl = body.aiBaseUrl.trim();

  if (typeof body.elevenKey === 'string' && body.elevenKey.trim()) patch.elevenKey = body.elevenKey.trim();
  if (body.clearEleven) patch.elevenKey = '';

  if (typeof body.voiceEnabled === 'boolean') patch.voiceEnabled = body.voiceEnabled;
  if (typeof body.allowShell === 'boolean') patch.allowShell = body.allowShell;
  if (typeof body.continuousListening === 'boolean') patch.continuousListening = body.continuousListening;
  if (typeof body.conversationMode === 'boolean') patch.conversationMode = body.conversationMode;
  if (typeof body.vadSilenceMs === 'number') patch.vadSilenceMs = Math.min(2500, Math.max(300, body.vadSilenceMs));
  if (typeof body.vadSensitivity === 'number') {
    patch.vadSensitivity = Math.min(2, Math.max(0.3, body.vadSensitivity));
  }
  if (typeof body.sttProvider === 'string' && ['auto', 'local', 'openai'].includes(body.sttProvider)) {
    patch.sttProvider = body.sttProvider;
  }
  if (typeof body.visionModel === 'string' && body.visionModel.trim()) {
    patch.visionModel = body.visionModel.trim();
  }
  if (typeof body.allowScreenControl === 'boolean') {
    patch.allowScreenControl = body.allowScreenControl;
  }
  if (
    typeof body.ttsProvider === 'string' &&
    ['auto', 'edge', 'eleven', 'gemini', 'browser'].includes(body.ttsProvider)
  ) {
    patch.ttsProvider = body.ttsProvider;
  }
  if (typeof body.edgeVoice === 'string' && body.edgeVoice.trim()) patch.edgeVoice = body.edgeVoice.trim();
  if (typeof body.edgeRate === 'number') patch.edgeRate = Math.min(50, Math.max(-50, body.edgeRate));
  if (typeof body.geminiVoice === 'string' && body.geminiVoice.trim()) {
    patch.geminiVoice = body.geminiVoice.trim();
  }
  if (typeof body.ttsLeadMs === 'number') {
    patch.ttsLeadMs = Math.min(1500, Math.max(0, body.ttsLeadMs));
  }

  if (typeof body.voiceVolume === 'number') patch.voiceVolume = Math.min(1, Math.max(0, body.voiceVolume));
  if (typeof body.speechRate === 'number') patch.speechRate = Math.min(2, Math.max(0.5, body.speechRate));

  // Spotify y Google
  if (typeof body.spotifyClientId === 'string') patch.spotifyClientId = body.spotifyClientId.trim();
  if (typeof body.spotifyClientSecret === 'string') patch.spotifyClientSecret = body.spotifyClientSecret.trim();
  if (body.clearSpotify) {
    patch.spotifyClientId = '';
    patch.spotifyClientSecret = '';
    patch.spotifyRefreshToken = '';
    spotify.clearUserToken();
  }

  if (typeof body.googleClientId === 'string') patch.googleClientId = body.googleClientId.trim();
  if (typeof body.googleClientSecret === 'string') patch.googleClientSecret = body.googleClientSecret.trim();
  if (typeof body.googleRefreshToken === 'string') patch.googleRefreshToken = body.googleRefreshToken.trim();
  if (body.clearGoogle) {
    patch.googleRefreshToken = '';
  }

  saveConfig(patch);
  res.json({ ok: true, settings: publicConfig() });
});

// OAuth Callback de Google Calendar
app.get('/api/google/oauth/callback', async (req, res) => {
  const code = req.query.code;
  if (!code) {
    return res.status(400).send('<h3>Error: No se recibió código de autorización de Google.</h3>');
  }

  const redirectUri = `${req.protocol}://${req.get('host')}/api/google/oauth/callback`;
  try {
    await google.exchangeGoogleCode(String(code), redirectUri);
    res.send(`
      <html>
        <body style="font-family: sans-serif; background: #05060b; color: #f0f3fa; text-align: center; padding: 4rem;">
          <h2 style="color: #38bdf8;">¡Google Calendar conectado con éxito a EV!</h2>
          <p>Ya puedes cerrar esta ventana y regresar a la aplicación.</p>
          <script>
            if (window.opener) { window.opener.postMessage({ type: 'google_connected' }, '*'); }
            setTimeout(() => window.close(), 2500);
          </script>
        </body>
      </html>
    `);
  } catch (err) {
    res.status(500).send(`<h3>Error autorizando Google: ${err.message}</h3>`);
  }
});

// URL para iniciar login OAuth con Google
app.get('/api/google/oauth/url', (req, res) => {
  const clientId = config.googleClientId || process.env.GOOGLE_CLIENT_ID;
  if (!clientId) {
    return res.status(400).json({ error: 'Falta Google Client ID en Ajustes.' });
  }

  const redirectUri = `${req.protocol}://${req.get('host')}/api/google/oauth/callback`;
  const scope = encodeURIComponent('https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.readonly');
  const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=${scope}&access_type=offline&prompt=consent`;

  res.json({ ok: true, url: authUrl });
});

app.get('/api/spotify/oauth/url', (req, res) => {
  if (!config.spotifyClientId || !config.spotifyClientSecret) {
    return res.status(400).json({
      error: 'Guarda primero el Client ID y el Client Secret de Spotify.',
    });
  }

  // Spotify exige una IP de loopback explícita; "localhost" no está permitido.
  const host = String(req.get('host') || '');
  const port = host.includes(':') ? host.split(':').pop() : '80';
  const redirectUri = `http://127.0.0.1:${port}/api/spotify/oauth/callback`;
  const state = crypto.randomBytes(16).toString('hex');
  spotifyOAuthState = {
    value: state,
    redirectUri,
    expiresAt: Date.now() + 10 * 60 * 1000,
  };

  try {
    const url = spotify.buildSpotifyAuthUrl(redirectUri, state);
    res.json({ ok: true, url, redirectUri });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/spotify/oauth/callback', async (req, res) => {
  const code = req.query.code;
  const state = req.query.state;
  const denied = req.query.error;

  const escapeHtml = (value) =>
    String(value).replace(
      /[&<>"']/g,
      (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char])
    );
  const page = (title, message, script = '') => `
    <html>
      <body style="font-family: sans-serif; background: #05060b; color: #f0f3fa; text-align: center; padding: 4rem;">
        <h2 style="color: #22c55e;">${escapeHtml(title)}</h2>
        <p>${escapeHtml(message)}</p>
        ${script}
      </body>
    </html>
  `;

  if (denied) {
    return res
      .status(400)
      .send(page('Spotify no autorizado', 'Puedes cerrar esta ventana y volver a intentarlo desde Ajustes.'));
  }

  if (!code) {
    return res.status(400).send(page('Falta el código', 'Spotify no devolvió un código de autorización.'));
  }

  const expected = spotifyOAuthState;
  if (
    !expected ||
    expected.value !== String(state || '') ||
    Date.now() > expected.expiresAt
  ) {
    return res
      .status(400)
      .send(page('La autorización expiró', 'Vuelve a pulsar «Conectar con Spotify» en Ajustes.'));
  }

  const redirectUri = expected.redirectUri;
  spotifyOAuthState = null;

  try {
    await spotify.exchangeSpotifyCode(String(code), redirectUri);
    res.send(
      page(
        '¡Spotify conectado con éxito!',
        'Ya puedes cerrar esta ventana y usar EV para cambiar de canción sin abrir Spotify.',
        `<script>
          if (window.opener) { window.opener.postMessage({ type: 'spotify_connected' }, '*'); }
          setTimeout(() => window.close(), 2000);
        </script>`
      )
    );
  } catch (err) {
    console.warn('[EV Spotify] Error al conectar la cuenta:', err.message);
    res.status(500).send(page('No pude conectar Spotify', err.message));
  }
});

app.post('/api/spotify/disconnect', (req, res) => {
  spotify.clearUserAuth();
  res.json({ ok: true, settings: publicConfig() });
});

app.post('/api/spotify/test', async (req, res) => {
  try {
    const userAccessToken = await spotify.getUserAccessToken();
    if (userAccessToken) {
      const devices = await spotify.getSpotifyDevices(userAccessToken);
      const names = devices.map((device) => device.name).filter(Boolean).slice(0, 3);
      return res.json({
        ok: true,
        message: names.length
          ? `Spotify conectado. Dispositivos: ${names.join(', ')}.`
          : 'Spotify conectado, pero no hay ningún dispositivo activo. Abre Spotify una vez.',
      });
    }

    const token = await spotify.getSpotifyToken();
    if (token) {
      res.json({
        ok: true,
        message: 'Credenciales de Spotify válidas. Pulsa «Conectar con Spotify» para controlar la reproducción.',
      });
    } else {
      res.json({ ok: false, error: 'No se pudo obtener token con las credenciales dadas.' });
    }
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/ai/test', async (req, res) => {
  const body = req.body || {};
  const providers = ['openai', 'gemini', 'gemini-live', 'anthropic', 'compatible'];
  const provider = providers.includes(body.provider) ? body.provider : config.aiProvider;

  if (provider === 'gemini-live') {
    return res.json(await testLiveConnection());
  }

  const key =
    typeof body.key === 'string' && body.key.trim()
      ? body.key.trim()
      : config.aiKeys[provider] || '';
  const model =
    typeof body.model === 'string' && body.model.trim()
      ? body.model.trim()
      : config.aiModels[provider] || '';

  let baseUrl = config.baseUrl || AI_PRESETS.openai;
  if (provider === 'gemini') baseUrl = process.env.GEMINI_BASE_URL || AI_PRESETS.gemini;
  else if (provider === 'anthropic') baseUrl = process.env.ANTHROPIC_BASE_URL || AI_PRESETS.anthropic;
  else if (provider === 'compatible') baseUrl = process.env.EV_COMPATIBLE_BASE_URL || config.aiBaseUrl || '';
  if (typeof body.baseUrl === 'string' && body.baseUrl.trim()) baseUrl = body.baseUrl.trim();

  if (!key) {
    return res.json({ ok: false, provider, model, error: 'Falta la clave de API para este proveedor.' });
  }

  try {
    const result = await testProvider({ provider, key, model, baseUrl });
    res.json(result);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/chat', async (req, res) => {
  const text = String(req.body?.text || '').trim();
  if (!text) return res.status(400).json({ error: 'Escribe o di un comando.' });

  try {
    /* Confirmación pendiente */
    if (pending) {
      if (AFFIRMATIVE.test(text)) {
        const action = pending;
        pending = null;
        const result = await executePending(action, config);
        pushHistory('user', text);
        pushHistory('assistant', result.reply);
        return res.json({ ...result, pending: null });
      }
      if (NEGATIVE.test(text)) {
        pending = null;
        const reply = 'Cancelado, no hice nada.';
        pushHistory('user', text);
        pushHistory('assistant', reply);
        return res.json({ reply, actions: [] });
      }
      pending = null;
    }

    const result = await respond({ text, history, config });
    if (result.pending) pending = result.pending;

    pushHistory('user', text);
    pushHistory('assistant', result.reply || '');

    res.json({
      reply: result.reply || '',
      actions: result.actions || [],
      pending: result.pending || null,
      apiError: Boolean(result.apiError),
      noKey: Boolean(result.noKey),
    });
  } catch (err) {
    console.error('[EV] error en /api/chat:', err);
    res.status(500).json({ error: 'Algo falló dentro de EV. Revisa la consola.' });
  }
});

app.post('/api/tts', async (req, res) => {
  const text = trimForSpeech(req.body?.text);
  if (!text) return res.status(400).json({ error: 'Texto vacío' });

  // Permitir probar una voz concreta antes de guardar los ajustes.
  const overrides = {};
  if (['auto', 'edge', 'eleven', 'gemini', 'browser'].includes(req.body?.provider)) {
    overrides.ttsProvider = req.body.provider;
  }
  if (typeof req.body?.edgeVoice === 'string' && req.body.edgeVoice.trim()) {
    overrides.edgeVoice = req.body.edgeVoice.trim();
  }
  if (typeof req.body?.elevenVoiceId === 'string' && req.body.elevenVoiceId.trim()) {
    overrides.elevenVoiceId = req.body.elevenVoiceId.trim();
  }
  if (typeof req.body?.geminiVoice === 'string' && req.body.geminiVoice.trim()) {
    overrides.geminiVoice = req.body.geminiVoice.trim();
  }

  try {
    const { buffer, provider: used, warning } = await synthesize(text, { ...config, ...overrides });
    res.set({
      'Content-Type': used === 'gemini' ? 'audio/wav' : 'audio/mpeg',
      'Content-Length': String(buffer.length),
      'Cache-Control': 'no-store',
      'X-EV-Voice': used,
    });
    if (warning) res.set('X-EV-Voice-Warning', encodeURIComponent(String(warning)).slice(0, 400));
    res.send(buffer);
  } catch (err) {
    if (err.code === 'BROWSER') {
      return res.status(501).json({ error: 'browser_voice', message: 'Voz del navegador' });
    }
    if (err.code === 'NO_KEY') {
      return res.status(501).json({
        error: 'no_key',
        message: err.message || 'Falta la clave del motor de voz',
      });
    }
    console.error('[EV] error TTS:', err.message);
    res.status(502).json({ error: 'tts_failed', message: err.message });
  }
});

app.post('/api/transcribe', async (req, res) => {
  const raw = String(req.body?.audio || '');
  if (!raw) return res.status(400).json({ error: 'Audio vacío' });

  const buffer = Buffer.from(raw, 'base64');
  if (!buffer.length) return res.status(400).json({ error: 'Audio vacío' });
  if (buffer.length > 15 * 1024 * 1024) {
    return res.status(413).json({ error: 'Audio demasiado largo' });
  }

  const requested = String(req.body?.language || config.language || 'es')
    .slice(0, 5)
    .toLowerCase()
    .split('-')[0];
  const language = /^[a-z]{2,3}$/.test(requested) ? requested : 'es';

  const isWav = buffer.length > 12 && buffer.toString('ascii', 0, 4) === 'RIFF';
  const provider = config.sttProvider || 'auto';

  const local = async () => {
    if (!isWav) {
      const error = new Error('El motor local necesita audio WAV');
      error.code = 'STT_FORMAT';
      throw error;
    }
    const text = await transcribeWav(buffer, language);
    return { text, engine: 'local' };
  };

  const openai = async () => {
    if (!config.openaiKey) {
      const error = new Error('Sin clave de OpenAI para transcribir');
      error.code = 'NO_KEY';
      throw error;
    }

    const mime = String(req.body?.mime || 'audio/wav');
    const ext = mime.includes('ogg') ? 'ogg' : mime.includes('mp4') ? 'mp4' : mime.includes('mpeg') ? 'mp3' : 'wav';

    const form = new FormData();
    form.append('file', new Blob([buffer], { type: mime }), `ev-audio.${ext}`);
    form.append('model', 'whisper-1');
    form.append('response_format', 'json');
    form.append('temperature', '0');
    form.append('language', language);
    if (language === 'es') {
      form.append(
        'prompt',
        'Conversación con EV, un asistente personal. Español natural, con puntuación y acentos.'
      );
    }

    const upstream = await fetch(`${config.baseUrl || 'https://api.openai.com/v1'}/audio/transcriptions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.openaiKey}` },
      body: form,
    });

    const data = await upstream.json().catch(() => ({}));
    if (!upstream.ok) {
      const error = new Error(data?.error?.message || `OpenAI respondió ${upstream.status}`);
      error.status = upstream.status;
      throw error;
    }

    return { text: String(data.text || '').trim(), engine: 'openai' };
  };

  try {
    if (provider === 'local') return res.json(await local());
    if (provider === 'openai') return res.json(await openai());

    if (isWav) {
      try {
        return res.json(await local());
      } catch (err) {
        console.warn('[EV] transcripción local no disponible:', err.message);
      }
    }
    return res.json(await openai());
  } catch (err) {
    if (err.code === 'NO_KEY') {
      return res.status(501).json({ error: 'no_key', message: 'Sin clave de OpenAI para transcribir.' });
    }
    console.error('[EV] error transcribiendo:', err.message);
    res.status(502).json({ error: 'transcribe_failed', message: err.message });
  }
});

app.post('/api/stop-actions', (req, res) => {
  const stopped = vision.stopAutoScroll();
  broadcastStopScreen();
  res.json({ ok: true, stopped });
});

app.post('/api/reset', (req, res) => {
  history = [];
  pending = null;
  res.json({ ok: true });
});

app.use('/api', (req, res) => res.status(404).json({ error: 'Ruta no encontrada' }));

/* ------------------------------------------------------------------ */
/* Arranque                                                            */
/* ------------------------------------------------------------------ */

function listen(port, attempt = 0) {
  const server = app.listen(port, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${port}`;
    console.log('');
    console.log('  ███████╗██╗   ██╗');
    console.log('  ██╔════╝██║   ██║');
    console.log('  █████╗  ██║   ██║');
    console.log('  ██╔══╝  ╚██╗ ██╔╝');
    console.log('  ███████╗ ╚████╔╝');
    console.log('  ╚══════╝  ╚═══╝');
    console.log('');
    console.log(`  EV está en marcha → ${url}`);
    const active = aiResolved();
    console.log(`  IA: ${active.provider} · ${active.model || 'sin modelo'} · voz: ${config.ttsProvider === 'gemini' ? 'Gemini' : providerFor(config)}`);
    console.log('  Cierra esta ventana para apagar a EV.');
    console.log('');

    if (!process.env.EV_NO_OPEN) {
      exec(`start "" "${url}"`, { windowsHide: true }, () => {});
    }
  });

  // WebSocket para Gemini Live (/api/live).
  attachLive(server);

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE' && attempt < 8) {
      listen(port + 1, attempt + 1);
      return;
    }
    console.error('[EV] No pude arrancar el servidor:', err.message);
    process.exit(1);
  });
}

// Dejar listo el host de captura/entrada para que la primera acción no espere
// al arranque de PowerShell.
if (process.env.EV_INPUT_WARMUP !== '0') {
  vision.warmUp().then((ok) => {
    if (ok) console.log('  Control de pantalla listo.');
  });
}

// Cargar el modelo de transcripción local en segundo plano.
if (process.env.EV_STT_WARMUP !== '0') {
  sttWarmup().then((ok) => {
    if (ok) console.log('  Transcripción local lista (Whisper).');
    else console.warn('  Transcripción local no disponible; se usará OpenAI si hay créditos.');
  });
}

listen(PORT_START);
