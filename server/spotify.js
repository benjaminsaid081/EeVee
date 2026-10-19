'use strict';

/**
 * Integración con Spotify:
 * - Búsqueda de canciones/álbumes/artistas/playlists mediante Spotify Web API (Client Credentials o iTunes fallback).
 * - Reproducción silenciosa en segundo plano en la app de Windows de Spotify:
 *   1. Lanza el protocolo spotify:<tipo>:<id> con inicio en segundo plano minimizado
 *   2. Envía pulsación multimedia playpause si está en pausa para asegurar arranque sin foco
 */

const https = require('node:https');
const { execFile } = require('node:child_process');
const path = require('node:path');
const { config, saveConfig } = require('./config');

const SCRIPTS = path.join(__dirname, 'scripts');
const POWERSHELL = 'powershell.exe';
const SPOTIFY_TOKEN_URL = 'https://accounts.spotify.com/api/token';
const SPOTIFY_API = 'https://api.spotify.com/v1';
const SPOTIFY_AUTHORIZE_URL = 'https://accounts.spotify.com/authorize';
const SPOTIFY_SCOPES =
  'user-modify-playback-state user-read-playback-state user-read-currently-playing';

let spotifyToken = null;
let spotifyTokenExpiresAt = 0;
let userToken = null;
let userTokenExpiresAt = 0;

function spotifyCredentials() {
  return {
    clientId: config.spotifyClientId || process.env.SPOTIFY_CLIENT_ID || '',
    clientSecret: config.spotifyClientSecret || process.env.SPOTIFY_CLIENT_SECRET || '',
  };
}

function basicAuthorization(clientId, clientSecret) {
  return `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`;
}

function clearUserToken() {
  userToken = null;
  userTokenExpiresAt = 0;
}

function clearUserAuth() {
  clearUserToken();
  saveConfig({ spotifyRefreshToken: '' });
}

/** Obtiene token de acceso anónimo de aplicación (Client Credentials Flow) si el usuario configuró Client ID y Secret */
async function getSpotifyToken() {
  const clientId = config.spotifyClientId || process.env.SPOTIFY_CLIENT_ID;
  const clientSecret = config.spotifyClientSecret || process.env.SPOTIFY_CLIENT_SECRET;

  if (!clientId || !clientSecret) return null;
  if (spotifyToken && Date.now() < spotifyTokenExpiresAt - 60000) {
    return spotifyToken;
  }

  const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const postData = 'grant_type=client_credentials';

  return new Promise((resolve) => {
    const req = https.request(
      'https://accounts.spotify.com/api/token',
      {
        method: 'POST',
        headers: {
          Authorization: `Basic ${auth}`,
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
              spotifyToken = data.access_token;
              spotifyTokenExpiresAt = Date.now() + (data.expires_in || 3600) * 1000;
              resolve(spotifyToken);
            } else {
              resolve(null);
            }
          } catch {
            resolve(null);
          }
        });
      }
    );
    req.on('error', () => resolve(null));
    req.write(postData);
    req.end();
  });
}

/**
 * Token de usuario (OAuth). Es el único que puede cambiar la reproducción
 * activa mediante la Web API. Se refresca solo usando el refresh token.
 */
async function getUserAccessToken() {
  const { clientId, clientSecret } = spotifyCredentials();
  const refreshToken = config.spotifyRefreshToken || process.env.SPOTIFY_REFRESH_TOKEN || '';

  if (!clientId || !clientSecret || !refreshToken) return null;
  if (userToken && Date.now() < userTokenExpiresAt - 60000) return userToken;

  try {
    const response = await fetch(SPOTIFY_TOKEN_URL, {
      method: 'POST',
      headers: {
        Authorization: basicAuthorization(clientId, clientSecret),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      }),
      signal: AbortSignal.timeout(12000),
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.access_token) {
      console.warn(
        '[EV Spotify] No pude refrescar el token de usuario:',
        data.error_description || data.error || response.status
      );
      return null;
    }

    userToken = data.access_token;
    userTokenExpiresAt = Date.now() + (data.expires_in || 3600) * 1000;
    if (data.refresh_token && data.refresh_token !== refreshToken) {
      saveConfig({ spotifyRefreshToken: data.refresh_token });
    }
    return userToken;
  } catch (err) {
    console.warn('[EV Spotify] Error de red al refrescar el token:', err.message);
    return null;
  }
}

