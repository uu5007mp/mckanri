#!/usr/bin/env node
'use strict';

const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const PUBLIC_DIR = path.join(ROOT, 'public');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
const STATE_PATH = path.join(DATA_DIR, 'state.json');
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';

const DEFAULT_CONFIG = {
  serverDir: path.join(ROOT, 'minecraft-server'),
  jarPath: path.join(ROOT, 'minecraft-server', 'server.jar'),
  javaPath: 'java',
  minMemory: '1G',
  maxMemory: '2G',
  backupDir: path.join(ROOT, 'backups'),
  extraArgs: []
};

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8'
};

let minecraft = null;
let currentLogPath = null;

function json(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text)
  });
  res.end(text);
}

function text(res, status, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'content-type': type });
  res.end(body);
}

async function ensureDataFiles() {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  if (!fs.existsSync(CONFIG_PATH)) {
    await saveConfig(DEFAULT_CONFIG);
  }
}

async function loadConfig() {
  await ensureDataFiles();
  const raw = await fsp.readFile(CONFIG_PATH, 'utf8');
  const parsed = JSON.parse(raw);
  return { ...DEFAULT_CONFIG, ...parsed, extraArgs: Array.isArray(parsed.extraArgs) ? parsed.extraArgs : [] };
}

async function saveConfig(config) {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  await fsp.writeFile(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`);
}

async function saveState(state) {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  await fsp.writeFile(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1024 * 1024) {
      throw Object.assign(new Error('Request body is too large'), { status: 413 });
    }
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function isRunning() {
  return minecraft !== null && minecraft.exitCode === null && minecraft.signalCode === null;
}

async function getStatus() {
  const config = await loadConfig();
  return {
    running: isRunning(),
    pid: isRunning() ? minecraft.pid : null,
    config,
    logPath: currentLogPath || path.join(config.serverDir, 'logs', 'latest.log')
  };
}

function validateConfig(input) {
  const config = { ...DEFAULT_CONFIG, ...input };
  for (const key of ['serverDir', 'jarPath', 'javaPath', 'minMemory', 'maxMemory', 'backupDir']) {
    if (typeof config[key] !== 'string' || config[key].trim() === '') {
      throw Object.assign(new Error(`${key} is required`), { status: 400 });
    }
    config[key] = config[key].trim();
  }
  if (typeof config.extraArgs === 'string') {
    config.extraArgs = config.extraArgs.split(/\s+/).filter(Boolean);
  }
  if (!Array.isArray(config.extraArgs)) {
    throw Object.assign(new Error('extraArgs must be an array or a space-separated string'), { status: 400 });
  }
  return config;
}

async function initServer(acceptEula) {
  const config = await loadConfig();
  await fsp.mkdir(path.join(config.serverDir, 'logs'), { recursive: true });
  const eulaPath = path.join(config.serverDir, 'eula.txt');
  if (acceptEula) {
    await fsp.writeFile(eulaPath, 'eula=true\n');
  } else if (!fs.existsSync(eulaPath)) {
    await fsp.writeFile(eulaPath, 'eula=false\n');
  }
  return { serverDir: config.serverDir, eulaPath };
}

async function startServer() {
  if (isRunning()) return getStatus();
  const config = await loadConfig();
  if (!fs.existsSync(config.jarPath)) {
    throw Object.assign(new Error(`Minecraft server jar not found: ${config.jarPath}`), { status: 400 });
  }
  await fsp.mkdir(path.join(config.serverDir, 'logs'), { recursive: true });
  currentLogPath = path.join(config.serverDir, 'logs', 'latest.log');
  const logStream = fs.createWriteStream(currentLogPath, { flags: 'a' });
  const args = [`-Xms${config.minMemory}`, `-Xmx${config.maxMemory}`, '-jar', config.jarPath, 'nogui', ...config.extraArgs];
  minecraft = spawn(config.javaPath, args, {
    cwd: config.serverDir,
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: false
  });
  minecraft.stdout.pipe(logStream, { end: false });
  minecraft.stderr.pipe(logStream, { end: false });
  await saveState({ pid: minecraft.pid, startedAt: new Date().toISOString(), logPath: currentLogPath });
  minecraft.once('exit', async (code, signal) => {
    logStream.write(`\n[mckanri] server exited code=${code} signal=${signal}\n`);
    logStream.end();
    minecraft = null;
    await saveState({ pid: null, stoppedAt: new Date().toISOString(), code, signal, logPath: currentLogPath });
  });
  return getStatus();
}

async function stopServer() {
  if (!isRunning()) return getStatus();
  minecraft.stdin.write('stop\n');
  const child = minecraft;
  const stopped = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 30000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
  if (!stopped && isRunning()) {
    child.kill('SIGTERM');
  }
  return getStatus();
}

function sendCommand(command) {
  if (!isRunning()) {
    throw Object.assign(new Error('Minecraft server is not running'), { status: 409 });
  }
  const line = String(command || '').trim();
  if (!line) {
    throw Object.assign(new Error('command is required'), { status: 400 });
  }
  minecraft.stdin.write(`${line}\n`);
  return { sent: line };
}

async function readLogs(lines) {
  const status = await getStatus();
  if (!fs.existsSync(status.logPath)) return '';
  const raw = await fsp.readFile(status.logPath, 'utf8');
  return raw.split(/\r?\n/).slice(-lines).join('\n');
}

function runTar(args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn('tar', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) resolve();
      else reject(Object.assign(new Error(stderr || `tar exited with code ${code}`), { status: 500 }));
    });
  });
}

async function backupServer() {
  const config = await loadConfig();
  if (!fs.existsSync(config.serverDir)) {
    throw Object.assign(new Error(`Server directory not found: ${config.serverDir}`), { status: 400 });
  }
  await fsp.mkdir(config.backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const archivePath = path.join(config.backupDir, `minecraft-${stamp}.tar.gz`);
  await runTar(['--exclude', '.mckanri.pid', '--exclude', '.mckanri.stdin', '-czf', archivePath, '.'], config.serverDir);
  return { archivePath };
}


function systemdUnit() {
  return `[Unit]\nDescription=mckanri Minecraft web manager\nAfter=network.target\n\n[Service]\nType=simple\nWorkingDirectory=${ROOT}\nExecStart=/usr/bin/node ${path.join(ROOT, 'server.js')}\nRestart=on-failure\nEnvironment=HOST=0.0.0.0\nEnvironment=PORT=${PORT}\n\n[Install]\nWantedBy=multi-user.target\n`;
}

async function serveStatic(req, res, pathname) {
  const requested = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.normalize(path.join(PUBLIC_DIR, requested));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    text(res, 403, 'Forbidden');
    return;
  }
  try {
    const data = await fsp.readFile(filePath);
    text(res, 200, data, CONTENT_TYPES[path.extname(filePath)] || 'application/octet-stream');
  } catch (error) {
    text(res, error.code === 'ENOENT' ? 404 : 500, error.code === 'ENOENT' ? 'Not found' : 'Server error');
  }
}

async function handleApi(req, res, pathname) {
  if (req.method === 'GET' && pathname === '/api/status') return json(res, 200, await getStatus());
  if (req.method === 'GET' && pathname === '/api/logs') {
    const url = new URL(req.url, `http://${req.headers.host}`);
    return json(res, 200, { logs: await readLogs(Number(url.searchParams.get('lines') || 120)) });
  }
  if (req.method === 'GET' && pathname === '/api/systemd') return text(res, 200, systemdUnit());
  if (req.method === 'POST' && pathname === '/api/config') {
    if (isRunning()) throw Object.assign(new Error('Stop the server before changing config'), { status: 409 });
    const config = validateConfig(await readBody(req));
    await saveConfig(config);
    return json(res, 200, { config });
  }
  if (req.method === 'POST' && pathname === '/api/init') {
    const body = await readBody(req);
    return json(res, 200, await initServer(Boolean(body.acceptEula)));
  }
  if (req.method === 'POST' && pathname === '/api/start') return json(res, 200, await startServer());
  if (req.method === 'POST' && pathname === '/api/stop') return json(res, 200, await stopServer());
  if (req.method === 'POST' && pathname === '/api/command') {
    const body = await readBody(req);
    return json(res, 200, sendCommand(body.command));
  }
  if (req.method === 'POST' && pathname === '/api/backup') return json(res, 200, await backupServer());
  return json(res, 404, { error: 'API route not found' });
}

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (pathname.startsWith('/api/')) {
      await handleApi(req, res, pathname);
    } else {
      await serveStatic(req, res, decodeURIComponent(pathname));
    }
  } catch (error) {
    json(res, error.status || 500, { error: error.message || 'Server error' });
  }
});

ensureDataFiles().then(() => {
  server.listen(PORT, HOST, () => {
    console.log(`mckanri web is running at http://${HOST}:${PORT}`);
  });
});

process.on('SIGTERM', () => {
  if (isRunning()) minecraft.stdin.write('stop\n');
  server.close(() => process.exit(0));
});
