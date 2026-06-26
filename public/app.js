'use strict';

const $ = (selector) => document.querySelector(selector);
const form = $('#configForm');
let latestStatus = null;

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const contentType = response.headers.get('content-type') || '';
  const payload = contentType.includes('application/json') ? await response.json() : await response.text();
  if (!response.ok) {
    throw new Error(payload.error || payload || `HTTP ${response.status}`);
  }
  return payload;
}

function showMessage(value) {
  $('#messageBox').textContent = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}

function fillConfig(config) {
  for (const [key, value] of Object.entries(config)) {
    if (!form.elements[key]) continue;
    form.elements[key].value = Array.isArray(value) ? value.join(' ') : value;
  }
}

function collectConfig() {
  return {
    serverDir: form.elements.serverDir.value,
    jarPath: form.elements.jarPath.value,
    javaPath: form.elements.javaPath.value,
    minMemory: form.elements.minMemory.value,
    maxMemory: form.elements.maxMemory.value,
    backupDir: form.elements.backupDir.value,
    extraArgs: form.elements.extraArgs.value
  };
}

async function refreshStatus() {
  latestStatus = await api('/api/status');
  $('#statusText').textContent = latestStatus.running ? `起動中 PID: ${latestStatus.pid}` : '停止中';
  $('#startBtn').disabled = latestStatus.running;
  $('#stopBtn').disabled = !latestStatus.running;
  fillConfig(latestStatus.config);
  await refreshLogs();
}

async function refreshLogs() {
  const { logs } = await api('/api/logs?lines=160');
  $('#logs').textContent = logs || 'ログはまだありません。';
}

async function run(action) {
  try {
    showMessage('処理中...');
    const result = await action();
    showMessage(result || '完了');
    await refreshStatus();
  } catch (error) {
    showMessage(`エラー: ${error.message}`);
  }
}

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
  try {
    showMessage(await (await fetch('/api/systemd')).text());
  } catch (error) {
    showMessage(`エラー: ${error.message}`);
  }
});
$('#commandForm').addEventListener('submit', (event) => {
  event.preventDefault();
  const command = $('#commandInput').value;
  $('#commandInput').value = '';
  run(() => api('/api/command', { method: 'POST', body: { command } }));
});

refreshStatus();
setInterval(() => {
  if (latestStatus?.running) refreshLogs().catch(() => {});
}, 5000);
