#!/usr/bin/env node
'use strict';

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const PUBLIC_DIR = path.join(ROOT, 'public');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
const STATE_PATH = path.join(DATA_DIR, 'state.json');
function loadDotEnv() {
  const envPath = path.join(ROOT, '.env');
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    const [key, ...rest] = line.split('=');
    if (!process.env[key]) process.env[key] = rest.join('=').trim().replace(/^['\"]|['\"]$/g, '');
  }
}

loadDotEnv();

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const MAX_JSON_BYTES = 1024 * 1024;
const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_BYTES || 512 * 1024 * 1024);

const DEFAULT_CONFIG = {
  serverDir: path.join(ROOT, 'minecraft-server'),
  jarPath: path.join(ROOT, 'minecraft-server', 'server.jar'),
  javaPath: 'java',
  minMemory: '1G',
  maxMemory: '2G',
  backupDir: path.join(ROOT, 'backups'),
  extraArgs: [],
  adminPassword: process.env.MCKANRI_PASSWORD || 'mckanri'
};

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.jar': 'application/java-archive',
  '.properties': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.log': 'text/plain; charset=utf-8'
};

let minecraft = null;
let currentLogPath = null;
const sessions = new Map();

function json(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text)
  });
  res.end(text);
}

function text(res, status, body, type = 'text/plain; charset=utf-8', extraHeaders = {}) {
  res.writeHead(status, { 'content-type': type, ...extraHeaders });
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
  const config = { ...DEFAULT_CONFIG, ...parsed, extraArgs: Array.isArray(parsed.extraArgs) ? parsed.extraArgs : [] };
  if (process.env.MCKANRI_PASSWORD) config.adminPassword = process.env.MCKANRI_PASSWORD;
  return config;
}

async function saveConfig(config) {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  await fsp.writeFile(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`);
}

function publicConfig(config) {
  const { adminPassword, ...safe } = config;
  return safe;
}

async function saveState(state) {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  await fsp.writeFile(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`);
}

async function readRawBody(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) {
      throw Object.assign(new Error('Request body is too large'), { status: 413 });
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJson(req) {
  const raw = await readRawBody(req, MAX_JSON_BYTES);
  if (raw.length === 0) return {};
  return JSON.parse(raw.toString('utf8'));
}

function parseCookies(req) {
  return Object.fromEntries(String(req.headers.cookie || '').split(';').filter(Boolean).map((part) => {
    const [key, ...rest] = part.trim().split('=');
    return [decodeURIComponent(key), decodeURIComponent(rest.join('='))];
  }));
}

function makeSession() {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, Date.now() + 1000 * 60 * 60 * 12);
  return token;
}

function isAuthed(req) {
  const token = parseCookies(req).mckanri_session;
  const expires = token && sessions.get(token);
  if (!expires || expires < Date.now()) {
    if (token) sessions.delete(token);
    return false;
  }
  sessions.set(token, Date.now() + 1000 * 60 * 60 * 12);
  return true;
}

function timingSafeEqualString(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function isRunning() {
  return minecraft !== null && minecraft.exitCode === null && minecraft.signalCode === null;
}

async function getStatus() {
  const config = await loadConfig();
  return {
    running: isRunning(),
    pid: isRunning() ? minecraft.pid : null,
    config: publicConfig(config),
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
  if (typeof input.adminPassword === 'string' && input.adminPassword.trim()) {
    config.adminPassword = input.adminPassword.trim();
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
  if (!stopped && isRunning()) child.kill('SIGTERM');
  return getStatus();
}

function sendCommand(command) {
  if (!isRunning()) throw Object.assign(new Error('Minecraft server is not running'), { status: 409 });
  const line = String(command || '').trim();
  if (!line) throw Object.assign(new Error('command is required'), { status: 400 });
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
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) resolve();
      else reject(Object.assign(new Error(stderr || `tar exited with code ${code}`), { status: 500 }));
    });
  });
}

async function backupServer() {
  const config = await loadConfig();
  if (!fs.existsSync(config.serverDir)) throw Object.assign(new Error(`Server directory not found: ${config.serverDir}`), { status: 400 });
  await fsp.mkdir(config.backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const archivePath = path.join(config.backupDir, `minecraft-${stamp}.tar.gz`);
  await runTar(['--exclude', '.mckanri.pid', '--exclude', '.mckanri.stdin', '-czf', archivePath, '.'], config.serverDir);
  return { archivePath };
}

async function resolveServerPath(relativePath = '') {
  const config = await loadConfig();
  const root = path.resolve(config.serverDir);
  const target = path.resolve(root, String(relativePath || '.'));
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw Object.assign(new Error('Invalid path'), { status: 400 });
  }
  return { config, root, target, relative: path.relative(root, target) };
}

