"use strict";

const $ = (selector) => document.querySelector(selector);
const form = $("#configForm");
let latestStatus = null;
let currentFilePath = "";
let currentParentPath = "";
let editingPath = "";

async function api(path, options = {}) {
  const headers =
    options.body instanceof FormData
      ? {}
      : { "content-type": "application/json" };
  const response = await fetch(path, {
    ...options,
    headers: { ...headers, ...(options.headers || {}) },
    body:
      options.body instanceof FormData
        ? options.body
        : options.body
          ? JSON.stringify(options.body)
          : undefined,
  });
  const contentType = response.headers.get("content-type") || "";
  const payload = contentType.includes("application/json")
    ? await response.json()
    : await response.text();
  if (!response.ok)
    throw new Error(payload.error || payload || `HTTP ${response.status}`);
  return payload;
}

function showMessage(value) {
  $("#messageBox").textContent =
    typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

function showLoginMessage(value) {
  $("#loginMessage").textContent = value;
}

function showPasswordSource(source) {
  $("#passwordSource").textContent = source
    ? `現在のパスワード指定: ${source}`
    : "";
}

function showApp(isAuthenticated) {
  $("#loginView").hidden = isAuthenticated;
  $("#appView").hidden = !isAuthenticated;
}

function setButtonLoading(button, isLoading) {
  if (!button) return;
  button.classList.toggle("is-loading", isLoading);
  button.disabled = isLoading;
  button.setAttribute("aria-busy", isLoading ? "true" : "false");
}

function fillConfig(config) {
  for (const [key, value] of Object.entries(config)) {
    if (!form.elements[key]) continue;
    form.elements[key].value = Array.isArray(value) ? value.join(" ") : value;
  }
  form.elements.adminPassword.value = "";
}

function collectConfig() {
  const config = {
    serverDir: form.elements.serverDir.value,
    jarPath: form.elements.jarPath.value,
    javaPath: form.elements.javaPath.value,
    minMemory: form.elements.minMemory.value,
    maxMemory: form.elements.maxMemory.value,
    backupDir: form.elements.backupDir.value,
    extraArgs: form.elements.extraArgs.value,
  };
  if (form.elements.adminPassword.value.trim())
    config.adminPassword = form.elements.adminPassword.value.trim();
  return config;
}

async function refreshStatus() {
  latestStatus = await api("/api/status");
  $("#statusText").textContent = latestStatus.running
    ? `起動中 PID: ${latestStatus.pid}`
    : "停止中";
  $("#startBtn").disabled = latestStatus.running;
  $("#stopBtn").disabled = !latestStatus.running;
  $("#restartBtn").disabled = false;
  fillConfig(latestStatus.config);
  await Promise.all([
    refreshLogs(),
    refreshFiles(currentFilePath),
    refreshPlayers(),
  ]);
}

async function refreshLogs() {
  const { logs } = await api("/api/logs?lines=160");
  $("#logs").textContent = logs || "ログはまだありません。";
}

async function refreshPlayers() {
  const root = $("#playersList");
  $("#playersText").textContent = "参加中プレイヤー: 読み込み中...";
  if (!latestStatus?.running) {
    $("#playersText").textContent = "参加中プレイヤー: サーバー停止中";
    root.innerHTML = "";
    return;
  }
  try {
    const data = await api("/api/players");
    if (data?.error) {
      $("#playersText").textContent = `参加中プレイヤー: ${data.error}`;
      root.innerHTML = "";
      const message = document.createElement("p");
      message.className = "muted";
      message.textContent = "一覧を取得できませんでした。";
      root.append(message);
      return;
    }
    const players = Array.isArray(data.players) ? data.players : [];
    const count = Number.isFinite(data.online) ? data.online : players.length;
    const max = Number.isFinite(data.max) ? data.max : "?";
    $("#playersText").textContent = `参加中プレイヤー (${count}/${max})`;
    renderPlayers(players);
  } catch (error) {
    $("#playersText").textContent = "参加中プレイヤー: 取得失敗";
    root.innerHTML = "";
    const message = document.createElement("p");
    message.className = "muted";
    message.textContent = error.message || "一覧の取得に失敗しました。";
    root.append(message);
  }
}

function renderPlayers(players) {
  const root = $("#playersList");
  root.innerHTML = "";
  if (!players.length) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = "現在参加中のプレイヤーはいません。";
    root.append(empty);
    return;
  }
  for (const player of players) {
    const row = document.createElement("div");
    row.className = "player-row";

    const face = document.createElement("div");
    face.className = "player-face";
    if (player.skinUrl) {
      const image = document.createElement("img");
      image.src = player.skinUrl;
      image.alt = `${player.name} のスキン`;
      image.loading = "lazy";
      face.append(image);
    } else {
      face.textContent = "?";
    }

    const info = document.createElement("div");
    info.className = "player-meta";
    const name = document.createElement("strong");
    name.textContent = player.name || "unknown";
    const uuid = document.createElement("span");
    uuid.className = "muted";
    uuid.textContent = player.uuid || "UUID取得不可";
    info.append(name, uuid);

    row.append(face, info);
    root.append(row);
  }
}

function humanSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function renderBreadcrumbs() {
  const breadcrumbs = $("#breadcrumbs");
  breadcrumbs.innerHTML = "";
  const root = document.createElement("button");
  root.type = "button";
  root.textContent = "server root";
  root.addEventListener("click", () =>
    refreshFiles("").catch((error) => showMessage(`エラー: ${error.message}`)),
  );
  breadcrumbs.append(root);
  let acc = "";
  for (const part of currentFilePath.split("/").filter(Boolean)) {
    acc = acc ? `${acc}/${part}` : part;
    const sep = document.createElement("span");
    sep.textContent = "/";
    const crumb = document.createElement("button");
    crumb.type = "button";
    crumb.textContent = part;
    const target = acc;
    crumb.addEventListener("click", () =>
      refreshFiles(target).catch((error) =>
        showMessage(`エラー: ${error.message}`),
      ),
    );
    breadcrumbs.append(sep, crumb);
  }
}

function rowButton(label, className = "") {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.className = className || "small-btn";
  return button;
}

function fileActionPath(name) {
  return currentFilePath ? `${currentFilePath}/${name}` : name;
}

async function openEditor(filePath) {
  const { path, content } = await api(
    `/api/file-text?path=${encodeURIComponent(filePath)}`,
  );
  editingPath = path;
  $("#editorTitle").textContent = `編集中: /${path}`;
  $("#fileEditor").value = content;
  $("#editorPanel").hidden = false;
  $("#fileEditor").focus();
}

async function refreshFiles(targetPath = "") {
  const data = await api(`/api/files?path=${encodeURIComponent(targetPath)}`);
  currentFilePath = data.path || "";
  currentParentPath = data.parent || "";
  $("#fileUpBtn").disabled = !currentFilePath;
  renderBreadcrumbs();
  $("#fileList").innerHTML = "";
  const header = document.createElement("div");
  header.className = "file-row file-header";
  header.innerHTML =
    "<strong>名前</strong><strong>サイズ</strong><strong>更新日</strong><strong>操作</strong>";
  $("#fileList").append(header);
  for (const entry of data.entries) {
    const row = document.createElement("div");
    row.className = "file-row";
    const name = rowButton(
      `${entry.type === "directory" ? "📁" : "📄"} ${entry.name}`,
      entry.type === "directory" ? "link directory" : "link",
    );
    name.addEventListener("click", () => {
      if (entry.type === "directory")
        refreshFiles(entry.path).catch((error) =>
          showMessage(`エラー: ${error.message}`),
        );
      else
        openEditor(entry.path).catch((error) =>
          showMessage(`エラー: ${error.message}`),
        );
    });
    const size = document.createElement("span");
    size.textContent = entry.type === "file" ? humanSize(entry.size) : "dir";
    const modified = document.createElement("span");
    modified.textContent = new Date(entry.modifiedAt).toLocaleString();
    const actions = document.createElement("div");
    actions.className = "row-actions";
    if (entry.type === "file") {
      const edit = rowButton("編集");
      edit.addEventListener("click", () =>
        openEditor(entry.path).catch((error) =>
          showMessage(`エラー: ${error.message}`),
        ),
      );
      const download = rowButton("DL");
      download.addEventListener("click", () =>
        window.open(
          `/api/file?path=${encodeURIComponent(entry.path)}`,
          "_blank",
        ),
      );
      actions.append(edit, download);
    }
    const rename = rowButton("名前変更");
    rename.addEventListener("click", () => {
      const nextName = prompt("新しい名前", entry.name);
      if (!nextName || nextName === entry.name) return;
      run(() =>
        api("/api/rename", {
          method: "POST",
          body: { from: entry.path, to: fileActionPath(nextName) },
        }),
      );
    });
    const del = rowButton("削除", "danger small-btn");
    del.addEventListener("click", () => {
      if (!confirm(`${entry.name} を削除しますか？`)) return;
      run(() =>
        api(`/api/file?path=${encodeURIComponent(entry.path)}`, {
          method: "DELETE",
        }),
      );
    });
    actions.append(rename, del);
    row.append(name, size, modified, actions);
    $("#fileList").append(row);
  }
}

async function run(action, options = {}) {
  const busyButton = options.busyButton || null;
  setButtonLoading(busyButton, true);
  try {
    showMessage("処理中...");
    const result = await action();
    showMessage(result || "完了");
    await refreshStatus();
  } catch (error) {
    if (error.message === "Login required") showApp(false);
    showMessage(`エラー: ${error.message}`);
  } finally {
    setButtonLoading(busyButton, false);
  }
}

