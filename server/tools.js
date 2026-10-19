'use strict';

/**
 * Herramientas de control del PC para EV.
 * Todo pasa por una lista blanca de acciones. Nada de eval ni shell libre por defecto.
 */

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const { execFile } = require('node:child_process');
const { folders, config } = require('./config');
const vision = require('./vision');
const spotify = require('./spotify');
const google = require('./google');

const SCRIPTS = path.join(__dirname, 'scripts');
const POWERSHELL = 'powershell.exe';

/* ------------------------------------------------------------------ */
/* Utilidades                                                          */
/* ------------------------------------------------------------------ */

const stripAccents = (s) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');

function run(file, args, timeout = 20000) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ error, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

function runPowerShellFile(script, args = [], timeout = 30000) {
  return run(
    POWERSHELL,
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      path.join(SCRIPTS, script),
      ...args,
    ],
    timeout
  );
}

function runPowerShellCommand(command, timeout = 30000) {
  return run(POWERSHELL, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command], timeout);
}

async function openTarget(target) {
  // Permite probar las herramientas sin abrir ventanas reales.
  if (process.env.EV_NO_OPEN === '1') return { skipped: true };

  // cmd /c start "" <destino>  -> usa la aplicación predeterminada del sistema
  return run('cmd.exe', ['/c', 'start', '', target], 15000);
}

function displayPath(p) {
  if (!p) return '';
  const home = folders.home;
  if (p.toLowerCase().startsWith(home.toLowerCase())) {
    return '~' + p.slice(home.length);
  }
  return p;
}

const FOLDER_WORDS = {
  escritorio: 'desktop',
  desktop: 'desktop',
  documentos: 'documents',
  documents: 'documents',
  'mis documentos': 'documents',
  descargas: 'downloads',
  downloads: 'downloads',
  imagenes: 'pictures',
  pictures: 'pictures',
  fotos: 'pictures',
  musica: 'music',
  music: 'music',
  videos: 'videos',
  inicio: 'home',
  home: 'home',
  usuario: 'home',
  perfil: 'home',
};

