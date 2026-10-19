'use strict';

/**
 * El "cerebro" de EV.
 * - Con OPENAI_API_KEY: ChatGPT con function calling para decidir acciones.
 * - Sin clave: motor local de intenciones (funciona igual para comandos básicos).
 */

const { TOOL_DEFS, TOOL_LABELS, executeTool, requiresConfirmation, folders } = require('./tools');
const { aiResolved } = require('./config');

const PROVIDER_LABELS = {
  openai: 'OpenAI',
  gemini: 'Gemini',
  anthropic: 'Claude',
  compatible: 'el proveedor compatible',
};

const stripAccents = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
const norm = (s) => stripAccents(s).toLowerCase().trim();

function nowInfo() {
  const d = new Date();
  const time = d.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
  const date = d.toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  return { time, date };
}

function systemPrompt() {
  const { time, date } = nowInfo();
  return [
    'Eres EV, un asistente personal de escritorio para Windows que habla en español.',
    'Tu personalidad: cercana, rápida y natural. Hablas como una persona, no como un manual.',
    '',
    'Reglas de respuesta:',
    '- Máximo 2 frases cortas. Es texto que se va a leer en voz alta.',
    '- Nada de markdown, listas, viñetas, emojis ni asteriscos.',
    '- Cuando el usuario pida una acción, usa las herramientas disponibles. Nunca inventes que hiciste algo.',
    '- Si la petición es ambigua, haz una sola pregunta breve.',
    '- Las rutas relativas se refieren al Escritorio del usuario.',
    '- Si una acción requiere confirmación, el sistema se encargará de pedirla: no la ejecutes dos veces.',
    `- Fecha y hora actual: ${date}, ${time}.`,
    '',
    'Capacidades: abrir cualquier aplicación instalada por su nombre (aunque solo exista un acceso directo en el Escritorio), abrir webs, reproducir vídeos y música en segundo plano en Spotify o YouTube, gestionar tu agenda y citas de Google Calendar, crear y gestionar archivos y carpetas, copiar, mover, renombrar y comprimir, listar discos, ver y cerrar procesos, controlar ventanas, escribir texto y pulsar teclas, volumen y multimedia, capturas, portapapeles, red e IP, clima, descargas, accesos directos, brillo, información del sistema, ajustes de Windows, apagar o bloquear el equipo.',
    'Música en Spotify: si el usuario pide escuchar o cambiar una canción, artista, álbum o tipo de música (por ejemplo "pon música de Bad Bunny", "reproduce Moonlight", "pon otra canción", "quiero escuchar rock"), usa SIEMPRE play_spotify. No abras ventanas ni uses play_video si el usuario quiere escuchar música.',
    'Google Calendar: si el usuario pregunta qué tiene que hacer, qué eventos tiene hoy o pide consultar su agenda, usa google_calendar_list. Si pide agendar una cita o recordatorio ("agenda una reunión mañana a las 5"), usa google_calendar_create.',
    'También puedes ver la pantalla del usuario: usa look_at_screen para mirarla o responder preguntas sobre ella. Para hacer clic en cualquier elemento, botón, enlace o campo que veas en la pantalla (incluso compartiendo pantalla en directo con Gemini Live), NUNCA intentes adivinar coordenadas a mano con mouse_click: USA SIEMPRE click_on_screen con la descripción del elemento (target) o type_into para escribir. De esa forma EV tomará automáticamente una captura instantánea en alta resolución para calcular con total precisión la posición exacta del clic sin desvíos.',
    'Si no encuentras una app por su nombre, usa list_apps antes de rendirte. Para música en YouTube usa play_video.',
    'Para explorar un feed (por ejemplo YouTube), usa auto_scroll; detenlo con stop_actions en cuanto el usuario diga «para» o vea algo interesante, y después describe o abre lo que haya.',
    'Seguridad: nunca escribas contraseñas ni datos secretos. Si el usuario quiere rellenar una contraseña, dile que la escriba él mismo en el campo; tú puedes dejar el campo enfocado.',
  ].join('\n');
}

/* ------------------------------------------------------------------ */
/* OpenAI                                                              */
/* ------------------------------------------------------------------ */

// Recuerda qué parámetros acepta cada modelo para no repetir los reintentos.
const modelCaps = new Map();