function buildSpotifyAuthUrl(redirectUri, state) {
  const { clientId } = spotifyCredentials();
  if (!clientId) throw new Error('Falta el Spotify Client ID en Ajustes.');

  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: redirectUri,
    scope: SPOTIFY_SCOPES,
    state,
    show_dialog: 'true',
  });
  return `${SPOTIFY_AUTHORIZE_URL}?${params.toString()}`;
}

async function exchangeSpotifyCode(code, redirectUri) {
  const { clientId, clientSecret } = spotifyCredentials();
  if (!clientId || !clientSecret) {
    throw new Error('Faltan el Client ID o el Client Secret de Spotify en Ajustes.');
  }

  const response = await fetch(SPOTIFY_TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: basicAuthorization(clientId, clientSecret),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
    }),
    signal: AbortSignal.timeout(15000),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.access_token) {
    throw new Error(
      data.error_description || data.error || 'Spotify rechazó la autorización.'
    );
  }

  if (!data.refresh_token) {
    throw new Error('Spotify no devolvió un refresh token. Vuelve a autorizar la app.');
  }

  saveConfig({ spotifyRefreshToken: data.refresh_token });
  userToken = data.access_token;
  userTokenExpiresAt = Date.now() + (data.expires_in || 3600) * 1000;
  return { ok: true };
}

async function getSpotifyDevices(token) {
  const response = await fetch(`${SPOTIFY_API}/me/player/devices`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(10000),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(
      data?.error?.message || `Spotify ${response.status} al consultar dispositivos.`
    );
  }
  return Array.isArray(data.devices) ? data.devices : [];
}

/** Cambia la reproducción activa usando la Web API (sin tocar la ventana). */
async function playUriWithUserToken(uri, type) {
  const token = await getUserAccessToken();
  if (!token) return { ok: false, reason: 'no-auth' };

  let devices;
  try {
    devices = await getSpotifyDevices(token);
  } catch (err) {
    return { ok: false, reason: 'error', error: err.message };
  }

  // Preferir el equipo de escritorio para que la música suene en el PC,
  // aunque el móvil sea el dispositivo activo en ese momento.
  const computers = devices.filter(
    (item) => !item.is_restricted && String(item.type || '').toLowerCase() === 'computer'
  );
  const device =
    computers.find((item) => item.is_active) ||
    computers[0] ||
    devices.find((item) => item.is_active && !item.is_restricted) ||
    devices.find((item) => !item.is_restricted) ||
    devices[0];

  if (!device) return { ok: false, reason: 'no-device' };

  const body = type === 'track' ? { uris: [uri] } : { context_uri: uri };
  const url = `${SPOTIFY_API}/me/player/play?device_id=${encodeURIComponent(device.id)}`;

  let response;
  try {
    response = await fetch(url, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(12000),
    });
  } catch (err) {
    return { ok: false, reason: 'error', error: err.message };
  }

  if (response.status === 204) {
    return { ok: true, device: device.name || device.id };
  }

  const raw = await response.text().catch(() => '');
  let detail = raw;
  try {
    detail = JSON.parse(raw)?.error?.message || raw;
  } catch {}

  return {
    ok: false,
    reason: response.status === 404 ? 'no-device' : 'error',
    error: String(detail || `Spotify ${response.status}`).slice(0, 300),
  };
}

function inferUriType(uri) {
  if (uri.startsWith('spotify:track:')) return 'track';
  if (uri.startsWith('spotify:album:')) return 'album';
  if (uri.startsWith('spotify:playlist:')) return 'playlist';
  if (uri.startsWith('spotify:artist:')) return 'artist';
  return 'track';
}

