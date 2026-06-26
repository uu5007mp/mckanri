'use strict';

const $ = (selector) => document.querySelector(selector);
const form = $('#configForm');
let latestStatus = null;
let currentFilePath = '';
let currentParentPath = '';

async function api(path, options = {}) {
  const headers = options.body instanceof FormData ? {} : { 'content-type': 'application/json' };
  const response = await fetch(path, {
    ...options,
    headers: { ...headers, ...(options.headers || {}) },
    body: options.body instanceof FormData ? options.body : options.body ? JSON.stringify(options.body) : undefined
  });
  const contentType = response.headers.get('content-type') || '';
  const payload = contentType.includes('application/json') ? await response.json() : await response.text();
  if (!response.ok) throw new Error(payload.error || payload || `HTTP ${response.status}`);
  return payload;
}

function showMessage(value) {
  $('#messageBox').textContent = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}

function showLoginMessage(value) {
  $('#loginMessage').textContent = value;
}

function showApp(isAuthenticated) {
  $('#loginView').hidden = isAuthenticated;
  $('#appView').hidden = !isAuthenticated;
}

function fillConfig(config) {
  for (const [key, value] of Object.entries(config)) {
    if (!form.elements[key]) continue;
    form.elements[key].value = Array.isArray(value) ? value.join(' ') : value;
  }
  form.elements.adminPassword.value = '';
}

function collectConfig() {
  const config = {
    serverDir: form.elements.serverDir.value,
    jarPath: form.elements.jarPath.value,
    javaPath: form.elements.javaPath.value,
    minMemory: form.elements.minMemory.value,
    maxMemory: form.elements.maxMemory.value,
    backupDir: form.elements.backupDir.value,
    extraArgs: form.elements.extraArgs.value
  };
  if (form.elements.adminPassword.value.trim()) config.adminPassword = form.elements.adminPassword.value.trim();
  return config;
}

async function refreshStatus() {
  latestStatus = await api('/api/status');
  $('#statusText').textContent = latestStatus.running ? `起動中 PID: ${latestStatus.pid}` : '停止中';
  $('#startBtn').disabled = latestStatus.running;
  $('#stopBtn').disabled = !latestStatus.running;
  fillConfig(latestStatus.config);
  await Promise.all([refreshLogs(), refreshFiles(currentFilePath)]);
}

async function refreshLogs() {
  const { logs } = await api('/api/logs?lines=160');
  $('#logs').textContent = logs || 'ログはまだありません。';
}

function humanSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

async function refreshFiles(targetPath = '') {
  const data = await api(`/api/files?path=${encodeURIComponent(targetPath)}`);
  currentFilePath = data.path || '';
  currentParentPath = data.parent || '';
  $('#filePath').textContent = `/${currentFilePath}`;
  $('#fileUpBtn').disabled = !currentFilePath;
  $('#fileList').innerHTML = '';
  for (const entry of data.entries) {
    const row = document.createElement('div');
    row.className = 'file-row';
    const name = document.createElement('button');
    name.type = 'button';
    name.className = entry.type === 'directory' ? 'link directory' : 'link';
    name.textContent = `${entry.type === 'directory' ? '📁' : '📄'} ${entry.name}`;
    name.addEventListener('click', () => {
      if (entry.type === 'directory') refreshFiles(entry.path).catch((error) => showMessage(`エラー: ${error.message}`));
      else window.open(`/api/file?path=${encodeURIComponent(entry.path)}`, '_blank');
    });
    const meta = document.createElement('span');
    meta.textContent = `${entry.type === 'file' ? humanSize(entry.size) : 'dir'} / ${new Date(entry.modifiedAt).toLocaleString()}`;
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'danger small-btn';
    del.textContent = '削除';
    del.addEventListener('click', () => {
      if (!confirm(`${entry.name} を削除しますか？`)) return;
      run(() => api(`/api/file?path=${encodeURIComponent(entry.path)}`, { method: 'DELETE' }));
    });
    row.append(name, meta, del);
    $('#fileList').append(row);
  }
}

async function run(action) {
  try {
    showMessage('処理中...');
    const result = await action();
    showMessage(result || '完了');
    await refreshStatus();
  } catch (error) {
    if (error.message === 'Login required') showApp(false);
    showMessage(`エラー: ${error.message}`);
  }
}

async function uploadSelectedFile(fileInput, targetPath = '') {
  const file = fileInput.files[0];
  if (!file) throw new Error('ファイルを選択してください');
  const body = new FormData();
  body.append('file', file);
  fileInput.value = '';
  return api(`/api/upload?path=${encodeURIComponent(targetPath)}`, { method: 'POST', body });
}

$('#loginForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    showLoginMessage('ログイン中...');
    await api('/api/login', { method: 'POST', body: { password: $('#passwordInput').value } });
    $('#passwordInput').value = '';
    showApp(true);
    showLoginMessage('');
    await refreshStatus();
  } catch (error) {
    showLoginMessage(`エラー: ${error.message}`);
  }
});

$('#logoutBtn').addEventListener('click', async () => {
  await api('/api/logout', { method: 'POST' }).catch(() => {});
  showApp(false);
});

form.addEventListener('submit', (event) => {
  event.preventDefault();
  run(() => api('/api/config', { method: 'POST', body: collectConfig() }));
});

$('#initBtn').addEventListener('click', () => {
  if (!confirm('MojangのEULAに同意済みとして eula=true を作成します。続行しますか？')) return;
  run(() => api('/api/init', { method: 'POST', body: { acceptEula: true } }));
});
$('#startBtn').addEventListener('click', () => run(() => api('/api/start', { method: 'POST' })));
$('#stopBtn').addEventListener('click', () => run(() => api('/api/stop', { method: 'POST' })));
$('#refreshBtn').addEventListener('click', () => run(refreshStatus));
$('#reloadLogsBtn').addEventListener('click', () => run(refreshLogs));
$('#backupBtn').addEventListener('click', () => run(() => api('/api/backup', { method: 'POST' })));
$('#systemdBtn').addEventListener('click', async () => {
  try { showMessage(await (await fetch('/api/systemd')).text()); }
  catch (error) { showMessage(`エラー: ${error.message}`); }
});
$('#commandForm').addEventListener('submit', (event) => {
  event.preventDefault();
  const command = $('#commandInput').value;
  $('#commandInput').value = '';
  run(() => api('/api/command', { method: 'POST', body: { command } }));
});
$('#jarUploadForm').addEventListener('submit', (event) => {
  event.preventDefault();
  run(() => uploadSelectedFile($('#jarFileInput'), ''));
});
$('#fileUploadForm').addEventListener('submit', (event) => {
  event.preventDefault();
  run(() => uploadSelectedFile($('#fileInput'), currentFilePath));
});
$('#fileUpBtn').addEventListener('click', () => run(() => refreshFiles(currentParentPath)));
$('#newDirBtn').addEventListener('click', () => {
  const name = prompt('作成するフォルダ名');
  if (!name) return;
  const target = currentFilePath ? `${currentFilePath}/${name}` : name;
  run(() => api('/api/mkdir', { method: 'POST', body: { path: target } }));
});

api('/api/session').then(async ({ authenticated }) => {
  showApp(authenticated);
  if (authenticated) await refreshStatus();
}).catch(() => showApp(false));

setInterval(() => {
  if (!$('#appView').hidden && latestStatus?.running) refreshLogs().catch(() => {});
}, 5000);