async function callOpenAICompatible(messages, ai, options = {}) {
  const model = ai.model || 'gpt-4o-mini';
  const base = String(ai.baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const cacheKey = `${base}|${model}`;
  const remembered = modelCaps.get(cacheKey);
  const allowTools = options.tools !== false;
  const maxTokens = options.maxTokens || 1500;

  // Los modelos nuevos (gpt-5, o-series, gpt-6...) usan max_completion_tokens
  // y algunos no aceptan temperature. Probamos y nos adaptamos al error.
  let tokenParam = remembered?.tokenParam || 'max_tokens';
  let includeTemperature = remembered ? remembered.temperature : true;
  let includeTools = allowTools && (remembered ? remembered.tools !== false : true);
  let includeToolChoice = remembered ? remembered.toolChoice !== false : true;
  let reasoningEffort = remembered?.reasoningEffort || null;
  let lastError = null;

  for (let attempt = 0; attempt < 6; attempt += 1) {
    const body = { model, messages };
    if (includeTools) body.tools = TOOL_DEFS;
    if (includeTools && includeToolChoice) body.tool_choice = 'auto';
    body[tokenParam] = maxTokens;
    if (includeTemperature && options.temperature !== false) body.temperature = 0.5;
    if (reasoningEffort) body.reasoning_effort = reasoningEffort;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60000);
    let res;
    let raw = '';

    try {
      res = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${ai.key}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) raw = await res.text().catch(() => '');
    } finally {
      clearTimeout(timer);
    }

    if (res.ok) {
      modelCaps.set(cacheKey, {
        tokenParam,
        temperature: includeTemperature,
        tools: includeTools,
        toolChoice: includeToolChoice,
        reasoningEffort,
      });
      return await res.json();
    }

    let errorDetail = {};
    try {
      errorDetail = JSON.parse(raw)?.error || {};
    } catch {
      errorDetail = {};
    }

    const message = String(errorDetail.message || raw || `OpenAI respondió ${res.status}`);
    const param = String(errorDetail.param || '');
    const err = new Error(message.slice(0, 300));
    err.status = res.status;
    err.param = param;
    lastError = err;

    if (res.status === 400) {
      if ((param === 'max_tokens' || /Unsupported parameter: *'max_tokens'/.test(message)) && tokenParam !== 'max_completion_tokens') {
        tokenParam = 'max_completion_tokens';
        continue;
      }
      if ((param === 'max_completion_tokens' || /Unsupported parameter: *'max_completion_tokens'/.test(message)) && tokenParam !== 'max_tokens') {
        tokenParam = 'max_tokens';
        continue;
      }
      if ((param === 'temperature' || /temperature/i.test(message)) && includeTemperature) {
        includeTemperature = false;
        continue;
      }

      const mentionsReasoning = /reasoning_effort/i.test(message);
      if (mentionsReasoning && reasoningEffort !== 'none') {
        reasoningEffort = 'none';
        continue;
      }
      if (mentionsReasoning && includeTools) {
        // El modelo no admite herramientas ni así: seguimos sin acciones.
        includeTools = false;
        includeToolChoice = false;
        continue;
      }

      if ((param === 'tool_choice' || /tool_choice/i.test(message)) && includeToolChoice) {
        includeToolChoice = false;
        continue;
      }
      if (includeTools && (param === 'tools' || /(unsupported parameter: *'tools'|tools? (?:is |are )?not supported|does not support tools)/i.test(message))) {
        includeTools = false;
        includeToolChoice = false;
        continue;
      }
    }

    throw err;
  }

  throw lastError || new Error('No se pudo completar la petición al modelo.');
}

function friendlyApiError(err, provider = 'openai') {
  const label = PROVIDER_LABELS[provider] || 'el proveedor';
  if (err?.name === 'AbortError') return `${label} tardó demasiado en responder. Prueba otra vez.`;
  if (err?.status === 401 || err?.status === 403) {
    return `Tu clave de ${label} no es válida o no tiene permisos. Revísala en Ajustes.`;
  }
  if (err?.status === 429) return `${label} está limitando las peticiones. Espera unos segundos.`;
  if (err?.status === 404) return `El modelo configurado no existe en ${label}. Cámbialo en Ajustes.`;
  if (String(err?.message || '').includes('fetch failed')) {
    return `No pude conectar con ${label}. Revisa tu conexión a internet.`;
  }
  return `Error de ${label}: ${err?.message || 'desconocido'}`;
}

async function readApiError(res, provider) {
  const raw = await res.text().catch(() => '');
  let message = raw;
  try {
    message = JSON.parse(raw)?.error?.message || raw;
  } catch {}
  const err = new Error(String(message || `Error ${res.status}`).slice(0, 300));
  err.status = res.status;
  err.provider = provider;
  return err;
}

/* ------------------------------------------------------------------ */
/* OpenAI y cualquier API compatible                                   */
/* ------------------------------------------------------------------ */