async function playSpotifyUri(uri, type) {
  return playUriWithUserToken(uri, type || inferUriType(uri));
}

/** Busca en la API de Spotify un track/artist/playlist/album */
async function searchSpotifyApi(query, token) {
  return new Promise((resolve) => {
    const url = `https://api.spotify.com/v1/search?q=${encodeURIComponent(query)}&type=track,artist,playlist,album&limit=1`;
    const req = https.get(
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
            const track = data.tracks?.items?.[0];
            if (track) {
              return resolve({
                name: track.name,
                artist: track.artists?.map((a) => a.name).join(', '),
                uri: track.uri,
                type: 'track',
                url: track.external_urls?.spotify,
              });
            }
            const artist = data.artists?.items?.[0];
            if (artist) {
              return resolve({
                name: artist.name,
                uri: artist.uri,
                type: 'artist',
                url: artist.external_urls?.spotify,
              });
            }
            const playlist = data.playlists?.items?.[0];
            if (playlist) {
              return resolve({
                name: playlist.name,
                uri: playlist.uri,
                type: 'playlist',
                url: playlist.external_urls?.spotify,
              });
            }
            const album = data.albums?.items?.[0];
            if (album) {
              return resolve({
                name: album.name,
                artist: album.artists?.map((a) => a.name).join(', '),
                uri: album.uri,
                type: 'album',
                url: album.external_urls?.spotify,
              });
            }
            resolve(null);
          } catch {
            resolve(null);
          }
        });
      }
    );
    req.on('error', () => resolve(null));
  });
}

/** Fallback sin credenciales API: obtiene metadatos limpios y busca reproducir el URI o búsqueda directa */
async function searchFallback(query) {
  return new Promise((resolve) => {
    const url = `https://itunes.apple.com/search?term=${encodeURIComponent(query)}&entity=song&limit=1`;
    https.get(url, { timeout: 8000 }, (res) => {
      let raw = '';
      res.on('data', (c) => (raw += c));
      res.on('end', () => {
        try {
          const data = JSON.parse(raw);
          const first = data.results?.[0];
          if (first) {
            resolve({
              name: first.trackName,
              artist: first.artistName,
              query: `${first.trackName} ${first.artistName}`,
            });
          } else {
            resolve({ query });
          }
        } catch {
          resolve({ query });
        }
      });
    }).on('error', () => resolve({ query }));
  });
}

function runSpotifyScript(args, timeout = 30000) {
  if (process.env.EV_NO_OPEN === '1') return Promise.resolve({ ok: true, skipped: true });

  return new Promise((resolve) => {
    execFile(
      POWERSHELL,
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        path.join(SCRIPTS, 'spotify-bg.ps1'),
        ...args,
      ],
      { windowsHide: true, timeout },
      (error, stdout, stderr) => {
        const line = String(stdout || '').trim().split(/\r?\n/).pop();
        let data = null;
        try {
          data = JSON.parse(line);
        } catch {}

        if (data && data.ok) {
          resolve(data);
          return;
        }

        const detail = String(stderr || '').trim() || (error && error.message) || '';
        resolve({
          ok: false,
          error: (data && data.error) || detail || 'No pude reproducir en Spotify.',
        });
      }
    );
  });
}

/**
 * Reproduce una URI de Spotify en segundo plano (modo de respaldo sin OAuth).
 * El script arranca Spotify minimizado si hace falta, oculta su ventana y
 * evita enviar un play/pause ciego.
 */
async function launchSpotifySilent(uriOrSearch) {
  const result = await runSpotifyScript(['-Uri', String(uriOrSearch)]);
  return { ...result, uri: String(uriOrSearch) };
}

/** Arranca Spotify minimizado, sin enviar ninguna canción. */
async function startSpotifySilent() {
  return runSpotifyScript(['-StartOnly'], 20000);
}

function itemTitle(item) {
  return item.artist ? `«${item.name}» de ${item.artist}` : `«${item.name}»`;
}

