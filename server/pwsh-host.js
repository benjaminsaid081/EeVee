'use strict';

/**
 * Canal persistente con PowerShell para captura de pantalla y entrada.
 * Mantiene un solo proceso vivo y le envía comandos por stdin, evitando
 * el coste de arrancar PowerShell (≈0,4-1 s) en cada acción.
 */

const path = require('node:path');
const readline = require('node:readline');
const { spawn } = require('node:child_process');

const POWERSHELL = 'powershell.exe';
const SCRIPT = path.join(__dirname, 'scripts', 'input-host.ps1');

let child = null;
let sequence = 0;
let lastStderr = '';
const pending = new Map();

function rejectPending(message) {
  for (const [id, item] of pending) {
    clearTimeout(item.timer);
    pending.delete(id);
    item.reject(new Error(message));
  }
}

function start() {
  if (child && !child.killed) return child;

  const proc = spawn(
    POWERSHELL,
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT],
    { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }
  );

  child = proc;
  lastStderr = '';

  const lines = readline.createInterface({ input: proc.stdout });
  lines.on('line', (line) => {
    const separator = line.indexOf('\t');
    if (separator < 0) return;

    const id = line.slice(0, separator);
    const payload = line.slice(separator + 1);
    const item = pending.get(id);
    if (!item) return;

    pending.delete(id);
    clearTimeout(item.timer);

    let data;
    try {
      data = JSON.parse(payload);
    } catch {
      item.reject(new Error('El host de entrada devolvió una respuesta inválida.'));
      return;
    }

    if (data && data.ok === false) {
      item.reject(new Error(data.error || 'Error en el host de entrada.'));
      return;
    }
    item.resolve(data || {});
  });

  proc.stderr.on('data', (chunk) => {
    lastStderr = (lastStderr + chunk.toString()).slice(-2000);
  });

  proc.stdout.on('error', () => {});
  proc.stdin.on('error', (err) => {
    if (child === proc) child = null;
    rejectPending(`No pude comunicarme con el host de entrada: ${err.message}`);
  });

  proc.on('error', (err) => {
    if (child === proc) child = null;
    rejectPending(`No pude iniciar el host de entrada: ${err.message}`);
  });

  proc.on('exit', () => {
    if (child === proc) child = null;
    rejectPending(`El host de entrada se cerró. ${lastStderr}`.trim());
  });

  return proc;
}

function command(name, args = [], timeout = 15000) {
  const proc = start();
  const id = String(++sequence);
  const line = [id, name, ...args.map((value) => String(value))].join('\t');

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      if (child === proc) {
        try {
          proc.kill();
        } catch {}
        child = null;
      }
      reject(new Error(`El host de entrada no respondió a «${name}».`));
    }, timeout);

    pending.set(id, { resolve, reject, timer });

    try {
      proc.stdin.write(line + '\n');
    } catch (err) {
      clearTimeout(timer);
      pending.delete(id);
      reject(err);
    }
  });
}

async function warmUp() {
  try {
    await command('ping', [], 10000);
    return true;
  } catch {
    return false;
  }
}

function shutdown() {
  if (!child) return;
  const proc = child;
  child = null;
  try {
    proc.stdin.write('0\texit\n');
  } catch {}
  try {
    proc.kill();
  } catch {}
}

process.on('exit', shutdown);

module.exports = {
  command,
  warmUp,
  shutdown,
};