async function askOpenAICompatible(text, history, ai) {
  const messages = [
    { role: 'system', content: systemPrompt() },
    ...history.slice(-14),
    { role: 'user', content: text },
  ];
  const actions = [];

  for (let step = 0; step < 6; step += 1) {
    let data;
    try {
      data = await callOpenAICompatible(messages, ai);
    } catch (err) {
      return { reply: friendlyApiError(err, ai.provider), actions, apiError: true };
    }

    const message = data?.choices?.[0]?.message;
    if (!message) return { reply: 'El modelo no devolvió respuesta.', actions };

    messages.push(message);

    if (!message.tool_calls?.length) {
      const reply = String(message.content || '').trim();
      return { reply: reply || summarise(actions) || 'Listo.', actions };
    }

    for (const call of message.tool_calls) {
      const name = call.function?.name;
      let args = {};
      try {
        args = JSON.parse(call.function?.arguments || '{}');
      } catch {
        args = {};
      }

      if (requiresConfirmation(name, args)) {
        return {
          reply: confirmationText(name, args),
          actions,
          pending: { name, args, created: Date.now() },
        };
      }

      const result = await executeTool(name, args);
      actions.push({ name, label: TOOL_LABELS[name] || name, ok: result.ok, summary: result.summary });
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: JSON.stringify({ ok: result.ok, resultado: result.summary }),
      });
    }
  }

  return { reply: 'Me quedé en medio de demasiadas acciones. ¿Puedes repetirlo de forma más simple?', actions };
}

/* ------------------------------------------------------------------ */
/* Google Gemini                                                       */
/* ------------------------------------------------------------------ */

function geminiContents(history, text) {
  const contents = [];

  const push = (role, value) => {
    if (!contents.length || contents[contents.length - 1].role !== role) {
      contents.push({ role, parts: [{ text: value }] });
    } else {
      contents[contents.length - 1].parts[0].text += `\n${value}`;
    }
  };

  for (const message of history.slice(-14)) {
    const value = String(message?.content || '').trim();
    if (!value) continue;
    push(message.role === 'assistant' ? 'model' : 'user', value);
  }

  push('user', text);
  return contents;
}

async function geminiGenerate(contents, ai, options = {}) {
  const base = String(ai.baseUrl || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/+$/, '');
  const model = String(ai.model || 'gemini-2.5-flash').replace(/^models\//, '');
  const url = `${base}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(ai.key)}`;

  const body = {
    contents,
    systemInstruction: { parts: [{ text: systemPrompt() }] },
    generationConfig: {
      temperature: 0.5,
      maxOutputTokens: options.maxTokens || 1500,
    },
  };

  if (options.tools !== false) {
    body.tools = [
      {
        functionDeclarations: TOOL_DEFS.map((tool) => ({
          name: tool.function.name,
          description: tool.function.description,
          parameters: tool.function.parameters,
        })),
      },
    ];
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60000),
  });

  if (!res.ok) throw await readApiError(res, 'gemini');
  return res.json();
}

async function askGemini(text, history, ai) {
  const contents = geminiContents(history, text);
  const actions = [];

  for (let step = 0; step < 6; step += 1) {
    let data;
    try {
      data = await geminiGenerate(contents, ai);
    } catch (err) {
      return { reply: friendlyApiError(err, 'gemini'), actions, apiError: true };
    }

    const parts = data?.candidates?.[0]?.content?.parts || [];
    const reply = parts
      .filter((part) => typeof part.text === 'string')
      .map((part) => part.text)
      .join('')
      .trim();
    const calls = parts.filter((part) => part.functionCall && part.functionCall.name);

    if (!calls.length) {
      return { reply: reply || summarise(actions) || 'Listo.', actions };
    }

    contents.push({ role: 'model', parts });
    const responses = [];

    for (const call of calls) {
      const name = call.functionCall.name;
      const args = call.functionCall.args || {};

      if (requiresConfirmation(name, args)) {
        return {
          reply: confirmationText(name, args),
          actions,
          pending: { name, args, created: Date.now() },
        };
      }

      const result = await executeTool(name, args);
      actions.push({ name, label: TOOL_LABELS[name] || name, ok: result.ok, summary: result.summary });
      responses.push({
        functionResponse: { name, response: { ok: result.ok, resultado: result.summary } },
      });
    }

    contents.push({ role: 'user', parts: responses });
  }

  return { reply: 'Me quedé en medio de demasiadas acciones. ¿Puedes repetirlo de forma más simple?', actions };
}

/* ------------------------------------------------------------------ */
/* Anthropic Claude                                                    */
/* ------------------------------------------------------------------ */

async function anthropicMessages(messages, ai, options = {}) {
  const base = String(ai.baseUrl || 'https://api.anthropic.com/v1').replace(/\/+$/, '');
  const body = {
    model: ai.model || 'claude-sonnet-4-5',
    max_tokens: options.maxTokens || 1500,
    system: systemPrompt(),
    messages,
  };

  if (options.tools !== false) {
    body.tools = TOOL_DEFS.map((tool) => ({
      name: tool.function.name,
      description: tool.function.description,
      input_schema: tool.function.parameters,
    }));
  }

  const res = await fetch(`${base}/messages`, {
    method: 'POST',
    headers: {
      'x-api-key': ai.key,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60000),
  });

  if (!res.ok) throw await readApiError(res, 'anthropic');
  return res.json();
}

