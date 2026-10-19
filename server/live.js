'use strict';

/**
 * Puente con Gemini Live API (bidiGenerateContent).
 * El modelo escucha audio en tiempo real, responde con voz y puede usar las
 * herramientas de EV (abrir apps, crear carpetas, etc.).
 */

const { WebSocketServer, WebSocket } = require('ws');
const { config } = require('./config');
const { TOOL_DEFS, TOOL_LABELS, executeTool, requiresConfirmation } = require('./tools');
const { systemPrompt, confirmationText } = require('./brain');

const DEFAULT_LIVE_URL =
  'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';

function liveUrl(key) {
  const base = process.env.GEMINI_LIVE_URL || DEFAULT_LIVE_URL;
  const separator = base.includes('?') ? '&' : '?';
  return `${base}${separator}key=${encodeURIComponent(key)}`;
}

function liveModel() {
  return String(config.aiModels['gemini-live'] || 'gemini-3.8-live').replace(/^models\//, '');
}

function setupMessage() {
  return {
    setup: {
      model: `models/${liveModel()}`,
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName: config.geminiVoice || 'Kore' },
          },
        },
      },
      systemInstruction: { parts: [{ text: systemPrompt() }] },
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      tools: [
        {
          functionDeclarations: TOOL_DEFS.map((tool) => ({
            name: tool.function.name,
            description: tool.function.description,
            parameters: tool.function.parameters,
          })),
        },
      ],
    },
  };
}

function send(client, payload) {
  if (client.readyState === WebSocket.OPEN) {
    client.send(JSON.stringify(payload));
  }
}

function broadcastStopScreen() {
  if (!liveServer) return;
  for (const client of liveServer.clients) {
    send(client, { type: 'stopScreen' });
  }
}

let liveServer = null;

function attachLive(server) {
  const wss = new WebSocketServer({ noServer: true });
  liveServer = wss;

  server.on('upgrade', (req, socket, head) => {
    let pathname = '';
    try {
      pathname = new URL(req.url, 'http://127.0.0.1').pathname;
    } catch {
      pathname = '';
    }

    if (pathname !== '/api/live') {
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (client) => wss.emit('connection', client));
  });

  wss.on('connection', (client) => startSession(client));
  return wss;
}

function startSession(client) {
  const key = config.aiKeys.gemini;

  if (!key) {
    send(client, { type: 'error', message: 'Falta tu clave de Gemini. Añádela en Ajustes.' });
    client.close();
    return;
  }

  const upstream = new WebSocket(liveUrl(key));
  const pendingAudio = [];
  const pendingText = [];
  const confirmations = new Map();

  let ready = false;
  let finished = false;

  const shutdown = (payload) => {
    if (finished) return;
    finished = true;
    if (payload) send(client, payload);
    try {
      upstream.close();
    } catch {}
    try {
      client.close();
    } catch {}
  };

  upstream.on('open', () => {
    upstream.send(JSON.stringify(setupMessage()));
  });

  upstream.on('message', (data) => {
    let message;
    try {
      message = JSON.parse(data.toString());
    } catch {
      return;
    }

    if (message.setupComplete) {
      ready = true;
      send(client, { type: 'ready', model: liveModel(), voice: config.geminiVoice || 'Kore' });
      for (const payload of pendingAudio.splice(0)) upstream.send(payload);
      for (const text of pendingText.splice(0)) sendText(text);
      return;
    }

    if (message.error) {
      send(client, {
        type: 'error',
        message: message.error.message || 'Gemini Live devolvió un error.',
      });
      return;
    }

    const content = message.serverContent;
    if (content) {
      if (content.inputTranscription?.text) {
        send(client, { type: 'userText', text: content.inputTranscription.text });
      }
      if (content.outputTranscription?.text) {
        send(client, { type: 'assistantText', text: content.outputTranscription.text });
      }

      for (const part of content.modelTurn?.parts || []) {
        if (part.inlineData?.data) {
          send(client, {
            type: 'audio',
            data: part.inlineData.data,
            mimeType: part.inlineData.mimeType || 'audio/pcm;rate=24000',
          });
        }
      }

      if (content.interrupted) send(client, { type: 'interrupted' });
      if (content.turnComplete) send(client, { type: 'turnComplete' });
    }

    if (message.toolCall?.functionCalls?.length) {
      console.log('[EV] Live toolCall:', message.toolCall.functionCalls.map((call) => call.name).join(', '));
      handleToolCalls(message.toolCall.functionCalls, upstream, client, confirmations).catch(() => {});
    }
  });

  upstream.on('error', (err) => {
    send(client, { type: 'error', message: `Gemini Live: ${err.message}` });
    shutdown();
  });

  upstream.on('close', (code, reason) => {
    if (!finished) {
      send(client, {
        type: 'closed',
        code,
        reason: String(reason || '').slice(0, 200),
      });
      shutdown();
    }
  });

  client.on('message', (raw, isBinary) => {
    if (isBinary) {
      sendAudio(raw);
      return;
    }

    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (message.type === 'audio' && message.data) {
      sendAudio(Buffer.from(message.data, 'base64'));
    } else if (message.type === 'screen' && message.data) {
      if (ready) {
        upstream.send(
          JSON.stringify({
            realtimeInput: { video: { mimeType: 'image/jpeg', data: message.data } },
          })
        );
      }
    } else if (message.type === 'text') {
      sendText(String(message.text || '').trim());
    } else if (message.type === 'activityStart' || message.type === 'activityEnd') {
      const payload = JSON.stringify({
        realtimeInput: message.type === 'activityStart' ? { activityStart: {} } : { activityEnd: {} },
      });
      if (ready) upstream.send(payload);
    } else if (message.type === 'confirmResult') {
      const resolve = confirmations.get(message.id);
      if (resolve) resolve(Boolean(message.approved));
    } else if (message.type === 'stop') {
      shutdown();
    }
  });

  client.on('close', () => {
    if (!finished) {
      finished = true;
      try {
        upstream.close();
      } catch {}
    }
  });

  function sendAudio(buffer) {
    if (!buffer || !buffer.length) return;

    const payload = JSON.stringify({
      realtimeInput: {
        audio: { data: buffer.toString('base64'), mimeType: 'audio/pcm;rate=16000' },
      },
    });

    if (ready) upstream.send(payload);
    else if (pendingAudio.length < 200) pendingAudio.push(payload);
  }

  function sendText(text) {
    if (!text) return;

    const payload = JSON.stringify({
      clientContent: {
        turns: [{ role: 'user', parts: [{ text }] }],
        turnComplete: true,
      },
    });

    if (ready) upstream.send(payload);
    else pendingText.push(text);
  }
}