/** Convierte "Escritorio/Proyectos" o "C:\ruta" en una ruta absoluta segura. */
function resolvePath(input) {
  let p = String(input ?? '').trim().replace(/^["']|["']$/g, '');
  if (!p) return folders.desktop;
  if (p.startsWith('~')) p = folders.home + p.slice(1);

  if (path.isAbsolute(p) || /^[A-Za-z]:[\\/]/.test(p)) return path.normalize(p);

  const parts = p.split(/[\\/]+/).filter(Boolean);
  const first = stripAccents(parts[0].toLowerCase());
  if (FOLDER_WORDS[first]) {
    return path.join(folders[FOLDER_WORDS[first]], ...parts.slice(1));
  }
  return path.join(folders.desktop, ...parts);
}

const APP_ALIASES = {
  chrome: 'chrome',
  google: 'chrome',
  navegador: 'chrome',
  edge: 'msedge',
  firefox: 'firefox',
  opera: 'opera',
  notepad: 'notepad',
  notapad: 'notepad',
  bloc: 'notepad',
  'bloc de notas': 'notepad',
  calculadora: 'ms-calculator:',
  calc: 'ms-calculator:',
  explorer: 'explorer',
  explorador: 'explorer',
  archivos: 'explorer',
  configuracion: 'ms-settings:',
  ajustes: 'ms-settings:',
  spotify: 'spotify:',
  vscode: 'code',
  code: 'code',
  'visual studio code': 'code',
  word: 'winword',
  excel: 'excel',
  powerpoint: 'powerpnt',
  paint: 'mspaint',
  cmd: 'cmd',
  consola: 'cmd',
  terminal: 'wt',
  powershell: 'powershell',
  camara: 'microsoft.windows.camera:',
  tienda: 'ms-windows-store:',
  store: 'ms-windows-store:',
  discord: 'discord:',
  whatsapp: 'whatsapp:',
  telegram: 'telegram:',
  steam: 'steam:',
  'administrador de tareas': 'taskmgr',
  taskmgr: 'taskmgr',
  reproductor: 'wmplayer',
};

/* ------------------------------------------------------------------ */
/* Definiciones para el modelo (function calling)                      */
/* ------------------------------------------------------------------ */

const TOOL_DEFS = [
  {
    type: 'function',
    function: {
      name: 'open_app',
      description: 'Abre una aplicación instalada en Windows (chrome, notepad, spotify, calculadora, word, etc.).',
      parameters: {
        type: 'object',
        properties: { app: { type: 'string', description: 'Nombre de la aplicación o ruta a un .exe' } },
        required: ['app'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'open_url',
      description: 'Abre una página web en el navegador predeterminado.',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string', description: 'URL completa, por ejemplo https://google.com' } },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'play_spotify',
      description: 'Reproduce o cambia la canción, artista, álbum o tipo de música directamente en Spotify en segundo plano, incluso si ya hay otra canción sonando, sin abrir la ventana del programa. Úsalo siempre que el usuario pida música o mencione Spotify.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Nombre de la canción, artista, álbum o género musical' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'play_video',
      description: 'Busca y reproduce un video o música en YouTube (o Spotify con platform="spotify"). Si el usuario pide música en Spotify o simplemente escuchar una canción, es preferible play_spotify.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Canción, video, artista o término de búsqueda' },
          platform: { type: 'string', enum: ['youtube', 'spotify'], description: 'Plataforma, por defecto youtube' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'google_calendar_list',
      description: 'Consulta los próximos eventos, citas y reuniones de tu agenda de Google Calendar.',
      parameters: {
        type: 'object',
        properties: {
          maxResults: { type: 'number', description: 'Número de eventos a consultar (por defecto 5)' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'google_calendar_create',
      description: 'Crea y agenda un nuevo evento, cita o recordatorio en tu Google Calendar.',
      parameters: {
        type: 'object',
        properties: {
          summary: { type: 'string', description: 'Título o nombre de la cita/evento' },
          start: { type: 'string', description: 'Fecha y hora de inicio (formato ISO o interpretable, ej. "2026-10-20T10:00:00")' },
          end: { type: 'string', description: 'Fecha y hora de fin (opcional, por defecto 1 hora después)' },
          description: { type: 'string', description: 'Detalles o notas adicionales del evento' },
          location: { type: 'string', description: 'Ubicación o lugar de la cita' },
        },
        required: ['summary'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_folder',
      description: 'Crea una carpeta. Si la ruta es relativa se crea en el Escritorio.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Nombre o ruta, ej. "Proyectos" o "Escritorio/EV/Notas"' } },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_file',
      description: 'Crea un archivo de texto con contenido opcional. Si no tiene extensión se usa .txt.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Nombre o ruta del archivo' },
          content: { type: 'string', description: 'Contenido del archivo' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_dir',
      description: 'Lista el contenido de una carpeta (Escritorio por defecto).',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Carpeta a listar' } },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_files',
      description: 'Busca archivos o carpetas por nombre en Escritorio, Documentos y Descargas.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Parte del nombre a buscar' },
          folder: { type: 'string', description: 'Carpeta concreta donde buscar (opcional)' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'open_folder',
      description: 'Abre una carpeta en el Explorador de Windows.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Carpeta a abrir' } },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_path',
      description: 'Envía un archivo o carpeta a la Papelera de reciclaje. Requiere confirmación del usuario.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Archivo o carpeta a eliminar' } },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'media_control',
      description: 'Controla la reproducción multimedia: pausar/reanudar, siguiente, anterior, detener.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['playpause', 'next', 'prev', 'stop'], description: 'Acción multimedia' },
        },
        required: ['action'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'volume',
      description: 'Sube, baja o silencia el volumen del sistema.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['up', 'down', 'mute'], description: 'Acción de volumen' },
          steps: { type: 'number', description: 'Cantidad de pasos (por defecto 5)' },
        },
        required: ['action'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'screenshot',
      description: 'Toma una captura de pantalla y la guarda en Imágenes/EV Capturas.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'clipboard',
      description: 'Lee o escribe el portapapeles de Windows.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['read', 'write'], description: 'Leer o escribir' },
          text: { type: 'string', description: 'Texto a copiar (solo para write)' },
        },
        required: ['action'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'system_info',
      description: 'Devuelve información del equipo: CPU, memoria, disco, versión de Windows, hora.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'open_settings',
      description: 'Abre una página de Configuración de Windows (bluetooth, wifi, pantalla, sonido, actualizaciones...).',
      parameters: {
        type: 'object',
        properties: {
          page: { type: 'string', description: 'Página: bluetooth, wifi, display, sound, update, apps, privacy, about, defaultapps' },
        },
        required: ['page'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'lock_pc',
      description: 'Bloquea la sesión de Windows (pantalla de bloqueo).',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'power',
      description: 'Apaga, reinicia o suspende el equipo. Requiere confirmación del usuario.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['shutdown', 'restart', 'sleep', 'cancel'], description: 'Acción de energía' },
        },
        required: ['action'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_shell',
      description: 'Ejecuta un comando de PowerShell avanzado. Solo si el usuario lo pide explícitamente y tras confirmar.',
      parameters: {
        type: 'object',
        properties: { command: { type: 'string', description: 'Comando de PowerShell a ejecutar' } },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_apps',
      description: 'Busca aplicaciones instaladas de Windows por nombre y devuelve coincidencias (útil si no sabes el nombre exacto).',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Parte del nombre de la aplicación' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'play_media',
      description: 'Reproduce un archivo de audio o vídeo que esté en Música, Vídeos, Descargas o Escritorio. Si no lo encuentra, busca en YouTube.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Nombre del archivo o canción' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'open_file',
      description: 'Abre un archivo o documento con su aplicación predeterminada.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Ruta o nombre del archivo' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'file_info',
      description: 'Devuelve tamaño, fechas y tipo de un archivo o carpeta.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Ruta del archivo o carpeta' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'file_operation',
      description: 'Copia, mueve o renombra archivos y carpetas.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['copy', 'move', 'rename'], description: 'Operación' },
          from: { type: 'string', description: 'Origen' },
          to: { type: 'string', description: 'Destino o nuevo nombre' },
        },
        required: ['action', 'from', 'to'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'archive',
      description: 'Comprime una carpeta o archivo en ZIP, o descomprime un ZIP.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['zip', 'unzip'], description: 'Comprimir o descomprimir' },
          path: { type: 'string', description: 'Archivo o carpeta a comprimir, o ZIP a descomprimir' },
          destination: { type: 'string', description: 'Destino (opcional)' },
        },
        required: ['action', 'path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Lee el contenido de un archivo de texto (máximo 4000 caracteres).',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Ruta del archivo' },
          lines: { type: 'number', description: 'Número máximo de líneas (opcional)' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_drives',
      description: 'Lista las unidades de disco con su espacio libre y total.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'process',
      description: 'Lista los procesos que más consumen o cierra un proceso por nombre.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'kill'], description: 'Listar o cerrar' },
          name: { type: 'string', description: 'Nombre del proceso (sin .exe) para cerrarlo' },
        },
        required: ['action'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'window',
      description: 'Lista, enfoca, minimiza, maximiza o cierra ventanas abiertas.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'focus', 'minimize', 'maximize', 'close'], description: 'Acción' },
          title: { type: 'string', description: 'Parte del título de la ventana' },
        },
        required: ['action'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'type_text',
      description: 'Escribe texto en la ventana que tenga el foco (teclado).',
      parameters: {
        type: 'object',
        properties: { text: { type: 'string', description: 'Texto a escribir' } },
        required: ['text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'press_keys',
      description: 'Pulsa combinaciones de teclas con el foco actual (formato SendKeys: "^c" copia, "%{TAB}" alt-tab, "{ENTER}").',
      parameters: {
        type: 'object',
        properties: { keys: { type: 'string', description: 'Secuencia SendKeys' } },
        required: ['keys'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'network_info',
      description: 'Muestra IP local, puerta de enlace y red WiFi conectada.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'weather',
      description: 'Consulta el tiempo actual de una ciudad (o del lugar detectado).',
      parameters: {
        type: 'object',
        properties: { city: { type: 'string', description: 'Ciudad (opcional)' } },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'empty_recycle_bin',
      description: 'Vacía la Papelera de reciclaje. Requiere confirmación.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_shortcut',
      description: 'Crea un acceso directo en el Escritorio.',
      parameters: {
        type: 'object',
        properties: {
          target: { type: 'string', description: 'Ruta del programa o archivo' },
          name: { type: 'string', description: 'Nombre del acceso directo' },
        },
        required: ['target', 'name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'download_file',
      description: 'Descarga un archivo de internet a tu PC.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'URL del archivo' },
          path: { type: 'string', description: 'Nombre o ruta de destino (opcional)' },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'brightness',
      description: 'Ajusta el brillo de la pantalla del portátil (0-100).',
      parameters: {
        type: 'object',
        properties: { level: { type: 'number', description: 'Brillo de 0 a 100' } },
        required: ['level'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'screen_info',
      description: 'Devuelve la resolución de la pantalla y los monitores conectados.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'look_at_screen',
      description: 'Mira la pantalla ahora mismo y responde sobre lo que hay en ella (leer campos, identificar ventanas, encontrar un botón).',
      parameters: {
        type: 'object',
        properties: {
          question: { type: 'string', description: 'Qué quieres saber de la pantalla' },
        },
        required: ['question'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'find_on_screen',
      description: 'Localiza un elemento en la pantalla por su descripción y devuelve sus coordenadas, sin hacer clic.',
      parameters: {
        type: 'object',
        properties: {
          target: { type: 'string', description: 'Descripción del elemento (ej. "campo de email")' },
        },
        required: ['target'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'click_on_screen',
      description: 'Toma una captura de pantalla instantánea en alta resolución, localiza con precisión el elemento visual descrito (botón, campo, enlace, icono, etc.) y hace clic en él. Siempre usa esta herramienta para hacer clic en elementos vistos en pantalla, en lugar de calcular coordenadas a mano.',
      parameters: {
        type: 'object',
        properties: {
          target: { type: 'string', description: 'Descripción detallada del elemento donde hacer clic (ej. "botón azul de Enviar", "icono de cerrar", "primer resultado de vídeo")' },
          button: { type: 'string', enum: ['left', 'right'], description: 'Botón del ratón (por defecto left)' },
        },
        required: ['target'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'type_into',
      description: 'Toma una captura instantánea, busca un campo de texto en la pantalla, hace clic en él para enfocarlo y escribe el texto indicado.',
      parameters: {
        type: 'object',
        properties: {
          target: { type: 'string', description: 'Descripción del campo (ej. "campo de email", "barra de búsqueda")' },
          text: { type: 'string', description: 'Texto a escribir' },
        },
        required: ['target', 'text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'mouse_click',
      description: 'Hace clic en unas coordenadas absolutas (x, y) de la pantalla. Si conoces el objetivo visualmente o estás usando Gemini Live, prefiere siempre click_on_screen con target descriptivo para que EV tome un screenshot y calcule la posición exacta.',
      parameters: {
        type: 'object',
        properties: {
          x: { type: 'number', description: 'Coordenada X en píxeles' },
          y: { type: 'number', description: 'Coordenada Y en píxeles' },
          target: { type: 'string', description: 'Opcional: Si se indica qué elemento es, EV tomará un screenshot para refinar y corregir la posición exacta antes de hacer clic.' },
          button: { type: 'string', enum: ['left', 'right'], description: 'Botón del ratón' },
        },
        required: ['x', 'y'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'scroll',
      description: 'Desplaza la pantalla arriba o abajo (una sola vez).',
      parameters: {
        type: 'object',
        properties: {
          direction: { type: 'string', enum: ['up', 'down'], description: 'Dirección' },
          amount: { type: 'number', description: 'Cantidad de desplazamiento (por defecto 120)' },
        },
        required: ['direction'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'auto_scroll',
      description: 'Empieza a desplazar la pantalla lentamente de forma continua, para explorar un feed. Se detiene con stop_actions o cuando el usuario lo pida.',
      parameters: {
        type: 'object',
        properties: {
          direction: { type: 'string', enum: ['up', 'down'], description: 'Dirección' },
          step: { type: 'number', description: 'Píxeles por paso (por defecto 120)' },
          intervalMs: { type: 'number', description: 'Milisegundos entre pasos (por defecto 350)' },
        },
        required: ['direction'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'stop_actions',
      description: 'Detiene el desplazamiento automático y cualquier acción continua en curso.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
];

const CONFIRM_TOOLS = new Set(['delete_path', 'run_shell', 'empty_recycle_bin']);

function requiresConfirmation(name, args = {}) {
  if (CONFIRM_TOOLS.has(name)) return true;
  if (name === 'power' && ['shutdown', 'restart'].includes(args.action)) return true;
  if (name === 'process' && args.action === 'kill') return true;
  return false;
}

const TOOL_LABELS = {
  open_app: 'Abrir app',
  open_url: 'Abrir web',
  play_spotify: 'Spotify',
  google_calendar_list: 'Google Calendar',
  google_calendar_create: 'Agendar cita',
  play_video: 'Reproducir',
  screen_info: 'Pantalla',
  look_at_screen: 'Mirar pantalla',
  find_on_screen: 'Buscar en pantalla',
  click_on_screen: 'Clic en pantalla',
  type_into: 'Escribir en pantalla',
  mouse_click: 'Clic',
  scroll: 'Desplazar',
  auto_scroll: 'Desplazar solo',
  stop_actions: 'Detener',
  play_media: 'Reproducir archivo',
  list_apps: 'Buscar apps',
  create_folder: 'Crear carpeta',
  create_file: 'Crear archivo',
  list_dir: 'Listar carpeta',
  search_files: 'Buscar archivos',
  open_folder: 'Abrir carpeta',
  open_file: 'Abrir archivo',
  file_info: 'Info archivo',
  file_operation: 'Archivos',
  archive: 'Comprimir',
  read_file: 'Leer archivo',
  list_drives: 'Discos',
  process: 'Procesos',
  window: 'Ventanas',
  type_text: 'Escribir',
  press_keys: 'Teclas',
  network_info: 'Red',
  weather: 'Clima',
  empty_recycle_bin: 'Papelera',
  create_shortcut: 'Acceso directo',
  download_file: 'Descargar',
  brightness: 'Brillo',
  delete_path: 'Eliminar',
  media_control: 'Multimedia',
  volume: 'Volumen',
  screenshot: 'Captura',
  clipboard: 'Portapapeles',
  system_info: 'Sistema',
  open_settings: 'Configuración',
  lock_pc: 'Bloquear',
  power: 'Energía',
  run_shell: 'Comando',
};

/* ------------------------------------------------------------------ */
/* Implementaciones                                                    */
/* ------------------------------------------------------------------ */

function ok(summary, extra = {}) {
  return { ok: true, summary, ...extra };
}
function fail(summary) {
  return { ok: false, summary };
}

const psQuote = (value) => String(value ?? '').replace(/'/g, "''");

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

async function callPowerShell(script) {
  return runPowerShellCommand(script, 40000);
}

const YTDLP = path.join(__dirname, '..', 'bin', 'yt-dlp.exe');
const TMP_DIR = path.join(__dirname, '..', '.tmp');
const ytCache = new Map();

function parseLastJson(text) {
  const lines = String(text || '')
    .trim()
    .split(/\r?\n/)
    .filter(Boolean);

  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      return JSON.parse(lines[i]);
    } catch {}
  }
  return null;
}

async function youtubeSearch(query) {
  const cacheKey = query.toLowerCase();
  const cached = ytCache.get(cacheKey);
  if (cached && Date.now() - cached.at < 10 * 60 * 1000) return cached.data;
  if (!fs.existsSync(YTDLP)) return null;

  fs.mkdirSync(TMP_DIR, { recursive: true });
  const found = await new Promise((resolve) => {
    execFile(
      YTDLP,
      ['ytsearch1:' + query, '--print', '%(id)s\t%(title)s', '--skip-download', '--no-warnings', '--no-playlist'],
      {
        timeout: 45000,
        windowsHide: true,
        maxBuffer: 2 * 1024 * 1024,
        env: { ...process.env, TEMP: TMP_DIR, TMP: TMP_DIR },
      },
      (error, stdout) => {
        if (error) return resolve(null);
        const line = String(stdout || '').trim().split(/\r?\n/)[0] || '';
        const [id, ...rest] = line.split('\t');
        if (!/^[\w-]{6,20}$/.test(id)) return resolve(null);
        resolve({ id, title: rest.join('\t').trim() });
      }
    );
  });

  if (found) ytCache.set(cacheKey, { data: found, at: Date.now() });
  return found;
}

async function findLocalMedia(query) {
  const roots = [folders.music, folders.videos, folders.downloads, folders.desktop];
  const r = await runPowerShellFile('search.ps1', ['-Query', query, '-Roots', roots.join('|'), '-Max', '30'], 45000);
  const media = r.stdout
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((file) => /\.(mp3|m4a|wav|flac|ogg|aac|wma|mp4|mkv|avi|mov|webm|wmv|m4v)$/i.test(file));

  return media[0] || null;
}

const handlers = {
  async open_app({ app }) {
    const raw = String(app || '').trim();
    if (!raw) return fail('No indicaste qué aplicación abrir.');

    if (/^https?:\/\//i.test(raw)) {
      await openTarget(raw);
      return ok('Abriendo el enlace.');
    }

    if (fs.existsSync(raw)) {
      const r = await openTarget(raw);
      return r.error ? fail(`No pude abrir ${raw}.`) : ok(`Abriendo ${path.basename(raw)}.`);
    }

    const key = stripAccents(raw.toLowerCase());

    // Aplicaciones y páginas del sistema (ms-settings:, ms-calculator:...)
    if (APP_ALIASES[key] && APP_ALIASES[key].endsWith(':')) {
      const r = await openTarget(APP_ALIASES[key]);
      return r.error ? fail(`No pude abrir ${raw}.`) : ok(`Abriendo ${raw}.`);
    }

    // Resolver accesos directos, menú Inicio, App Paths y programas instalados.
    const resolved = await runPowerShellFile('open-app.ps1', ['-Query', raw, '-Launch'], 40000);
    const data = parseLastJson(resolved.stdout);
    if (data?.ok) return ok(`Abriendo ${data.name}.`, { target: data.target });

    // Alias clásicos como último recurso
    if (APP_ALIASES[key]) {
      const fallback = await openTarget(APP_ALIASES[key]);
      if (!fallback.error) return ok(`Abriendo ${raw}.`);
    }

    const list = await runPowerShellFile('open-app.ps1', ['-Query', raw, '-ListOnly'], 40000);
    const matches = parseLastJson(list.stdout);
    const names = Array.isArray(matches) ? [...new Set(matches.map((m) => m.name))].slice(0, 3) : [];

    return fail(
      `No encontré la aplicación «${raw}».${names.length ? ` Coincidencias: ${names.join(', ')}.` : ''} Prueba con «busca apps ${raw}».`
    );
  },

  async open_url({ url }) {
    let u = String(url || '').trim();
    if (!u) return fail('No indicaste la URL.');
    if (!/^https?:\/\//i.test(u)) u = 'https://' + u.replace(/^\/+/, '');
    try {
      new URL(u);
    } catch {
      return fail(`La URL «${url}» no es válida.`);
    }
    const r = await openTarget(u);
    if (r.error) return fail('No pude abrir el navegador.');
    return ok(`Abriendo ${u}`);
  },

  async play_spotify({ query }) {
    const q = String(query || '').trim();
    if (!q) return fail('No indicaste qué música o canción reproducir en Spotify.');
    try {
      const res = await spotify.playSpotify(q);
      return ok(res.summary, res);
    } catch (err) {
      return fail(`No pude reproducir en Spotify: ${err.message}`);
    }
  },

  async google_calendar_list({ maxResults }) {
    try {
      const res = await google.listCalendarEvents(Number(maxResults) || 5);
      return ok(res.summary, res);
    } catch (err) {
      return fail(`No pude consultar Google Calendar: ${err.message}`);
    }
  },

  async google_calendar_create({ summary, start, end, description, location }) {
    const title = String(summary || '').trim();
    if (!title) return fail('No indicaste el nombre o motivo de la cita.');
    try {
      const res = await google.createCalendarEvent({
        summary: title,
        start,
        end,
        description,
        location,
      });
      if (res.webUrl) {
        await openTarget(res.webUrl);
      }
      return ok(res.summary, res);
    } catch (err) {
      return fail(`No pude agendar en Google Calendar: ${err.message}`);
    }
  },

  async play_video({ query, platform }) {
    const q = String(query || '').trim();
    if (!q) return fail('No indicaste qué reproducir.');

    if (/^https?:\/\//i.test(q)) {
      const r = await openTarget(q);
      return r.error ? fail('No pude abrir ese enlace.') : ok('Reproduciendo enlace.');
    }

    if (platform === 'spotify') {
      try {
        const res = await spotify.playSpotify(q);
        return ok(res.summary, res);
      } catch (err) {
        return fail(`No pude reproducir en Spotify: ${err.message}`);
      }
    }

    // Buscar el primer resultado real y abrir el vídeo (no la página de búsqueda).
    const found = await youtubeSearch(q);
    if (found) {
      const url = `https://www.youtube.com/watch?v=${found.id}`;
      const r = await openTarget(url);
      if (!r.error) {
        return ok(`Reproduciendo «${found.title || q}» en YouTube.`, { url, videoId: found.id });
      }
    }

    const searchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`;
    const fallback = await openTarget(searchUrl);
    if (fallback.error) return fail('No pude abrir el navegador.');
    return ok(`No pude resolver el vídeo; abrí la búsqueda de «${q}» en YouTube.`);
  },

  async play_media({ query }) {
    const q = String(query || '').trim();
    if (!q) return fail('No indicaste qué reproducir.');

    if (fs.existsSync(q)) {
      const r = await openTarget(q);
      return r.error ? fail('No pude abrir ese archivo.') : ok(`Reproduciendo ${path.basename(q)}.`);
    }

    const local = await findLocalMedia(q);
    if (local) {
      const r = await openTarget(local);
      if (!r.error) return ok(`Reproduciendo ${path.basename(local)}.`, { path: local });
    }

    const found = await youtubeSearch(q);
    if (found) {
      const url = `https://www.youtube.com/watch?v=${found.id}`;
      const r = await openTarget(url);
      if (!r.error) return ok(`Reproduciendo «${found.title || q}» en YouTube.`, { url });
    }

    const searchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`;
    await openTarget(searchUrl);
    return ok(`No encontré el archivo; abrí la búsqueda de «${q}» en YouTube.`);
  },

  async create_folder({ path: p }) {
    const target = resolvePath(p);
    try {
      await fsp.mkdir(target, { recursive: true });
      return ok(`Carpeta creada: ${displayPath(target)}`, { path: target });
    } catch (e) {
      return fail(`No pude crear la carpeta: ${e.message}`);
    }
  },

  async create_file({ path: p, content }) {
    let target = resolvePath(p);
    try {
      await fsp.mkdir(path.dirname(target), { recursive: true });
      if (!path.extname(target)) target += '.txt';
      await fsp.writeFile(target, String(content || ''), 'utf8');
      return ok(`Archivo creado: ${displayPath(target)}`, { path: target });
    } catch (e) {
      return fail(`No pude crear el archivo: ${e.message}`);
    }
  },

  async list_dir({ path: p }) {
    const target = resolvePath(p);
    try {
      const entries = await fsp.readdir(target, { withFileTypes: true });
      if (!entries.length) return ok(`La carpeta ${displayPath(target)} está vacía.`);
      const shown = entries.slice(0, 30).map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
      const extra = entries.length > 30 ? ` y ${entries.length - 30} más` : '';
      return ok(`En ${displayPath(target)}: ${shown.join(', ')}${extra}.`, { entries: shown });
    } catch (e) {
      return fail(`No pude leer esa carpeta: ${e.message}`);
    }
  },

  async search_files({ query, folder }) {
    const q = String(query || '').trim();
    if (!q) return fail('No indicaste qué buscar.');
    const roots = folder ? [resolvePath(folder)] : [folders.desktop, folders.documents, folders.downloads];
    const r = await runPowerShellFile('search.ps1', ['-Query', q, '-Roots', roots.join('|'), '-Max', '15'], 45000);
    const found = r.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    if (!found.length) return fail(`No encontré nada llamado «${q}».`);
    return ok(`Encontré ${found.length} resultado(s): ${found.map(displayPath).join(', ')}`, { entries: found });
  },

  async open_folder({ path: p }) {
    const target = resolvePath(p);
    if (!fs.existsSync(target)) return fail(`La carpeta no existe: ${displayPath(target)}`);
    const r = await openTarget(target);
    return r.error ? fail('No pude abrir el Explorador.') : ok(`Abriendo ${displayPath(target)}.`);
  },

  async delete_path({ path: p }) {
    const target = resolvePath(p);
    if (!fs.existsSync(target)) return fail(`No existe: ${displayPath(target)}`);
    if (target === folders.home || target === path.parse(target).root) {
      return fail('Por seguridad no puedo eliminar esa ubicación.');
    }
    const r = await runPowerShellFile('recycle.ps1', ['-Path', target], 30000);
    if (r.error || r.stderr.includes('Exception')) {
      return fail(`No pude eliminar ${displayPath(target)}.`);
    }
    return ok(`Enviado a la papelera: ${displayPath(target)}`);
  },

  async media_control({ action }) {
    const allowed = ['playpause', 'next', 'prev', 'stop'];
    if (!allowed.includes(action)) return fail('Acción multimedia no válida.');
    await runPowerShellFile('media.ps1', ['-Key', action], 15000);
    const words = { playpause: 'Reproducción pausada o reanudada', next: 'Siguiente pista', prev: 'Pista anterior', stop: 'Reproducción detenida' };
    return ok(words[action] + '.');
  },

  async volume({ action, steps }) {
    const n = Math.max(1, Math.min(50, Number(steps) || 5));
    if (action === 'mute') {
      await runPowerShellFile('media.ps1', ['-Key', 'mute'], 15000);
      return ok('Sonido silenciado o reactivado.');
    }
    if (!['up', 'down'].includes(action)) return fail('Acción de volumen no válida.');
    await runPowerShellFile('media.ps1', ['-Key', action === 'up' ? 'volumeup' : 'volumedown', '-Steps', String(n)], 30000);
    return ok(`Volumen ${action === 'up' ? 'subido' : 'bajado'}.`);
  },

  async screenshot() {
    const outDir = path.join(folders.pictures, 'EV Capturas');
    const r = await runPowerShellFile('screenshot.ps1', ['-OutDir', outDir], 30000);
    const file = r.stdout.trim().split(/\r?\n/).pop();
    if (r.error || !file) return fail('No pude tomar la captura de pantalla.');
    return ok(`Captura guardada en ${displayPath(file)}`, { path: file });
  },

  async clipboard({ action, text }) {
    if (action === 'write') {
      const safe = String(text ?? '').replace(/'/g, "''");
      const r = await runPowerShellCommand(`Set-Clipboard -Value '${safe}'`, 15000);
      return r.error ? fail('No pude escribir en el portapapeles.') : ok('Texto copiado al portapapeles.');
    }
    const r = await runPowerShellCommand('Get-Clipboard -Raw', 15000);
    const value = r.stdout.trim();
    if (!value) return ok('El portapapeles está vacío.');
    return ok(`Portapapeles: ${value.slice(0, 300)}${value.length > 300 ? '…' : ''}`, { data: value });
  },

  async system_info() {
    const cpus = os.cpus();
    const totalGb = (os.totalmem() / 1024 ** 3).toFixed(1);
    const freeGb = (os.freemem() / 1024 ** 3).toFixed(1);
    const info = `${os.type()} ${os.release()} · ${cpus[0]?.model?.trim() || 'CPU'} (${cpus.length} núcleos) · ${totalGb} GB RAM (${freeGb} GB libres) · equipo ${os.hostname()}`;
    let battery = '';
    try {
      const r = await runPowerShellCommand(
        '(Get-CimInstance Win32_Battery -ErrorAction SilentlyContinue | Select-Object -First 1).EstimatedChargeRemaining',
        15000
      );
      const v = r.stdout.trim();
      if (v) battery = ` · batería ${v}%`;
    } catch {}
    return ok(info + battery, { data: info });
  },

  async open_settings({ page }) {
    const pages = {
      bluetooth: 'ms-settings:bluetooth',
      wifi: 'ms-settings:network-wifi',
      display: 'ms-settings:display',
      pantalla: 'ms-settings:display',
      sound: 'ms-settings:sound',
      sonido: 'ms-settings:sound',
      update: 'ms-settings:windowsupdate',
      actualizaciones: 'ms-settings:windowsupdate',
      apps: 'ms-settings:appsfeatures',
      privacy: 'ms-settings:privacy',
      about: 'ms-settings:about',
      defaultapps: 'ms-settings:defaultapps',
    };
    const uri = pages[String(page || '').toLowerCase()] || 'ms-settings:';
    const r = await openTarget(uri);
    return r.error ? fail('No pude abrir la Configuración de Windows.') : ok('Abriendo Configuración de Windows.');
  },

  async lock_pc() {
    const r = await run('rundll32.exe', ['user32.dll,LockWorkStation'], 10000);
    return r.error ? fail('No pude bloquear el equipo.') : ok('Equipo bloqueado.');
  },

  async power({ action }) {
    if (action === 'shutdown') {
      await run('shutdown.exe', ['/s', '/t', '5', '/c', 'EV apagando el equipo'], 10000);
      return ok('Apagando el equipo en 5 segundos.');
    }
    if (action === 'restart') {
      await run('shutdown.exe', ['/r', '/t', '5', '/c', 'EV reiniciando el equipo'], 10000);
      return ok('Reiniciando el equipo en 5 segundos.');
    }
    if (action === 'sleep') {
      await run('rundll32.exe', ['powrprof.dll,SetSuspendState', '0,1,0'], 10000);
      return ok('Suspendiendo el equipo.');
    }
    if (action === 'cancel') {
      await run('shutdown.exe', ['/a'], 10000);
      return ok('Apagado cancelado.');
    }
    return fail('Acción de energía no válida.');
  },

  async list_apps({ query }) {
    const q = String(query || '').trim();
    if (!q) return fail('Dime parte del nombre de la aplicación.');

    const r = await runPowerShellFile('open-app.ps1', ['-Query', q, '-ListOnly'], 40000);
    const data = parseLastJson(r.stdout);

    if (!Array.isArray(data) || !data.length) {
      return fail(`No encontré aplicaciones que coincidan con «${q}».`);
    }

    const names = [...new Set(data.map((item) => item.name))].slice(0, 10);
    return ok(`Aplicaciones encontradas: ${names.join(', ')}.`, { apps: names });
  },

  async open_file({ path: p }) {
    const target = resolvePath(p);
    if (!fs.existsSync(target)) return fail(`No existe: ${displayPath(target)}`);

    const r = await openTarget(target);
    return r.error ? fail(`No pude abrir ${displayPath(target)}.`) : ok(`Abriendo ${displayPath(target)}.`);
  },

  async file_info({ path: p }) {
    const target = resolvePath(p);
    try {
      const stat = await fsp.stat(target);
      const kind = stat.isDirectory() ? 'Carpeta' : 'Archivo';
      const size = stat.isDirectory() ? '' : ` · ${formatSize(stat.size)}`;
      return ok(
        `${kind}: ${displayPath(target)}${size} · modificado ${stat.mtime.toLocaleString('es-ES')}`,
        { path: target }
      );
    } catch {
      return fail(`No encontré ${displayPath(target)}.`);
    }
  },

  async file_operation({ action, from, to }) {
    const source = resolvePath(from);
    const destination = resolvePath(to);

    if (!fs.existsSync(source)) return fail(`No existe: ${displayPath(source)}`);
    if (!from || !to) return fail('Necesito el origen y el destino.');

    try {
      if (action === 'copy') {
        let finalPath = destination;
        if (fs.existsSync(destination) && (await fsp.stat(destination)).isDirectory()) {
          finalPath = path.join(destination, path.basename(source));
        }
        await fsp.cp(source, finalPath, { recursive: true, force: false, errorOnExist: true });
        return ok(`Copiado en ${displayPath(finalPath)}.`);
      }

      if (action === 'move' || action === 'rename') {
        let finalPath = destination;
        if (fs.existsSync(destination) && (await fsp.stat(destination)).isDirectory()) {
          finalPath = path.join(destination, path.basename(source));
        }
        if (fs.existsSync(finalPath)) return fail(`Ya existe ${displayPath(finalPath)}.`);
        await fsp.rename(source, finalPath);
        return ok(`${action === 'move' ? 'Movido' : 'Renombrado'} a ${displayPath(finalPath)}.`);
      }

      return fail('Acción no válida.');
    } catch (err) {
      return fail(`No pude completar la operación: ${err.message}`);
    }
  },

  async archive({ action, path: p, destination }) {
    const source = resolvePath(p);
    if (!fs.existsSync(source)) return fail(`No existe: ${displayPath(source)}`);

    const dest = destination
      ? resolvePath(destination)
      : action === 'zip'
        ? `${source}.zip`
        : path.dirname(source);

    const command =
      action === 'zip'
        ? `Compress-Archive -LiteralPath '${psQuote(source)}' -DestinationPath '${psQuote(dest)}' -Force`
        : `Expand-Archive -LiteralPath '${psQuote(source)}' -DestinationPath '${psQuote(dest)}' -Force`;

    const r = await runPowerShellCommand(command, 90000);
    if (r.error) {
      return fail(`No pude ${action === 'zip' ? 'comprimir' : 'descomprimir'}: ${(r.stderr || '').trim().slice(0, 180)}`);
    }

    return ok(`${action === 'zip' ? 'Comprimido' : 'Descomprimido'} en ${displayPath(dest)}.`);
  },

  async read_file({ path: p, lines }) {
    const target = resolvePath(p);
    try {
      const stat = await fsp.stat(target);
      if (stat.isDirectory()) return fail('Eso es una carpeta, no un archivo.');
      if (stat.size > 2 * 1024 * 1024) return fail('El archivo es demasiado grande para leerlo aquí.');

      let text = await fsp.readFile(target, 'utf8');
      if (text.includes('\u0000')) return fail('El archivo parece binario.');

      if (lines) {
        text = text.split(/\r?\n/).slice(0, Number(lines) || 40).join('\n');
      }

      const clipped = text.slice(0, 4000);
      return ok(clipped || 'El archivo está vacío.', { text: clipped });
    } catch (err) {
      return fail(`No pude leer el archivo: ${err.message}`);
    }
  },

  async list_drives() {
    const r = await callPowerShell(
      "Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | Select-Object DeviceID,VolumeName,@{n='LibreGB';e={[math]::Round($_.FreeSpace/1GB,1)}},@{n='TotalGB';e={[math]::Round($_.Size/1GB,1)}} | ConvertTo-Json -Compress"
    );

    const data = parseLastJson(r.stdout);
    const drives = Array.isArray(data) ? data : data ? [data] : [];
    if (!drives.length) return fail('No pude leer las unidades de disco.');

    return ok(
      drives
        .map((drive) => `${drive.DeviceID} ${drive.VolumeName || ''} ${drive.LibreGB} GB libres de ${drive.TotalGB} GB`)
        .join(' · ')
    );
  },

  async process({ action, name }) {
    if (action === 'list') {
      const r = await callPowerShell(
        "Get-Process | Sort-Object WorkingSet64 -Descending | Select-Object -First 12 ProcessName,Id,@{n='RAM_MB';e={[math]::Round($_.WorkingSet64/1MB)}} | ConvertTo-Json -Compress"
      );
      const data = parseLastJson(r.stdout);
      if (!Array.isArray(data)) return fail('No pude leer los procesos.');

      return ok(`Procesos: ${data.map((item) => `${item.ProcessName} (${item.RAM_MB} MB)`).join(', ')}.`);
    }

    if (action === 'kill') {
      const safe = psQuote(String(name || '').replace(/\.exe$/i, '').trim());
      if (!safe) return fail('Dime qué proceso cerrar.');

      const r = await runPowerShellCommand(
        `$p = Get-Process -Name '${safe}' -ErrorAction SilentlyContinue; if ($p) { $p | Stop-Process -Force; 'ok' } else { 'not_found' }`,
        20000
      );

      return r.stdout.includes('ok') ? ok(`Proceso «${name}» cerrado.`) : fail(`No encontré el proceso «${name}».`);
    }

    return fail('Acción no válida.');
  },

  async window({ action, title }) {
    const allowed = ['list', 'focus', 'minimize', 'maximize', 'close'];
    if (!allowed.includes(action)) return fail('Acción de ventana no válida.');

    if (action === 'list') {
      const r = await runPowerShellFile('windows.ps1', ['-Action', 'list'], 25000);
      const data = parseLastJson(r.stdout);
      if (!Array.isArray(data)) return fail('No pude leer las ventanas.');

      const titles = data
        .map((item) => item.title)
        .filter((value) => value && !/Microsoft Text Input|Program Manager/i.test(value))
        .slice(0, 12);

      return ok(`Ventanas abiertas: ${titles.join(' · ')}.`);
    }

    if (!title) return fail('Dime el título de la ventana.');

    const r = await runPowerShellFile('windows.ps1', ['-Action', action, '-Title', title], 25000);
    const data = parseLastJson(r.stdout);

    if (!data?.ok) return fail(`No encontré una ventana que coincida con «${title}».`);
    return ok(`Ventana «${data.title}»: ${action}.`);
  },

  async type_text({ text }) {
    const value = String(text || '');
    if (!value) return fail('No indicaste qué escribir.');

    const r = await runPowerShellFile('keys.ps1', ['-Text', value], 20000);
    return r.error ? fail('No pude escribir el texto.') : ok('Texto escrito en la ventana activa.');
  },

  async press_keys({ keys }) {
    const value = String(keys || '');
    if (!value) return fail('No indicaste las teclas.');

    const r = await runPowerShellFile('keys.ps1', ['-Keys', value], 20000);
    return r.error ? fail('No pude pulsar las teclas.') : ok('Teclas enviadas.');
  },

  async network_info() {
    const script = [
      '$ip = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -notlike "127.*" -and $_.PrefixOrigin -ne "WellKnown" } | Select-Object -First 1;',
      '$gw = (Get-NetRoute -DestinationPrefix "0.0.0.0/0" -ErrorAction SilentlyContinue | Select-Object -First 1).NextHop;',
      '$wifi = (netsh wlan show interfaces | Select-String "^\\s*SSID\\s+:" | Select-Object -First 1);',
      'if ($wifi) { $ssid = ($wifi.ToString() -split ":",2)[1].Trim() } else { $ssid = "" };',
      '"IP $($ip.IPAddress) | Puerta $gw | WiFi $ssid"',
    ].join(' ');

    const r = await runPowerShellCommand(script, 30000);
    const text = (r.stdout || '').trim();
    return text ? ok(text) : fail('No pude leer la información de red.');
  },

  async weather({ city }) {
    const target = city ? encodeURIComponent(city) : '';

    try {
      const res = await fetch(`https://wttr.in/${target}?format=j1`, {
        headers: { 'User-Agent': 'curl/8.0' },
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) return fail('No pude consultar el tiempo.');

      const data = await res.json();
      const current = data.current_condition?.[0];
      if (!current) return fail('No pude leer el tiempo.');

      const description = String(current.weatherDesc?.[0]?.value || '').trim();
      return ok(
        `${city || data.nearest_area?.[0]?.areaName?.[0]?.value || 'Tu zona'}: ${current.temp_C}°C (sensación ${current.FeelsLikeC}°), ${description}, humedad ${current.humidity}%.`
      );
    } catch {
      return fail('No pude conectar con el servicio del tiempo.');
    }
  },

  async empty_recycle_bin() {
    const r = await runPowerShellCommand('Clear-RecycleBin -Force -ErrorAction SilentlyContinue; "ok"', 30000);
    return r.error ? fail('No pude vaciar la papelera.') : ok('Papelera vaciada.');
  },

  async create_shortcut({ target, name }) {
    const rawTarget = String(target || '').trim();
    const safeName = String(name || '').replace(/[\\/:*?"<>|]/g, '').trim();

    if (!rawTarget) return fail('No indicaste el destino del acceso directo.');

    if (/^https?:\/\//i.test(rawTarget)) {
      const file = path.join(folders.desktop, `${safeName || 'Acceso directo'}.url`);
      await fsp.writeFile(file, `[InternetShortcut]\r\nURL=${rawTarget}\r\n`, 'utf8');
      return ok(`Acceso directo creado: ${displayPath(file)}.`);
    }

    const targetPath = resolvePath(rawTarget);
    if (!fs.existsSync(targetPath)) return fail(`No existe ${displayPath(targetPath)}.`);

    const linkName = safeName || path.basename(targetPath, path.extname(targetPath));
    const script = `$ws = New-Object -ComObject WScript.Shell; $lnk = $ws.CreateShortcut((Join-Path ([Environment]::GetFolderPath('Desktop')) '${psQuote(linkName)}.lnk')); $lnk.TargetPath = '${psQuote(targetPath)}'; $lnk.Save(); 'ok'`;

    const r = await runPowerShellCommand(script, 20000);
    if (r.error) return fail('No pude crear el acceso directo.');

    return ok(`Acceso directo «${linkName}» creado en el Escritorio.`);
  },

  async download_file({ url, path: p }) {
    let parsed;
    try {
      parsed = new URL(String(url || ''));
    } catch {
      return fail('La URL no es válida.');
    }

    const fallbackName = decodeURIComponent(path.basename(parsed.pathname)) || 'descarga';
    let destination = p ? resolvePath(p) : path.join(folders.downloads, fallbackName);

    try {
      const res = await fetch(parsed, { signal: AbortSignal.timeout(90000) });
      if (!res.ok) return fail(`La descarga falló con estado ${res.status}.`);

      const buffer = Buffer.from(await res.arrayBuffer());
      if (buffer.length > 120 * 1024 * 1024) return fail('El archivo es demasiado grande (máximo 120 MB).');

      if (fs.existsSync(destination) && (await fsp.stat(destination)).isDirectory()) {
        destination = path.join(destination, fallbackName);
      }

      await fsp.mkdir(path.dirname(destination), { recursive: true });
      await fsp.writeFile(destination, buffer);

      return ok(`Descargado en ${displayPath(destination)} (${formatSize(buffer.length)}).`, {
        path: destination,
      });
    } catch (err) {
      return fail(`No pude descargar el archivo: ${err.message}`);
    }
  },

  async brightness({ level }) {
    const value = Math.max(0, Math.min(100, Number(level)));

    const script = `$m = Get-CimInstance -Namespace root/WMI -ClassName WmiMonitorBrightnessMethods -ErrorAction SilentlyContinue | Select-Object -First 1; if ($m) { Invoke-CimMethod -InputObject $m -MethodName WmiSetBrightness -Arguments @{ Timeout = 1; Brightness = [byte]${value} } | Out-Null; 'ok' } else { 'no_support' }`;
    const r = await runPowerShellCommand(script, 20000);

    if (r.stdout.includes('no_support')) {
      return fail('Este equipo no permite ajustar el brillo por software (habitual en monitores de sobremesa).');
    }

    return r.stdout.includes('ok') ? ok(`Brillo ajustado al ${value}%.`) : fail('No pude ajustar el brillo.');
  },

  async screen_info() {
    const info = await vision.displayInfo();
    const screens = (info.screens || [])
      .map((screen) => `${screen.width}x${screen.height}${screen.primary ? ' (principal)' : ''}`)
      .join(', ');

    return ok(
      `Pantalla ${info.width}x${info.height}${info.count > 1 ? ` · ${info.count} monitores: ${screens}` : ''}.`
    );
  },

  async look_at_screen({ question }) {
    try {
      const result = await vision.lookAtScreen(String(question || '¿Qué hay en la pantalla?').trim());
      const text = String(result.text || '').slice(0, 700);
      return ok(text, { text });
    } catch (err) {
      return fail(err.message || 'No pude ver la pantalla.');
    }
  },

  async find_on_screen({ target }) {
    const query = String(target || '').trim();
    if (!query) return fail('Dime qué elemento buscar.');

    try {
      const found = await vision.locateOnScreen(query);
      if (!found.found) return fail(found.reason || `No encontré «${query}» en la pantalla.`);

      return ok(`Encontré «${found.label}» en (${found.x}, ${found.y}).`, {
        x: found.x,
        y: found.y,
      });
    } catch (err) {
      return fail(err.message || 'No pude analizar la pantalla.');
    }
  },

  async click_on_screen({ target, button }) {
    if (!config.allowScreenControl) {
      return fail('El control de pantalla está desactivado en Ajustes.');
    }

    const query = String(target || '').trim();
    if (!query) return fail('Dime dónde hacer clic.');

    try {
      const found = await vision.locateOnScreen(query);
      if (!found.found) return fail(found.reason || `No encontré «${query}» en la pantalla.`);

      await vision.clickAt(found.x, found.y, button === 'right' ? 'right' : 'left');
      return ok(`Hice clic en «${found.label}».`, { x: found.x, y: found.y });
    } catch (err) {
      return fail(err.message || 'No pude hacer clic.');
    }
  },

  async type_into({ target, text }) {
    if (!config.allowScreenControl) {
      return fail('El control de pantalla está desactivado en Ajustes.');
    }

    const query = String(target || '').trim();
    const value = String(text ?? '');
    if (!query) return fail('Dime en qué campo escribir.');
    if (!value) return fail('No indicaste el texto.');

    try {
      const found = await vision.locateOnScreen(query);
      if (!found.found) return fail(found.reason || `No encontré «${query}» en la pantalla.`);

      await vision.clickAt(found.x, found.y);
      await new Promise((resolve) => setTimeout(resolve, 250));

      const typed = await vision.typeText(value);
      if (typed.error) return fail('Encontré el campo, pero no pude escribir.');

      return ok(`Escribí el texto en «${found.label}».`, { x: found.x, y: found.y });
    } catch (err) {
      return fail(err.message || 'No pude escribir en la pantalla.');
    }
  },

  async mouse_click({ x, y, button, target }) {
    if (!config.allowScreenControl) {
      return fail('El control de pantalla está desactivado en Ajustes.');
    }

    let px = Number(x);
    let py = Number(y);
    const btn = button === 'right' ? 'right' : 'left';

    // Si se especifica un objetivo o descripción, tomar un screenshot instantáneo para calcular la posición precisa
    if (typeof target === 'string' && target.trim()) {
      try {
        const found = await vision.locateOnScreen(target.trim());
        if (found.found) {
          px = found.x;
          py = found.y;
          await vision.clickAt(px, py, btn);
          return ok(`Hice clic con precisión en «${found.label}» (${px}, ${py}).`, { x: px, y: py });
        }
      } catch (err) {
        console.warn('[EV] locateOnScreen fallback en mouse_click:', err.message);
      }
    }

    if (!Number.isFinite(px) || !Number.isFinite(py)) return fail('Coordenadas no válidas.');

    const result = await vision.clickAt(px, py, btn);
    return result.error ? fail('No pude hacer clic.') : ok(`Clic en (${Math.round(px)}, ${Math.round(py)}).`);
  },

  async scroll({ direction, amount }) {
    if (!config.allowScreenControl) {
      return fail('El control de pantalla está desactivado en Ajustes.');
    }

    const dir = direction === 'up' ? 'up' : 'down';
    const value = Math.max(30, Math.min(600, Number(amount) || 120));
    const result = await vision.scroll(dir, value);

    return result.error ? fail('No pude desplazar la pantalla.') : ok(`Desplazado hacia ${dir}.`);
  },

  async auto_scroll({ direction, step, intervalMs }) {
    if (!config.allowScreenControl) {
      return fail('El control de pantalla está desactivado en Ajustes.');
    }

    const dir = direction === 'up' ? 'up' : 'down';
    vision.startAutoScroll({ direction: dir, step, intervalMs });

    return ok(
      `Desplazamiento ${dir} iniciado. Dime «para» cuando quieras detenerlo y podré ver qué hay en pantalla.`
    );
  },

  async stop_actions() {
    const stopped = vision.stopAutoScroll();
    return ok(stopped ? 'Acciones detenidas.' : 'No había acciones en curso.');
  },

  async run_shell({ command }) {
    if (!config.allowShell) {
      return fail('La ejecución de comandos está desactivada. Actívala en Ajustes.');
    }
    const cmd = String(command || '').trim();
    if (!cmd) return fail('No indicaste el comando.');
    const r = await runPowerShellCommand(cmd, 40000);
    const out = (r.stdout || r.stderr || '').trim().slice(0, 3000);
    if (r.error) return fail(`El comando falló: ${out || r.error.message}`);
    return ok(out ? `Comando ejecutado. Salida: ${out}` : 'Comando ejecutado sin salida.', { data: out });
  },
};

async function executeTool(name, args) {
  const handler = handlers[name];
  if (!handler) return fail(`No sé ejecutar «${name}».`);
  try {
    return await handler(args || {});
  } catch (e) {
    return fail(`Error al ejecutar ${name}: ${e.message}`);
  }
}

/** Catálogo corto para mostrar en la interfaz. */
function toolCatalog() {
  return Object.entries(TOOL_LABELS).map(([name, label]) => ({ name, label }));
}

module.exports = {
  TOOL_DEFS,
  TOOL_LABELS,
  executeTool,
  requiresConfirmation,
  resolvePath,
  displayPath,
  toolCatalog,
  folders,
};