async function askAnthropic(text, history, ai) {
  const messages = [];

  const push = (role, value) => {
    if (!messages.length || messages[messages.length - 1].role !== role) {
      messages.push({ role, content: value });
    } else {
      messages[messages.length - 1].content += `\n${value}`;
    }
  };

  for (const message of history.slice(-14)) {
    const value = String(message?.content || '').trim();
    if (!value) continue;
    push(message.role === 'assistant' ? 'assistant' : 'user', value);
  }

  push('user', text);
  const actions = [];

  for (let step = 0; step < 6; step += 1) {
    let data;
    try {
      data = await anthropicMessages(messages, ai);
    } catch (err) {
      return { reply: friendlyApiError(err, 'anthropic'), actions, apiError: true };
    }

    const blocks = Array.isArray(data?.content) ? data.content : [];
    const reply = blocks
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('')
      .trim();
    const toolUses = blocks.filter((block) => block.type === 'tool_use');

    if (!toolUses.length) {
      return { reply: reply || summarise(actions) || 'Listo.', actions };
    }

    messages.push({ role: 'assistant', content: blocks });
    const results = [];

    for (const use of toolUses) {
      const name = use.name;
      const args = use.input || {};

      if (requiresConfirmation(name, args)) {
        return {
          reply: confirmationText(name, args),
          actions,
          pending: { name, args, created: Date.now() },
        };
      }

      const result = await executeTool(name, args);
      actions.push({ name, label: TOOL_LABELS[name] || name, ok: result.ok, summary: result.summary });
      results.push({
        type: 'tool_result',
        tool_use_id: use.id,
        content: JSON.stringify({ ok: result.ok, resultado: result.summary }),
      });
    }

    messages.push({ role: 'user', content: results });
  }

  return { reply: 'Me quedé en medio de demasiadas acciones. ¿Puedes repetirlo de forma más simple?', actions };
}

/* ------------------------------------------------------------------ */
/* Prueba de conexión                                                  */
/* ------------------------------------------------------------------ */

async function testProvider(ai) {
  const prompt = 'Responde solo con la palabra OK.';

  try {
    if (!ai.key) throw new Error('Falta la clave de API');

    if (ai.provider === 'gemini') {
      const data = await geminiGenerate([{ role: 'user', parts: [{ text: prompt }] }], ai, {
        tools: false,
        maxTokens: 64,
      });
      const parts = data?.candidates?.[0]?.content?.parts || [];
      const reply = parts.filter((part) => part.text).map((part) => part.text).join(' ').trim();
      if (!reply) throw new Error('El modelo no devolvió texto');
      return { ok: true, provider: ai.provider, model: ai.model, reply };
    }

    if (ai.provider === 'anthropic') {
      const data = await anthropicMessages([{ role: 'user', content: prompt }], ai, {
        tools: false,
        maxTokens: 64,
      });
      const reply = (data.content || [])
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join(' ')
        .trim();
      if (!reply) throw new Error('El modelo no devolvió texto');
      return { ok: true, provider: ai.provider, model: ai.model, reply };
    }

    const data = await callOpenAICompatible([{ role: 'user', content: prompt }], ai, {
      tools: false,
      maxTokens: 256,
    });
    const reply = String(data?.choices?.[0]?.message?.content || '').trim();
    if (!reply) throw new Error('El modelo no devolvió texto');
    return { ok: true, provider: ai.provider, model: ai.model, reply };
  } catch (err) {
    return {
      ok: false,
      provider: ai.provider,
      model: ai.model,
      error: friendlyApiError(err, ai.provider),
      detail: String(err.message || '').slice(0, 200),
    };
  }
}

function summarise(actions) {
  if (!actions.length) return '';
  const last = actions[actions.length - 1];
  return last.ok ? last.summary : `No pude completarlo: ${last.summary}`;
}

function confirmationText(name, args) {
  if (name === 'power') {
    return args.action === 'restart'
      ? '¿Confirmas que reinicie el equipo? Di «sí» y lo hago.'
      : '¿Confirmas que apague el equipo? Di «sí» y lo hago.';
  }
  if (name === 'delete_path') return `Voy a enviar «${args.path}» a la papelera. ¿Confirmas?`;
  if (name === 'run_shell') return `Voy a ejecutar el comando «${args.command}». ¿Confirmas?`;
  return 'Esta acción necesita tu confirmación. ¿La ejecuto?';
}