async function handleToolCalls(calls, upstream, client, confirmations) {
  const responses = [];

  for (const call of calls) {
    const name = call.name;
    const args = call.args || {};
    let result;

    if (requiresConfirmation(name, args)) {
      const approved = await requestConfirmation(client, confirmations, call, name, args);
      result = approved
        ? await executeTool(name, args)
        : { ok: false, summary: 'El usuario canceló la acción.' };
    } else {
      result = await executeTool(name, args);
    }

    send(client, {
      type: 'tool',
      name,
      label: TOOL_LABELS[name] || name,
      ok: result.ok,
      summary: result.summary,
    });

    if (name === 'stop_actions') {
      send(client, { type: 'stopScreen' });
    }

    responses.push({
      id: call.id,
      name,
      response: { ok: result.ok, resultado: result.summary },
    });
  }

  if (upstream.readyState === WebSocket.OPEN) {
    upstream.send(JSON.stringify({ toolResponse: { functionResponses: responses } }));
  }
}

function requestConfirmation(client, confirmations, call, name, args) {
  return new Promise((resolve) => {
    const id = call.id || `confirm_${Date.now()}`;
    const timer = setTimeout(() => {
      confirmations.delete(id);
      resolve(false);
    }, 60000);

    confirmations.set(id, (approved) => {
      clearTimeout(timer);
      confirmations.delete(id);
      resolve(approved);
    });

    send(client, {
      type: 'confirm',
      id,
      name,
      args,
      text: confirmationText(name, args),
    });
  });
}

/** Comprueba que la clave y el modelo Live conectan (setupComplete). */
function testLiveConnection() {
  return new Promise((resolve) => {
    const key = config.aiKeys.gemini;
    if (!key) {
      resolve({ ok: false, provider: 'gemini-live', error: 'Falta la clave de Gemini.' });
      return;
    }

    const ws = new WebSocket(liveUrl(key));
    let done = false;

    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {}
      resolve(result);
    };

    const timer = setTimeout(
      () => finish({ ok: false, provider: 'gemini-live', error: 'Gemini Live no respondió a tiempo.' }),
      15000
    );

    ws.on('open', () => {
      ws.send(
        JSON.stringify({
          setup: {
            model: `models/${liveModel()}`,
            generationConfig: { responseModalities: ['AUDIO'] },
          },
        })
      );
    });

    ws.on('message', (data) => {
      let message;
      try {
        message = JSON.parse(data.toString());
      } catch {
        return;
      }

      if (message.setupComplete) {
        finish({ ok: true, provider: 'gemini-live', model: liveModel(), reply: 'conectado' });
      }
      if (message.error) {
        finish({
          ok: false,
          provider: 'gemini-live',
          error: message.error.message || 'Error de Gemini Live',
        });
      }
    });

    ws.on('error', (err) => finish({ ok: false, provider: 'gemini-live', error: err.message }));
  });
}

module.exports = { attachLive, broadcastStopScreen, testLiveConnection, liveModel };