function fallbackHint(reason) {
  if (reason === 'no-auth') {
    return 'Conecta tu cuenta en Ajustes → Spotify para cambiar de canción sin ventana.';
  }
  if (reason === 'no-device') {
    return 'Abre Spotify y reproduce algo una vez para registrar el dispositivo, o conecta tu cuenta en Ajustes → Spotify.';
  }
  return 'Conecta tu cuenta en Ajustes → Spotify para controlar la reproducción.';
}

/** Intenta la Web API y, si no hay dispositivo, arranca Spotify y reintenta. */
async function playWithApiOrStart(item) {
  let result = await playSpotifyUri(item.uri, item.type);

  if (!result.ok && result.reason === 'no-device') {
    await startSpotifySilent();
    await new Promise((resolve) => setTimeout(resolve, 1500));
    result = await playSpotifyUri(item.uri, item.type);
  }

  if (!result.ok && result.reason !== 'no-auth') {
    console.warn(
      '[EV Spotify] No pude cambiar la reproducción por API:',
      result.reason,
      result.error || ''
    );
  }

  return result;
}

/** Método principal para reproducir música en Spotify */
async function playSpotify(query) {
  const q = String(query || '').trim();
  if (!q) throw new Error('No indicaste qué música reproducir.');

  // Si ya es un URI de Spotify
  if (q.startsWith('spotify:')) {
    const item = { name: q, uri: q, type: inferUriType(q) };
    const api = await playWithApiOrStart(item);
    if (api.ok) {
      return {
        ok: true,
        summary: 'Reproduciendo en Spotify.',
        uri: q,
        via: 'api',
        device: api.device,
      };
    }

    const launch = await launchSpotifySilent(q);
    if (!launch.ok) throw new Error(launch.error);
    return {
      ok: true,
      summary: 'Envié la canción a Spotify en segundo plano.',
      uri: q,
      via: 'uri',
      hint: fallbackHint(api.reason),
    };
  }

  // 1. Buscar con la API oficial (Client Credentials)
  const token = await getSpotifyToken();
  if (token) {
    const item = await searchSpotifyApi(q, token);
    if (item && item.uri) {
      const api = await playWithApiOrStart(item);
      if (api.ok) {
        return {
          ok: true,
          summary: `Reproduciendo ${itemTitle(item)} en Spotify.`,
          item,
          via: 'api',
          device: api.device,
        };
      }

      // Respaldo sin OAuth: puede abrir la canción, pero Spotify no la reproduce
      // si ya había otra sonando. Se avisa para que el usuario conecte su cuenta.
      const launch = await launchSpotifySilent(item.uri);
      if (!launch.ok) throw new Error(launch.error);
      return {
        ok: true,
        summary:
          api.reason === 'no-auth'
            ? `Envié ${itemTitle(item)} a Spotify. Conecta tu cuenta en Ajustes → Spotify para poder cambiar de canción.`
            : `Envié ${itemTitle(item)} a Spotify.`,
        item,
        via: 'uri',
        hint: fallbackHint(api.reason),
        apiError: api.error || null,
      };
    }
  }

  // 2. Modo respaldo: metadatos + búsqueda en Spotify
  const metadata = await searchFallback(q);
  const searchTerm = metadata.artist ? `${metadata.name} ${metadata.artist}` : (metadata.query || q);
  const uri = `spotify:search:${encodeURIComponent(searchTerm)}`;

  const launch = await launchSpotifySilent(uri);
  if (!launch.ok) throw new Error(launch.error);
  return {
    ok: true,
    summary: `Abrí «${searchTerm}» en Spotify en segundo plano.`,
    searchTerm,
    via: 'uri',
    hint: 'Conecta tu cuenta en Ajustes → Spotify para reproducir canciones concretas automáticamente.',
  };
}

module.exports = {
  playSpotify,
  getSpotifyToken,
  getUserAccessToken,
  getSpotifyDevices,
  buildSpotifyAuthUrl,
  exchangeSpotifyCode,
  clearUserToken,
  clearUserAuth,
};