/* ------------------------------------------------------------------ */
/* Motor local (sin API)                                               */
/* ------------------------------------------------------------------ */

const SITE_MAP = {
  youtube: 'https://www.youtube.com',
  google: 'https://www.google.com',
  gmail: 'https://mail.google.com',
  correo: 'https://mail.google.com',
  netflix: 'https://www.netflix.com',
  instagram: 'https://www.instagram.com',
  facebook: 'https://www.facebook.com',
  twitter: 'https://x.com',
  x: 'https://x.com',
  github: 'https://github.com',
  chatgpt: 'https://chat.openai.com',
  whatsapp: 'https://web.whatsapp.com',
  'whatsapp web': 'https://web.whatsapp.com',
  amazon: 'https://www.amazon.es',
  twitch: 'https://www.twitch.tv',
};

function cleanTarget(s) {
  return s
    .replace(/^(la|el|los|las)\s+(app|aplicacion|aplicación|programa|pagina|página|web)\s+(de\s+)?/i, '')
    .replace(/^(la|el)\s+/i, '')
    .replace(/[.?!]+$/, '')
    .trim();
}

function matchLocation(t) {
  if (/en (el |la )?(escritorio|desktop)/.test(t)) return 'Escritorio';
  if (/en (mis |los )?(documentos|documents)/.test(t)) return 'Documentos';
  if (/en (las |los )?(descargas|downloads)/.test(t)) return 'Descargas';
  if (/en (las )?(imagenes|imágenes|fotos|pictures)/.test(t)) return 'Imágenes';
  if (/en (la )?(musica|música|music)/.test(t)) return 'Música';
  return '';
}

function stripLocation(t) {
  return t
    .replace(/\s+en (el |la )?(escritorio|desktop)\b.*$/i, '')
    .replace(/\s+en (mis |los )?(documentos|documents)\b.*$/i, '')
    .replace(/\s+en (las |los )?(descargas|downloads)\b.*$/i, '')
    .replace(/\s+en (las )?(imagenes|imágenes|fotos|pictures)\b.*$/i, '')
    .replace(/\s+en (la )?(musica|música|music)\b.*$/i, '')
    .trim();
}