async function uploadSelectedFile(fileInput, targetPath = "", options = {}) {
  const file = fileInput.files[0];
  if (!file) throw new Error("ファイルを選択してください");
  const body = new FormData();
  body.append("file", file);
  fileInput.value = "";
  const query = new URLSearchParams({ path: targetPath });
  if (options.setJarPath) query.set("setJarPath", "1");
  return api(`/api/upload?${query.toString()}`, { method: "POST", body });
}

$("#loginForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    showLoginMessage("ログイン中...");
    await api("/api/login", {
      method: "POST",
      body: { password: $("#passwordInput").value },
    });
    $("#passwordInput").value = "";
    showApp(true);
    showLoginMessage("");
    await refreshStatus();
  } catch (error) {
    showLoginMessage(`エラー: ${error.message}`);
  }
});

$("#logoutBtn").addEventListener("click", async () => {
  await api("/api/logout", { method: "POST" }).catch(() => {});
  showApp(false);
});

form.addEventListener("submit", (event) => {
  event.preventDefault();
  run(() => api("/api/config", { method: "POST", body: collectConfig() }));
});

$("#initBtn").addEventListener("click", () => {
  if (
    !confirm(
      "MojangのEULAに同意済みとして eula=true を作成します。続行しますか？",
    )
  )
    return;
  run(() => api("/api/init", { method: "POST", body: { acceptEula: true } }));
});
$("#startBtn").addEventListener("click", () =>
  run(() => api("/api/start", { method: "POST" })),
);
$("#stopBtn").addEventListener("click", () =>
  run(() => api("/api/stop", { method: "POST" })),
);
$("#restartBtn").addEventListener("click", () =>
  run(() => api("/api/restart", { method: "POST" }), {
    busyButton: $("#restartBtn"),
  }),
);
$("#refreshBtn").addEventListener("click", () => run(refreshStatus));
$("#reloadLogsBtn").addEventListener("click", () => run(refreshLogs));
$("#backupBtn").addEventListener("click", () =>
  run(() => api("/api/backup", { method: "POST" })),
);
$("#systemdBtn").addEventListener("click", async () => {
  try {
    showMessage(await (await fetch("/api/systemd")).text());
  } catch (error) {
    showMessage(`エラー: ${error.message}`);
  }
});
$("#commandForm").addEventListener("submit", (event) => {
  event.preventDefault();
  const command = $("#commandInput").value;
  $("#commandInput").value = "";
  run(() => api("/api/command", { method: "POST", body: { command } }));
});
$("#jarUploadForm").addEventListener("submit", (event) => {
  event.preventDefault();
  run(() => uploadSelectedFile($("#jarFileInput"), "", { setJarPath: true }));
});
$("#fileUploadForm").addEventListener("submit", (event) => {
  event.preventDefault();
  run(() => uploadSelectedFile($("#fileInput"), currentFilePath));
});
$("#fileUpBtn").addEventListener("click", () =>
  run(() => refreshFiles(currentParentPath)),
);
$("#newFileBtn").addEventListener("click", () => {
  const name = prompt("作成するファイル名", "server.properties");
  if (!name) return;
  run(() =>
    api("/api/file", {
      method: "PUT",
      body: { path: fileActionPath(name), content: "" },
    }),
  );
});
$("#newDirBtn").addEventListener("click", () => {
  const name = prompt("作成するフォルダ名");
  if (!name) return;
  run(() =>
    api("/api/mkdir", { method: "POST", body: { path: fileActionPath(name) } }),
  );
});
$("#saveFileBtn").addEventListener("click", () => {
  if (!editingPath) return;
  run(() =>
    api("/api/file", {
      method: "PUT",
      body: { path: editingPath, content: $("#fileEditor").value },
    }),
  );
});
$("#closeEditorBtn").addEventListener("click", () => {
  $("#editorPanel").hidden = true;
  editingPath = "";
});
$("#dropZone").addEventListener("dragover", (event) => {
  event.preventDefault();
  $("#dropZone").classList.add("dragging");
});
$("#dropZone").addEventListener("dragleave", () =>
  $("#dropZone").classList.remove("dragging"),
);
$("#dropZone").addEventListener("drop", (event) => {
  event.preventDefault();
  $("#dropZone").classList.remove("dragging");
  const file = event.dataTransfer.files[0];
  if (!file) return;
  const body = new FormData();
  body.append("file", file);
  run(() =>
    api(`/api/upload?path=${encodeURIComponent(currentFilePath)}`, {
      method: "POST",
      body,
    }),
  );
});

api("/api/session")
  .then(async ({ authenticated, passwordSource }) => {
    showPasswordSource(passwordSource);
    showApp(authenticated);
    if (authenticated) await refreshStatus();
  })
  .catch(() => showApp(false));

setInterval(() => {
  if (!$("#appView").hidden && latestStatus?.running) {
    Promise.all([refreshLogs(), refreshPlayers()]).catch(() => {});
  }
}, 5000);
