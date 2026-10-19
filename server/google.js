'use strict';

/**
 * Integración con Google Calendar / Google Tools:
 * - Consulta de eventos del día o próximos eventos.
 * - Creación de eventos / citas / recordatorios.
 * - Soporte para Google OAuth 2.0 (Client ID, Client Secret, Refresh Token).
 * - Enlace directo / acceso web rápido (Google Calendar Template URL) de respaldo.
 */

const https = require('node:https');
const { config, saveConfig } = require('./config');

const GOOGLE_AUTH_URL = 'https://oauth2.googleapis.com/token';
const CALENDAR_API_BASE = 'https://www.googleapis.com/calendar/v3';

let cachedAccessToken = null;
let tokenExpiresAt = 0;

/** Obtiene o refresca el token de acceso de Google mediante Refresh Token */
async function getGoogleAccessToken() {
  const clientId = config.googleClientId || process.env.GOOGLE_CLIENT_ID;
  const clientSecret = config.googleClientSecret || process.env.GOOGLE_CLIENT_SECRET;
  const refreshToken = config.googleRefreshToken || process.env.GOOGLE_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) return null;

  if (cachedAccessToken && Date.now() < tokenExpiresAt - 60000) {
    return cachedAccessToken;
  }

  const postData = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  }).toString();

  return new Promise((resolve) => {
    const req = https.request(
      GOOGLE_AUTH_URL,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(postData),
        },
        timeout: 10000,
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          try {
            const data = JSON.parse(raw);
            if (data.access_token) {
              cachedAccessToken = data.access_token;
              tokenExpiresAt = Date.now() + (data.expires_in || 3600) * 1000;
              resolve(cachedAccessToken);
            } else {
              console.warn('[EV Google] Error refrescando token:', data);
              resolve(null);
            }
          } catch {
            resolve(null);
          }
        });
      }
    );
    req.on('error', (err) => {
      console.warn('[EV Google] Error de red:', err.message);
      resolve(null);
    });
    req.write(postData);
    req.end();
  });
}

/** Intercambia un código de autorización recibido tras login OAuth por tokens */
async function exchangeGoogleCode(code, redirectUri) {
  const clientId = config.googleClientId || process.env.GOOGLE_CLIENT_ID;
  const clientSecret = config.googleClientSecret || process.env.GOOGLE_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error('Falta Google Client ID o Client Secret en Ajustes.');
  }

  const postData = new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
  }).toString();

  return new Promise((resolve, reject) => {
    const req = https.request(
      GOOGLE_AUTH_URL,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(postData),
        },
        timeout: 15000,
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          try {
            const data = JSON.parse(raw);
            if (data.access_token) {
              cachedAccessToken = data.access_token;
              tokenExpiresAt = Date.now() + (data.expires_in || 3600) * 1000;
              if (data.refresh_token) {
                saveConfig({ googleRefreshToken: data.refresh_token });
              }
              resolve({ ok: true, data });
            } else {
              reject(new Error(data.error_description || data.error || 'Error al autorizar con Google'));
            }
          } catch (e) {
            reject(e);
          }
        });
      }
    );
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

/** Consulta los próximos eventos del calendario */
async function listCalendarEvents(maxResults = 5) {
  const token = await getGoogleAccessToken();
  if (!token) {
    return {
      connected: false,
      summary: 'Google Calendar no está conectado. Puedes configurar tus credenciales en Ajustes o abrir el calendario web.',
    };
  }

  const now = new Date().toISOString();
  const url = `${CALENDAR_API_BASE}/calendars/primary/events?timeMin=${encodeURIComponent(now)}&maxResults=${maxResults}&singleEvents=true&orderBy=startTime`;

  return new Promise((resolve) => {
    https.get(
      url,
      {
        headers: { Authorization: `Bearer ${token}` },
        timeout: 10000,
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          try {
            const data = JSON.parse(raw);
            const items = data.items || [];
            if (!items.length) {
              return resolve({
                connected: true,
                events: [],
                summary: 'No tienes eventos próximos programados en tu Google Calendar.',
              });
            }

            const formatted = items.map((item) => {
              const start = item.start?.dateTime || item.start?.date || '';
              let startStr = start;
              try {
                const d = new Date(start);
                startStr = d.toLocaleDateString('es-ES', { weekday: 'short', day: 'numeric', month: 'short' }) + ' a las ' + d.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
              } catch {}
              return `${item.summary || 'Sin título'} (${startStr})`;
            });

            resolve({
              connected: true,
              events: items,
              summary: `Tus próximos eventos son: ${formatted.join(', ')}.`,
            });
          } catch (err) {
            resolve({ connected: true, summary: 'Error al interpretar los eventos de Google Calendar.' });
          }
        });
      }
    ).on('error', () => resolve({ connected: true, summary: 'No pude conectar con Google Calendar.' }));
  });
}

/** Crea un evento en el Google Calendar directamente con la API */
async function createCalendarEvent({ summary, description, start, end, location }) {
  const token = await getGoogleAccessToken();
  if (!token) {
    // Si no hay OAuth conectado, generamos el enlace directo listo para guardar
    return createQuickWebEvent({ summary, description, start, end, location });
  }

  const startDate = start ? new Date(start) : new Date(Date.now() + 3600000);
  const endDate = end ? new Date(end) : new Date(startDate.getTime() + 3600000);

  const eventPayload = {
    summary: summary || 'Nuevo evento con EV',
    description: description || 'Agendado mediante EV asistente personal.',
    location: location || '',
    start: { dateTime: startDate.toISOString() },
    end: { dateTime: endDate.toISOString() },
  };

  const postData = JSON.stringify(eventPayload);

  return new Promise((resolve) => {
    const req = https.request(
      `${CALENDAR_API_BASE}/calendars/primary/events`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData),
        },
        timeout: 10000,
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          try {
            const data = JSON.parse(raw);
            if (data.id) {
              const fecha = startDate.toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long' });
              const hora = startDate.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
              resolve({
                ok: true,
                connected: true,
                summary: `Evento «${data.summary}» agendado con éxito en tu Google Calendar para el ${fecha} a las ${hora}.`,
                htmlLink: data.htmlLink,
              });
            } else {
              resolve({
                ok: false,
                summary: 'Google no pudo guardar el evento. ' + (data.error?.message || ''),
              });
            }
          } catch {
            resolve({ ok: false, summary: 'Error al procesar la respuesta de Google Calendar.' });
          }
        });
      }
    );
    req.on('error', (err) => resolve({ ok: false, summary: 'No pude conectar con Google: ' + err.message }));
    req.write(postData);
    req.end();
  });
}

/** Acceso rápido web como alternativa o respaldo instantáneo */
function createQuickWebEvent({ summary, description, start, end, location }) {
  const startDate = start ? new Date(start) : new Date(Date.now() + 3600000);
  const endDate = end ? new Date(end) : new Date(startDate.getTime() + 3600000);

  const toGDate = (d) => d.toISOString().replace(/-|:|\.\d\d\d/g, '');
  const dates = `${toGDate(startDate)}/${toGDate(endDate)}`;

  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: summary || 'Cita',
    dates,
    details: description || 'Agendado con EV asistente',
  });
  if (location) params.set('location', location);

  const url = `https://calendar.google.com/calendar/render?${params.toString()}`;
  return {
    ok: true,
    connected: false,
    webUrl: url,
    summary: `He preparado el evento «${summary || 'Cita'}» para abrirlo en Google Calendar.`,
  };
}

module.exports = {
  getGoogleAccessToken,
  exchangeGoogleCode,
  listCalendarEvents,
  createCalendarEvent,
  createQuickWebEvent,
};