async function localBrain(text) {
  const raw = String(text || '').trim();
  const t = norm(raw);
  const tc = stripAccents(raw);
  const actions = [];
  const run = async (name, args) => {
    const result = await executeTool(name, args);
    actions.push({ name, label: TOOL_LABELS[name] || name, ok: result.ok, summary: result.summary });
    return result;
  };
  const confirm = (name, args) => ({
    reply: confirmationText(name, args),
    actions,
    pending: { name, args, created: Date.now() },
  });

  /* Saludos y ayuda */
  if (/^(hola|buenas|hey|holaa+|que tal|buenos dias|buenas tardes|buenas noches)\b/.test(t)) {
    return { reply: 'Hola, soy EV. ¿Qué hacemos?', actions };
  }
  if (/(que puedes hacer|ayuda|comandos|para que sirves|qué puedes hacer)/.test(t)) {
    return {
      reply:
        'Puedo abrir apps y webs, reproducir videos o música, crear carpetas y archivos, buscar archivos, controlar el volumen, hacer capturas y apagar el equipo. Solo dímelo.',
      actions,
    };
  }

  /* Hora y fecha */
  if (/(que hora|hora es|que fecha|que dia es|dia es hoy)/.test(t)) {
    const { time, date } = nowInfo();
    return { reply: `Son las ${time} del ${date}.`, actions };
  }

  /* Volumen */
  if (/(silencia|silencio|mutea|quita el sonido)/.test(t)) {
    await run('volume', { action: 'mute' });
    return { reply: 'Listo, silenciado.', actions };
  }
  if (/(sube|aumenta|mas alto|más alto).*(volumen|sonido)|volumen.*(arriba)/.test(t)) {
    const n = Number((t.match(/(\d{1,2})/) || [])[1] || 5);
    await run('volume', { action: 'up', steps: n });
    return { reply: 'Volumen arriba.', actions };
  }
  if (/(baja|reduce|menos|más bajo|mas bajo).*(volumen|sonido)|volumen.*(abajo)/.test(t)) {
    const n = Number((t.match(/(\d{1,2})/) || [])[1] || 5);
    await run('volume', { action: 'down', steps: n });
    return { reply: 'Volumen abajo.', actions };
  }

  /* Multimedia */
  if (/(pausa|pausar|reanuda|reanudar|continua la musica|continúa la música)/.test(t)) {
    await run('media_control', { action: 'playpause' });
    return { reply: 'Hecho.', actions };
  }
  if (/(siguiente|next).*(cancion|canción|pista|tema)|(cancion|canción|pista).*(siguiente)/.test(t)) {
    await run('media_control', { action: 'next' });
    return { reply: 'Siguiente.', actions };
  }
  if (/(anterior|previa).*(cancion|canción|pista|tema)|(cancion|canción|pista).*(anterior)/.test(t)) {
    await run('media_control', { action: 'prev' });
    return { reply: 'Anterior.', actions };
  }

  /* Captura */
  if (/(captura|pantallazo|screenshot)/.test(t)) {
    const r = await run('screenshot', {});
    return { reply: r.summary, actions };
  }

  /* Portapapeles */
  if (/(portapapeles|clipboard)/.test(t) && /(lee|leer|que hay|qué hay|muestra)/.test(t)) {
    const r = await run('clipboard', { action: 'read' });
    return { reply: r.summary, actions };
  }
  const clipWrite = tc.match(/^(?:copia|pon)\s+(.+?)\s+(?:en|al)\s+(?:el\s+)?portapapeles/i);
  if (clipWrite) {
    const r = await run('clipboard', { action: 'write', text: clipWrite[1] });
    return { reply: r.summary, actions };
  }

  /* Bloquear / energía */
  if (/(bloquea|bloquear|lock)/.test(t) && !/carpeta/.test(t)) {
    const r = await run('lock_pc', {});
    return { reply: r.summary, actions };
  }
  if (/(apaga|apagar|shutdown)/.test(t)) {
    return confirm('power', { action: 'shutdown' });
  }
  if (/(reinicia|reiniciar|restart)/.test(t)) {
    return confirm('power', { action: 'restart' });
  }
  if (/(suspende|suspender|hiberna)/.test(t)) {
    const r = await run('power', { action: 'sleep' });
    return { reply: r.summary, actions };
  }

  /* Sistema */
  if (/(ram|memoria|procesador|cpu|bateria|batería|sistema|windows|disco)/.test(t) && /(cuanta|cuánta|como esta|estado|info|que)/.test(t)) {
    const r = await run('system_info', {});
    return { reply: r.summary, actions };
  }

  /* Crear carpeta */
  const mkFolder = tc.match(/^(?:crea|crear|creame|haz|hazme)\s+(?:una\s+|un\s+)?carpeta\s*(?:llamada|nombrada|de nombre)?\s*(.+)$/i);
  if (mkFolder) {
    const loc = matchLocation(t);
    const name = stripLocation(mkFolder[1]).replace(/^(llamada|nombrada)\s+/i, '');
    const target = loc ? `${loc}/${name}` : name;
    const r = await run('create_folder', { path: target });
    return { reply: r.summary, actions };
  }

  /* Crear archivo */
  const mkFile = tc.match(/^(?:crea|crear|creame|haz|hazme)\s+(?:un\s+|una\s+)?(?:archivo|fichero|nota|documento)\s*(?:llamado|llamada|de nombre)?\s*(.+)$/i);
  if (mkFile) {
    const loc = matchLocation(t);
    let rest = stripLocation(mkFile[1]).replace(/^(llamado|llamada)\s+/i, '');
    let content = '';
    const withContent = rest.split(/\s+con\s+(?:el\s+)?(?:texto|contenido)\s+/i);
    if (withContent.length > 1) {
      rest = withContent[0];
      content = withContent.slice(1).join(' ');
    }
    const target = loc ? `${loc}/${rest}` : rest;
    const r = await run('create_file', { path: target, content });
    return { reply: r.summary, actions };
  }

  /* Listar carpeta */
  if (/(que hay en|qué hay en|lista|listar|muestra|contenido de)\b/.test(t) || /^(lista|listar)$/.test(t)) {
    const loc = matchLocation(t);
    let p = loc || 'Escritorio';
    const m = tc.match(/(?:en|de)\s+(?:la\s+|el\s+)?carpeta\s+(.+)$/i);
    if (m) p = m[1];
    const r = await run('list_dir', { path: p });
    return { reply: r.summary, actions };
  }

  /* Buscar archivos */
  const findFiles = tc.match(/(?:busca|buscar|encuentra|encontrar)\s+(?:el\s+|la\s+|los\s+|las\s+)?(?:archivo|fichero|carpeta)\s+(.+)$/i);
  if (findFiles) {
    const r = await run('search_files', { query: findFiles[1] });
    return { reply: r.summary, actions };
  }

  /* Eliminar */
  const del = tc.match(/^(?:elimina|borra|quita)\s+(?:el\s+|la\s+|los\s+|las\s+)?(?:archivo\s+|carpeta\s+)?(.+)$/i);
  if (del && !/portapapeles/.test(t)) {
    return confirm('delete_path', { path: del[1] });
  }

  /* Reproducir */
  const play = tc.match(/^(?:reproduce|reproducir|pon|poner|escucha|escuchar|quiero escuchar|quiero oir|quiero oír)\s+(.+)$/i);
  if (play) {
    let q = play[1]
      .replace(/^(la |el |unas |unos |mis )?(musica|música|video|vídeo|playlist|cancion|canción)\s+(de\s+)?/i, '')
      .replace(/\s+en (youtube|spotify)\s*$/i, '')
      .trim();

    if (/\.(mp3|m4a|wav|flac|ogg|aac|wma|mp4|mkv|avi|mov|webm|wmv|m4v)$/i.test(q)) {
      const r = await run('play_media', { query: q });
      return { reply: r.summary, actions };
    }

    const platform = /spotify/.test(t) ? 'spotify' : 'youtube';
    const r = await run('play_video', { query: q, platform });
    return { reply: r.summary, actions };
  }

  /* Abrir */
  const open = tc.match(/^(?:abre|abrir|abreme|abrime|lanza|lanzar|inicia|iniciar|ejecuta)\s+(.+)$/i);
  if (open) {
    let target = cleanTarget(open[1]);

    const settingsTarget = target.match(/^(?:la\s+)?(?:configuracion|configuración|ajustes)\s+(?:de\s+)?(.+)$/i);
    if (settingsTarget) {
      const r = await run('open_settings', { page: settingsTarget[1] });
      return { reply: r.summary, actions };
    }

    if (/carpeta/i.test(target)) {
      const p = target.replace(/^(la |el )?(carpeta)\s+(de\s+)?/i, '');
      const r = await run('open_folder', { path: p });
      return { reply: r.summary, actions };
    }
    if (/^(el |la )?(archivo|documento|fichero)\s+/i.test(target)) {
      const p = target.replace(/^(el |la )?(archivo|documento|fichero)\s+/i, '');
      const r = await run('open_file', { path: p });
      return { reply: r.summary, actions };
    }
    if (/^(https?:\/\/|www\.)|\.[a-z]{2,4}(\/|$)/i.test(target)) {
      const r = await run('open_url', { url: target });
      return { reply: r.summary, actions };
    }
    if (SITE_MAP[target.toLowerCase()]) {
      const r = await run('open_url', { url: SITE_MAP[target.toLowerCase()] });
      return { reply: r.summary, actions };
    }
    const r = await run('open_app', { app: target });
    return { reply: r.summary, actions };
  }

  /* Buscar aplicaciones */
  const appSearch = tc.match(/^(?:busca|buscar|encuentra)\s+(?:la\s+|el\s+)?(?:app|aplicacion|aplicación|programa)\s+(.+)$/i);
  if (appSearch) {
    const r = await run('list_apps', { query: appSearch[1] });
    return { reply: r.summary, actions };
  }

  /* Buscar en la web */
  const webSearch = tc.match(/^(?:busca|buscar|googlea|consulta)\s+(.+)$/i);
  if (webSearch) {
    const q = webSearch[1];
    if (/youtube/i.test(q)) {
      const r = await run('play_video', { query: q.replace(/\s+en youtube\s*$/i, '') });
      return { reply: r.summary, actions };
    }
    const r = await run('open_url', { url: `https://www.google.com/search?q=${encodeURIComponent(q)}` });
    return { reply: `Buscando «${q}» en Google.`, actions };
  }

  /* Ajustes */
  const settings = tc.match(/(?:abre|abrir|ve a|entra en)\s+(?:la\s+)?(?:configuracion|configuración|ajustes)\s+(?:de\s+)?(.+)$/i);
  if (settings) {
    const r = await run('open_settings', { page: settings[1] });
    return { reply: r.summary, actions };
  }

  /* Ventanas */
  if (/(que ventanas|ventanas abiertas|lista.*ventanas)/.test(t)) {
    const r = await run('window', { action: 'list' });
    return { reply: r.summary, actions };
  }
  const winAction = tc.match(/^(minimiza|minimizar|maximiza|maximizar)\s+(?:la\s+)?(?:ventana\s+)?(.+)$/i);
  if (winAction) {
    const action = winAction[1].toLowerCase().startsWith('min') ? 'minimize' : 'maximize';
    const r = await run('window', { action, title: winAction[2] });
    return { reply: r.summary, actions };
  }

  /* Cerrar aplicaciones */
  const closeApp = tc.match(/^(cierra|cerrar|mata|termina)\s+(?:la\s+)?(?:app\s+|aplicacion\s+|aplicación\s+|programa\s+)?(.+)$/i);
  if (closeApp && !/ventana/i.test(t)) {
    return confirm('process', { action: 'kill', name: closeApp[2] });
  }

  /* Red, clima, discos y procesos */
  if (/(mi ip|direccion ip|dirección ip|cual es mi ip|que wifi|red wifi)/.test(t)) {
    const r = await run('network_info', {});
    return { reply: r.summary, actions };
  }
  if (/(clima|que tiempo|el tiempo)/.test(t)) {
    const city = (tc.match(/(?:en|de)\s+([a-záéíóúñü\s]+)$/i) || [])[1] || '';
    const r = await run('weather', { city: city.trim() });
    return { reply: r.summary, actions };
  }
  if (/(discos|unidades|espacio libre|cuanto espacio)/.test(t)) {
    const r = await run('list_drives', {});
    return { reply: r.summary, actions };
  }
  if (/(lista.*procesos|que procesos|procesos abiertos)/.test(t)) {
    const r = await run('process', { action: 'list' });
    return { reply: r.summary, actions };
  }

  /* Papelera */
  if (/(vacia|vaciar|limpia).*(papelera)/.test(t)) {
    return confirm('empty_recycle_bin', {});
  }

  /* Archivos */
  const readFile = tc.match(/^(lee|leer)\s+(?:el\s+|la\s+)?(?:archivo\s+|documento\s+|fichero\s+)?(.+)$/i);
  if (readFile && !/portapapeles/i.test(t)) {
    const r = await run('read_file', { path: readFile[2] });
    return { reply: r.summary, actions };
  }

  const zip = tc.match(/^comprime\s+(.+)$/i);
  if (zip) {
    const r = await run('archive', { action: 'zip', path: zip[1] });
    return { reply: r.summary, actions };
  }

  const unzip = tc.match(/^descomprime\s+(.+)$/i);
  if (unzip) {
    const r = await run('archive', { action: 'unzip', path: unzip[1] });
    return { reply: r.summary, actions };
  }

  const fileOp = tc.match(/^(copia|mueve|renombra)\s+(.+?)\s+(?:a|en)\s+(.+)$/i);
  if (fileOp) {
    const map = { copia: 'copy', mueve: 'move', renombra: 'rename' };
    const r = await run('file_operation', {
      action: map[fileOp[1].toLowerCase()],
      from: fileOp[2],
      to: fileOp[3],
    });
    return { reply: r.summary, actions };
  }

  const download = tc.match(/^descarga(?:r)?\s+(https?:\/\/\S+)/i);
  if (download) {
    const r = await run('download_file', { url: download[1] });
    return { reply: r.summary, actions };
  }

  /* Teclado y brillo */
  const typing = tc.match(/^(escribe|escribir)\s+(.+)$/i);
  if (typing) {
    const r = await run('type_text', { text: typing[2] });
    return { reply: r.summary, actions };
  }

  const brightness = t.match(/brillo.*?(\d{1,3})/);
  if (brightness) {
    const r = await run('brightness', { level: Number(brightness[1]) });
    return { reply: r.summary, actions };
  }

  return {
    reply:
      'Estoy en modo local y no entendí ese comando. Prueba con «abre Spotify», «reproduce música lo-fi», «crea una carpeta Proyectos» o configura una IA en Ajustes para hablar libremente.',
    actions,
  };
}