async function listFiles(relativePath = '') {
  const { target, relative } = await resolveServerPath(relativePath);
  const stat = await fsp.stat(target).catch(() => null);
  if (!stat || !stat.isDirectory()) throw Object.assign(new Error('Directory not found'), { status: 404 });
  const entries = await Promise.all((await fsp.readdir(target)).map(async (name) => {
    const full = path.join(target, name);
    const itemStat = await fsp.stat(full);
    return {
      name,
      path: path.join(relative, name),
      type: itemStat.isDirectory() ? 'directory' : 'file',
      size: itemStat.size,
      modifiedAt: itemStat.mtime.toISOString()
    };
  }));
  entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'directory' ? -1 : 1));
  return { path: relative, parent: relative ? path.dirname(relative) : '', entries };
}

async function deleteFile(relativePath) {
  const { target, relative } = await resolveServerPath(relativePath);
  if (!relative) throw Object.assign(new Error('Cannot delete server root'), { status: 400 });
  await fsp.rm(target, { recursive: true, force: true });
  return { deleted: relative };
}

async function makeDirectory(relativePath) {
  const { target, relative } = await resolveServerPath(relativePath);
  if (!relative) throw Object.assign(new Error('Directory name is required'), { status: 400 });
  await fsp.mkdir(target, { recursive: true });
  return { created: relative };
}

function parseMultipart(buffer, contentType) {
  const boundaryMatch = /boundary=(?:(?:"([^"]+)")|([^;]+))/i.exec(contentType || '');
  if (!boundaryMatch) throw Object.assign(new Error('multipart boundary is required'), { status: 400 });
  const boundary = Buffer.from(`--${boundaryMatch[1] || boundaryMatch[2]}`);
  const parts = [];
  let cursor = buffer.indexOf(boundary);
  while (cursor !== -1) {
    cursor += boundary.length;
    if (buffer.slice(cursor, cursor + 2).toString() === '--') break;
    if (buffer.slice(cursor, cursor + 2).toString() === '\r\n') cursor += 2;
    const headerEnd = buffer.indexOf(Buffer.from('\r\n\r\n'), cursor);
    if (headerEnd === -1) break;
    const headerText = buffer.slice(cursor, headerEnd).toString('utf8');
    const next = buffer.indexOf(boundary, headerEnd + 4);
    if (next === -1) break;
    let data = buffer.slice(headerEnd + 4, next);
    if (data.slice(-2).toString() === '\r\n') data = data.slice(0, -2);
    const headers = Object.fromEntries(headerText.split('\r\n').map((line) => {
      const [key, ...rest] = line.split(':');
      return [key.toLowerCase(), rest.join(':').trim()];
    }));
    parts.push({ headers, data });
    cursor = next;
  }
  return parts;
}

function getMultipartFile(parts) {
  for (const part of parts) {
    const disposition = part.headers['content-disposition'] || '';
    if (!disposition.includes('filename=')) continue;
    const filenameMatch = /filename="([^"]*)"|filename=([^;]+)/i.exec(disposition);
    const originalName = path.basename(filenameMatch?.[1] || filenameMatch?.[2] || 'upload.bin');
    return { originalName, data: part.data };
  }
  throw Object.assign(new Error('Upload file is required'), { status: 400 });
}

async function uploadFile(req, relativeDir = '') {
  const raw = await readRawBody(req, MAX_UPLOAD_BYTES);
  const { config, target: dir } = await resolveServerPath(relativeDir);
  await fsp.mkdir(dir, { recursive: true });
  const file = getMultipartFile(parseMultipart(raw, req.headers['content-type']));
  const isJar = path.extname(file.originalName).toLowerCase() === '.jar';
  const fileName = isJar ? 'server.jar' : file.originalName;
  const destination = path.join(dir, fileName);
  const root = path.resolve(config.serverDir);
  if (!path.resolve(destination).startsWith(root + path.sep)) throw Object.assign(new Error('Invalid upload path'), { status: 400 });
  await fsp.writeFile(destination, file.data);
  if (isJar) {
    config.jarPath = destination;
    await saveConfig(config);
  }
  return { uploaded: path.relative(root, destination), savedAs: fileName, jarPath: isJar ? destination : undefined };
}

function systemdUnit() {
  return `[Unit]\nDescription=mckanri Minecraft web manager\nAfter=network.target\n\n[Service]\nType=simple\nWorkingDirectory=${ROOT}\nExecStart=/usr/bin/node ${path.join(ROOT, 'server.js')}\nRestart=on-failure\nEnvironment=HOST=0.0.0.0\nEnvironment=PORT=${PORT}\n# Put MCKANRI_PASSWORD=change-me in the .env file below.\nEnvironmentFile=-${path.join(ROOT, '.env')}\n\n[Install]\nWantedBy=multi-user.target\n`;
}