/* ------------------------------------------------------------------ */
/* Entrada principal                                                   */
/* ------------------------------------------------------------------ */

async function respond({ text, history = [], config }) {
  const ai = aiResolved();

  if (ai.provider === 'gemini-live') {
    return {
      reply: 'Estoy en modo Gemini Live. Habla por el micrófono o escribe aquí para hablar conmigo en tiempo real.',
      actions: [],
      liveRequired: true,
    };
  }

  if (ai.key) {
    if (ai.provider === 'gemini') return askGemini(text, history, ai);
    if (ai.provider === 'anthropic') return askAnthropic(text, history, ai);
    return askOpenAICompatible(text, history, ai);
  }

  const result = await localBrain(text);
  if (!result.actions.length && !result.pending) {
    result.noKey = true;
  }
  return result;
}

const AFFIRMATIVE = /^(s[ií](?:\s|,|$)|claro\b|dale\b|ok(?:ay)?\b|vale\b|adelante\b|confirmo\b|confirmado\b|hazlo\b|por supuesto\b|correcto\b|yes\b)/i;
const NEGATIVE = /^(no(?:\s|,|$)|cancelar\b|cancela\b|mejor no\b|olvidalo\b|olvídalo\b)/i;

async function executePending(pending, config) {
  const result = await executeTool(pending.name, pending.args);
  return {
    reply: result.summary,
    actions: [{ name: pending.name, label: TOOL_LABELS[pending.name] || pending.name, ok: result.ok, summary: result.summary }],
  };
}

module.exports = {
  respond,
  executePending,
  testProvider,
  confirmationText,
  AFFIRMATIVE,
  NEGATIVE,
  systemPrompt,
  nowInfo,
  folders,
};