async function serveStatic(req, res, pathname) {
  const requested = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.normalize(path.join(PUBLIC_DIR, requested));
  if (!filePath.startsWith(PUBLIC_DIR)) return text(res, 403, 'Forbidden');
  try {
    const data = await fsp.readFile(filePath);
    text(res, 200, data, CONTENT_TYPES[path.extname(filePath)] || 'application/octet-stream');
  } catch (error) {
    text(res, error.code === 'ENOENT' ? 404 : 500, error.code === 'ENOENT' ? 'Not found' : 'Server error');
  }
}

async function handleLogin(req, res) {
  const config = await loadConfig();
  const body = await readJson(req);
  if (!timingSafeEqualString(body.password || '', config.adminPassword)) {
    return json(res, 401, { error: 'Password is incorrect' });
  }
  const token = makeSession();
  res.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'set-cookie': `mckanri_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=43200`
  });
  res.end(JSON.stringify({ ok: true }));
}

async function handleApi(req, res, pathname) {
  if (req.method === 'POST' && pathname === '/api/login') return handleLogin(req, res);
  if (req.method === 'POST' && pathname === '/api/logout') {
    const token = parseCookies(req).mckanri_session;
    if (token) sessions.delete(token);
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'set-cookie': 'mckanri_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0' });
    return res.end(JSON.stringify({ ok: true }));
  }
  if (req.method === 'GET' && pathname === '/api/session') return json(res, 200, { authenticated: isAuthed(req) });
  if (!isAuthed(req)) return json(res, 401, { error: 'Login required' });

  if (req.method === 'GET' && pathname === '/api/status') return json(res, 200, await getStatus());
  if (req.method === 'GET' && pathname === '/api/logs') {
    const url = new URL(req.url, `http://${req.headers.host}`);
    return json(res, 200, { logs: await readLogs(Number(url.searchParams.get('lines') || 120)) });
  }
  if (req.method === 'GET' && pathname === '/api/systemd') return text(res, 200, systemdUnit());
  if (req.method === 'GET' && pathname === '/api/files') {
    const url = new URL(req.url, `http://${req.headers.host}`);
    return json(res, 200, await listFiles(url.searchParams.get('path') || ''));
  }
  if (req.method === 'GET' && pathname === '/api/file') {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const { target } = await resolveServerPath(url.searchParams.get('path') || '');
    const stat = await fsp.stat(target);
    if (!stat.isFile()) throw Object.assign(new Error('File not found'), { status: 404 });
    res.writeHead(200, {
      'content-type': CONTENT_TYPES[path.extname(target)] || 'application/octet-stream',
      'content-disposition': `attachment; filename="${encodeURIComponent(path.basename(target))}"`
    });
    return fs.createReadStream(target).pipe(res);
  }
  if (req.method === 'POST' && pathname === '/api/config') {
    if (isRunning()) throw Object.assign(new Error('Stop the server before changing config'), { status: 409 });
    const current = await loadConfig();
    const config = validateConfig({ ...current, ...(await readJson(req)) });
    await saveConfig(config);
    return json(res, 200, { config: publicConfig(config) });
  }
  if (req.method === 'POST' && pathname === '/api/init') return json(res, 200, await initServer(Boolean((await readJson(req)).acceptEula)));
  if (req.method === 'POST' && pathname === '/api/start') return json(res, 200, await startServer());
  if (req.method === 'POST' && pathname === '/api/stop') return json(res, 200, await stopServer());
  if (req.method === 'POST' && pathname === '/api/command') return json(res, 200, sendCommand((await readJson(req)).command));
  if (req.method === 'POST' && pathname === '/api/backup') return json(res, 200, await backupServer());
  if (req.method === 'POST' && pathname === '/api/upload') {
    const url = new URL(req.url, `http://${req.headers.host}`);
    return json(res, 200, await uploadFile(req, url.searchParams.get('path') || ''));
  }
  if (req.method === 'POST' && pathname === '/api/mkdir') return json(res, 200, await makeDirectory((await readJson(req)).path));
  if (req.method === 'DELETE' && pathname === '/api/file') {
    const url = new URL(req.url, `http://${req.headers.host}`);
    return json(res, 200, await deleteFile(url.searchParams.get('path') || ''));
  }
  return json(res, 404, { error: 'API route not found' });
}

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (pathname.startsWith('/api/')) await handleApi(req, res, pathname);
    else await serveStatic(req, res, decodeURIComponent(pathname));
  } catch (error) {
    json(res, error.status || 500, { error: error.message || 'Server error' });
  }
});

ensureDataFiles().then(() => {
  server.listen(PORT, HOST, () => console.log(`mckanri web is running at http://${HOST}:${PORT}`));
});

process.on('SIGTERM', () => {
  if (isRunning()) minecraft.stdin.write('stop\n');
  server.close(() => process.exit(0));
});
