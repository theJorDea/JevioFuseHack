const $ = (id) => document.getElementById(id);

const els = {
  app: $("app"),
  sidebar: $("sidebar"),
  chat: $("chat"),
  empty: $("empty-state"),
  live: $("live"),
  liveText: $("live-text"),
  todos: $("todos"),
  input: $("input"),
  send: $("send"),
  stop: $("stop"),
  form: $("composer"),
  sessions: $("sessions"),
  sessionSearch: $("session-search"),
  sessionSearchClear: $("session-search-clear"),
  sessionCount: $("session-count"),
  meta: $("meta"),
  title: $("title"),
  subtitle: $("subtitle"),
  workspaceTrigger: $("workspace-trigger"),
  pill: $("status-pill"),
  statusPopover: $("status-popover"),
  statusConnection: $("status-connection"),
  statusProvider: $("status-provider"),
  statusModel: $("status-model"),
  modeChip: $("mode-chip"),
  modeChipLabel: $("mode-chip-label"),
  yolo: $("yolo"),
  mode: $("mode"),
  btnNew: $("btn-new"),
  btnSettings: $("btn-settings"),
  btnSettings2: $("btn-settings-2"),
  btnSidebar: $("btn-sidebar"),
  btnCollapseSidebar: $("btn-collapse-sidebar"),
  settings: $("settings"),
  settingsBackdrop: $("settings-backdrop"),
  settingsClose: $("settings-close"),
  setProvider: $("set-provider"),
  setApplyDefaultModel: $("set-apply-default-model"),
  setModel: $("set-model"),
  setModelCustom: $("set-model-custom"),
  btnRefreshModels: $("btn-refresh-models"),
  btnApplyConfig: $("btn-apply-config"),
  settingsMsg: $("settings-msg"),
  rolesTable: $("roles-table"),
  envInfo: $("env-info"),
  setTheme: $("set-theme"),
  setCompact: $("set-compact"),
  modal: $("modal"),
  modalKicker: $("modal-kicker"),
  modalTitle: $("modal-title"),
  modalBody: $("modal-body"),
  modalOptions: $("modal-options"),
  modalOk: $("modal-ok"),
  modalCancel: $("modal-cancel"),
  modalCustomWrap: $("modal-custom-wrap"),
  modalCustom: $("modal-custom"),
  modalCustomSend: $("modal-custom-send"),
  suggestions: $("suggestions"),
  composerHint: $("composer-hint"),
  btnAttach: $("btn-attach"),
  attachmentMenu: $("attachment-menu"),
  btnAttachFiles: $("btn-attach-files"),
  btnAttachFolder: $("btn-attach-folder"),
  fileInput: $("file-input"),
  folderInput: $("folder-input"),
  attachments: $("attachments"),
};

const PREFS_KEY = "fuse-web-prefs";

let state = {
  busy: false,
  sessionId: null,
  pendingId: null,
  pendingKind: null,
  settings: null,
  serverBusy: false,
  activeTask: null,
  activeDetail: null,
  sessions: [],
  abortController: null,
  stopRequested: false,
  attachments: [],
  localConfirmAction: null,
};

let recoveryTimer = null;
let todosCollapsed = true;

function loadPrefs() {
  try {
    return JSON.parse(localStorage.getItem(PREFS_KEY) || "{}");
  } catch {
    return {};
  }
}

function savePrefs(patch) {
  const next = { ...loadPrefs(), ...patch };
  localStorage.setItem(PREFS_KEY, JSON.stringify(next));
  applyPrefs(next);
}

function applyPrefs(prefs = loadPrefs()) {
  const theme = prefs.theme || "dark";
  if (theme === "system") {
    const dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    document.documentElement.dataset.theme = dark ? "dark" : "light";
  } else {
    document.documentElement.dataset.theme = theme;
  }
  document.body.classList.toggle("compact", Boolean(prefs.compact));
  const sidebarCollapsed = Boolean(prefs.sidebarCollapsed);
  els.app.classList.toggle("sidebar-collapsed", sidebarCollapsed);
  if (els.btnCollapseSidebar) {
    els.btnCollapseSidebar.title = sidebarCollapsed ? "Развернуть список сессий" : "Свернуть список сессий";
    els.btnCollapseSidebar.setAttribute("aria-label", els.btnCollapseSidebar.title);
  }
  if (els.setTheme) els.setTheme.value = theme;
  if (els.setCompact) els.setCompact.checked = Boolean(prefs.compact);
}

const MODE_LABELS = {
  orchestrate: "оркестрация",
  direct: "напрямую",
  plan: "план",
  team: "команда",
  "council-plan": "совет · план",
  "council-review": "совет · ревью",
};

function modeLabel(mode) {
  return MODE_LABELS[mode] || mode || "режим";
}

function displaySessionTitle(title) {
  return title === "New session" ? "Новая сессия" : title || "Новая сессия";
}

function setPill(kind, text) {
  els.pill.className = `pill ${kind}`;
  els.pill.setAttribute("aria-label", `Состояние: ${text}`);
  const txt = els.pill.querySelector(".txt");
  if (txt) txt.textContent = text;
  else els.pill.textContent = text;
}

function hideEmpty() {
  els.empty?.classList.add("hidden");
}

function showEmptyIfNeeded() {
  if (!els.chat.querySelector(".bubble") && els.empty) {
    els.empty.classList.remove("hidden");
  }
}

function isNoiseLive(text) {
  const t = String(text || "").trim();
  if (!t) return true;
  // single punctuation / ellipsis / bare role spam
  if (t.length <= 2 && !/[A-Za-zА-Яа-я0-9]/.test(t)) return true;
  if (/^\[?\w+\]?\s*[.…]?$/.test(t) && t.length < 8) return true;
  return false;
}

function looksLikeFullDocument(text) {
  const t = text.trim();
  return (
    /^<!DOCTYPE\s+html/i.test(t)
    || /^<html[\s>]/i.test(t)
    || (t.includes("<!DOCTYPE") && t.includes("</html>"))
    || (t.split("\n").length > 40 && /<(div|body|script|style|head)\b/i.test(t))
  );
}

function simpleMarkdown(text) {
  if (!text) return "";
  // Full HTML/site dumps → code block (don't render as live HTML — XSS + broken layout)
  if (looksLikeFullDocument(text)) {
    return `<div class="doc-wrap"><div class="doc-label">HTML / файл</div><pre class="doc"><code>${escapeHtml(text)}</code></pre></div>`;
  }

  // Split fenced code blocks first so we don't mutate them
  const chunks = [];
  const fence = /```([a-zA-Z0-9_-]*)\n?([\s\S]*?)```/g;
  let last = 0;
  let match;
  while ((match = fence.exec(text)) !== null) {
    if (match.index > last) chunks.push({ type: "text", value: text.slice(last, match.index) });
    chunks.push({ type: "code", lang: match[1] || "", value: match[2].replace(/\n$/, "") });
    last = match.index + match[0].length;
  }
  if (last < text.length) chunks.push({ type: "text", value: text.slice(last) });
  if (!chunks.length) chunks.push({ type: "text", value: text });

  return chunks.map((chunk) => {
    if (chunk.type === "code") {
      const lang = chunk.lang ? ` data-lang="${escapeHtml(chunk.lang)}"` : "";
      return `<pre class="codeblock"${lang}><code>${escapeHtml(chunk.value)}</code></pre>`;
    }
    let html = escapeHtml(chunk.value);
    html = html.replace(/^### (.+)$/gm, "<h4>$1</h4>");
    html = html.replace(/^## (.+)$/gm, "<h3>$1</h3>");
    html = html.replace(/^# (.+)$/gm, "<h3>$1</h3>");
    html = html.replace(/^\s*[-*] (.+)$/gm, "<li>$1</li>");
    html = html.replace(/(?:<li>.*<\/li>\n?)+/g, (block) => `<ul>${block}</ul>`);
    html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    html = html.replace(/`([^`\n]+)`/g, "<code>$1</code>");
    // paragraphs: keep line breaks for remaining text
    html = html.replace(/\n{2,}/g, "</p><p>");
    html = html.replace(/\n/g, "<br>");
    if (!html.startsWith("<")) html = `<p>${html}</p>`;
    return html;
  }).join("");
}

function appendBubble(role, content, { markdown = false } = {}) {
  hideEmpty();
  const div = document.createElement("div");
  div.className = `bubble ${role}`;
  const who = document.createElement("div");
  who.className = "who";
  who.textContent = role === "user" ? "вы" : role === "assistant" ? "fuse" : "система";
  const body = document.createElement("div");
  body.className = markdown && role === "assistant" ? "body md" : "body";
  if (markdown && role === "assistant") body.innerHTML = simpleMarkdown(content);
  else body.textContent = content;

  // Long answers: scrollable + expand
  const long = String(content || "").length > 1_200 || String(content || "").split("\n").length > 24;
  if (long && role === "assistant") {
    body.classList.add("clamp");
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "expand-btn";
    toggle.textContent = "Показать полностью";
    toggle.addEventListener("click", () => {
      body.classList.toggle("clamp");
      toggle.textContent = body.classList.contains("clamp") ? "Показать полностью" : "Свернуть";
    });
    div.append(who, body, toggle);
  } else {
    div.append(who, body);
  }

  els.chat.appendChild(div);
  els.chat.scrollTop = els.chat.scrollHeight;
  return body;
}

function setLive(text) {
  const clean = String(text || "").trim();
  if (!clean || isNoiseLive(clean)) {
    // keep previous meaningful line while busy; hide only on explicit clear ("")
    if (!text) {
      els.live.classList.add("hidden");
      if (els.liveText) els.liveText.textContent = "";
      els.live.removeAttribute("title");
    }
    return;
  }
  els.live.classList.remove("hidden");
  els.live.title = clean;
  if (els.liveText) els.liveText.textContent = clean;
  else els.live.textContent = clean;
  els.live.scrollTop = els.live.scrollHeight;
}

function renderTodos(items) {
  if (!items?.length) {
    els.todos.classList.add("hidden");
    els.todos.innerHTML = "";
    return;
  }
  const done = items.filter((i) => i.status === "completed").length;
  const lines = items.map((item) => {
    const cls = item.status === "completed" ? "done" : item.status === "in_progress" ? "active" : "";
    const mark = item.status === "completed" ? "●" : item.status === "in_progress" ? "►" : "○";
    return `<li class="${cls}"><span>${mark}</span><span>${escapeHtml(item.content)}</span></li>`;
  });
  els.todos.classList.remove("hidden");
  els.todos.classList.toggle("collapsed", todosCollapsed);
  els.todos.innerHTML = `<div class="todo-head"><h3>Чеклист · ${done}/${items.length}</h3><button type="button" class="todo-toggle">${todosCollapsed ? "Показать" : "Свернуть"}</button></div><ul>${lines.join("")}</ul>`;
  els.todos.querySelector(".todo-toggle")?.addEventListener("click", () => {
    todosCollapsed = !todosCollapsed;
    renderTodos(items);
  });
  els.todos.scrollTop = 0;
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || res.statusText);
  }
  const type = res.headers.get("content-type") || "";
  if (type.includes("application/json")) return res.json();
  return res.text();
}

function openSettings() {
  els.settings.classList.remove("hidden");
  els.settingsBackdrop.classList.remove("hidden");
  void loadSettingsPanel();
}

function closeSettings() {
  els.settings.classList.add("hidden");
  els.settingsBackdrop.classList.add("hidden");
}

function setSettingsMsg(text, kind = "") {
  els.settingsMsg.textContent = text || "";
  els.settingsMsg.className = `settings-msg muted${kind ? ` ${kind}` : ""}`;
}

async function loadSettingsPanel() {
  setSettingsMsg("Загрузка…");
  try {
    const settings = await api("/api/settings");
    state.settings = settings;
    els.mode.value = settings.mode;
    els.yolo.checked = Boolean(settings.yolo);
    els.modeChipLabel.textContent = modeLabel(settings.mode);

    els.setProvider.innerHTML = settings.providers.map((p) =>
      `<option value="${escapeHtml(p.name)}" ${p.name === settings.currentProvider ? "selected" : ""}>${escapeHtml(p.name)}${p.isDefault ? " · по умолчанию" : ""}</option>`,
    ).join("");

    els.rolesTable.innerHTML = settings.roles.map((r) =>
      `<div class="role-row"><div class="r">${escapeHtml(r.role)}</div><div class="m">${escapeHtml(r.provider)} / ${escapeHtml(r.model)}</div></div>`,
    ).join("");

    els.envInfo.innerHTML = [
      `<div><b>Рабочая папка</b><br>${escapeHtml(settings.workspace)}</div>`,
      `<div style="margin-top:8px"><b>Провайдер</b><br>${escapeHtml(settings.currentProvider)}</div>`,
      `<div style="margin-top:8px"><b>Модель</b><br>${escapeHtml(settings.currentModel)}</div>`,
      `<div style="margin-top:8px"><b>Команды оболочки</b><br>${escapeHtml(settings.permissions.shellMode)}</div>`,
    ].join("");

    await refreshModelSelect(settings.currentProvider, settings.currentModel);
    setSettingsMsg("");
  } catch (error) {
    setSettingsMsg(error.message, "err");
  }
}

async function refreshModelSelect(provider, current) {
  const data = await api(`/api/models?provider=${encodeURIComponent(provider || "")}`);
  const models = data.models?.length ? data.models : [current].filter(Boolean);
  const activeModel = current || data.current || models[0] || "";
  const customModel = Boolean(activeModel && !models.includes(activeModel));
  els.setModel.innerHTML = [
    ...models.map((m) => `<option value="${escapeHtml(m)}">${escapeHtml(m)}</option>`),
    `<option value="__custom__">Свой ID модели…</option>`,
  ].join("");
  els.setModel.value = customModel ? "__custom__" : activeModel;
  els.setModelCustom.value = customModel ? activeModel : "";
  syncCustomModelInput();
}

function syncCustomModelInput() {
  const custom = els.setModel.value === "__custom__";
  els.setModelCustom.disabled = !custom;
  els.setModelCustom.placeholder = custom ? "например qwen3-coder:30b" : "Выбери «Свой ID» выше";
  if (!custom) els.setModelCustom.value = "";
}

async function refreshStatus() {
  const status = await api("/api/status");
  state.sessionId = status.sessionId;
  state.serverBusy = Boolean(status.busy);
  state.activeTask = status.activeTask || null;
  state.activeDetail = status.activeDetail || null;
  els.title.textContent = displaySessionTitle(status.title);
  els.subtitle.textContent = shortPath(status.workspace);
  els.meta.innerHTML = [
    `<div><b>Рабочая папка</b><br>${escapeHtml(shortPath(status.workspace))}</div>`,
    `<div style="margin-top:8px"><b>Сессия</b><br><span class="meta-mono">${escapeHtml(status.sessionId.slice(0, 8))}</span> · ${status.messageCount} сообщ.</div>`,
  ].join("");
  els.mode.value = status.mode;
  els.modeChipLabel.textContent = modeLabel(status.mode);
  els.yolo.checked = Boolean(status.yolo);
  els.composerHint.textContent = `${status.provider} · ${status.model}`;
  els.statusConnection.textContent = status.busy ? "выполняется" : "подключено";
  els.statusProvider.textContent = status.provider || "—";
  els.statusModel.textContent = status.model || "—";
  renderTodos(status.todos);
  setPill(status.busy ? "busy" : "idle", status.busy ? "работает…" : "готов");
  if (status.busy) setLive(status.activeDetail || "работает…");
  return status;
}

function shortPath(p) {
  if (!p) return "";
  const parts = String(p).replace(/\\/g, "/").split("/");
  return parts.slice(-2).join("/") || p;
}

function formatSessionMeta(session) {
  const count = Number(session.messageCount || 0);
  const date = new Date(session.updatedAt);
  const dayLabel = Number.isNaN(date.getTime())
    ? ""
    : date.toDateString() === new Date().toDateString()
      ? "сегодня"
      : date.toLocaleDateString("ru-RU", { day: "numeric", month: "short" });
  return { count, dayLabel };
}

async function refreshSessions() {
  state.sessions = await api("/api/sessions");
  renderSessions();
}

function renderSessions() {
  const query = (els.sessionSearch?.value || "").trim().toLowerCase();
  const sessions = state.sessions.filter((session) =>
    !query || `${session.title} ${session.id}`.toLowerCase().includes(query));
  if (els.sessionCount) els.sessionCount.textContent = state.sessions.length ? String(state.sessions.length) : "";
  els.sessions.innerHTML = "";
  if (!sessions.length) {
    els.sessions.innerHTML = `<div class="muted session-empty">${query ? "Ничего не найдено" : "Пока нет сессий"}</div>`;
    return;
  }
  for (const session of sessions) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `session-item${session.id === state.sessionId ? " active" : ""}`;
    const meta = formatSessionMeta(session);
    btn.innerHTML = `<div class="t">${escapeHtml(displaySessionTitle(session.title))}</div><div class="s"><span class="message-badge">${meta.count}</span><span>${escapeHtml(meta.dayLabel || "без даты")}</span></div>`;
    btn.addEventListener("click", async () => {
      await api("/api/sessions/resume", { method: "POST", body: JSON.stringify({ id: session.id }) });
      els.chat.querySelectorAll(".bubble").forEach((n) => n.remove());
      showEmptyIfNeeded();
      appendBubble("system", `Сессия: ${displaySessionTitle(session.title)}`);
      await refreshStatus();
      await refreshHistory();
      await refreshSessions();
      closeSettings();
      els.sidebar.classList.remove("open");
    });
    els.sessions.appendChild(btn);
  }
}

els.sessionSearch?.addEventListener("input", () => {
  els.sessionSearchClear?.classList.toggle("hidden", !els.sessionSearch.value);
  renderSessions();
});
els.sessionSearchClear?.addEventListener("click", () => {
  els.sessionSearch.value = "";
  els.sessionSearchClear.classList.add("hidden");
  renderSessions();
  els.sessionSearch.focus();
});

async function refreshHistory() {
  const data = await api("/api/history");
  els.chat.querySelectorAll(".bubble").forEach((node) => node.remove());
  for (const message of data.messages || []) {
    if (message.role !== "user" && message.role !== "assistant") continue;
    appendBubble(message.role, message.content, { markdown: message.role === "assistant" });
  }
  if (state.serverBusy && state.activeTask && !data.messages?.some(
    (message) => message.role === "user" && message.content === state.activeTask,
  )) {
    appendBubble("user", state.activeTask);
    setLive(state.activeDetail || "работает…");
  }
  showEmptyIfNeeded();
  els.chat.scrollTop = els.chat.scrollHeight;
}

function startRecoveryPolling() {
  if (recoveryTimer) return;
  const poll = async () => {
    recoveryTimer = null;
    try {
      const status = await refreshStatus();
      if (status.busy) {
        recoveryTimer = window.setTimeout(poll, 1200);
        return;
      }
      state.busy = false;
      setBusyControls(false);
      setLive("");
      await refreshHistory();
      await refreshSessions();
      els.input.focus();
    } catch (error) {
      console.error("Failed to recover active chat", error);
      recoveryTimer = window.setTimeout(poll, 2000);
    }
  };
  recoveryTimer = window.setTimeout(poll, 1200);
}

function openModal({ title, body, options = [], kind, id, kicker }) {
  state.localConfirmAction = null;
  state.pendingId = id;
  state.pendingKind = kind;
  els.modalKicker.textContent = kicker || (kind === "ask" ? "Вопрос" : "Подтверждение");
  els.modalTitle.textContent = title;
  els.modalBody.textContent = body;
  els.modalOptions.innerHTML = "";
  els.modalCustomWrap.classList.add("hidden");
  els.modalCustom.value = "";

  if (kind === "ask") {
    els.modalOk.classList.add("hidden");
    for (const option of options) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "btn secondary";
      btn.textContent = option.label;
      if (option.description) btn.title = option.description;
      btn.addEventListener("click", () => answerPending(option.label));
      els.modalOptions.appendChild(btn);
    }
    const other = document.createElement("button");
    other.type = "button";
    other.className = "btn secondary";
    other.textContent = "Другое…";
    other.addEventListener("click", () => {
      els.modalCustomWrap.classList.remove("hidden");
      els.modalCustom.focus();
    });
    els.modalOptions.appendChild(other);
  } else {
    els.modalOk.classList.remove("hidden");
  }

  els.modal.classList.remove("hidden");
}

function openLocalConfirm({ title, body, kicker, onConfirm }) {
  openModal({ title, body, kind: "local-confirm", kicker });
  state.localConfirmAction = onConfirm;
}

function closeModal() {
  els.modal.classList.add("hidden");
  state.pendingId = null;
  state.pendingKind = null;
  state.localConfirmAction = null;
}

async function answerPending(answer) {
  if (!state.pendingId) return;
  const id = state.pendingId;
  state.pendingId = null;
  state.pendingKind = null;
  els.modal.classList.add("hidden");
  await api("/api/interact", {
    method: "POST",
    body: JSON.stringify({ id, answer }),
  });
}

// —— events ——
els.modalOk.addEventListener("click", async () => {
  if (state.localConfirmAction) {
    const action = state.localConfirmAction;
    closeModal();
    await action();
    return;
  }
  await answerPending(true);
});
els.modalCancel.addEventListener("click", async () => {
  if (state.localConfirmAction) {
    closeModal();
    return;
  }
  await answerPending(state.pendingKind === "confirm" ? false : "[cancelled]");
});
els.modalCustomSend.addEventListener("click", () => {
  const value = els.modalCustom.value.trim();
  if (value) answerPending(value);
});
els.modalCustom.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    els.modalCustomSend.click();
  }
});

els.yolo.addEventListener("change", async () => {
  if (els.yolo.checked) {
    els.yolo.checked = false;
    openLocalConfirm({
      kicker: "Опасный режим",
      title: "Включить YOLO?",
      body: "Агент сможет выполнять shell-команды и записывать файлы без вашего подтверждения. Включайте режим только для доверенного проекта.",
      onConfirm: async () => {
        try {
          await api("/api/yolo", { method: "POST", body: JSON.stringify({ on: true }) });
          els.yolo.checked = true;
          await refreshStatus();
        } catch (error) {
          setSettingsMsg(error.message, "err");
        }
      },
    });
    return;
  }
  await api("/api/yolo", { method: "POST", body: JSON.stringify({ on: false }) });
  await refreshStatus();
});
els.mode.addEventListener("change", async () => {
  await api("/api/mode", { method: "POST", body: JSON.stringify({ mode: els.mode.value }) });
  await refreshStatus();
});

els.btnSettings?.addEventListener("click", openSettings);
els.btnSettings2.addEventListener("click", openSettings);
els.settingsClose.addEventListener("click", closeSettings);
els.settingsBackdrop.addEventListener("click", closeSettings);
els.btnSidebar?.addEventListener("click", () => els.sidebar.classList.toggle("open"));
els.btnCollapseSidebar?.addEventListener("click", () => {
  savePrefs({ sidebarCollapsed: !els.app.classList.contains("sidebar-collapsed") });
});
els.workspaceTrigger?.addEventListener("click", openSettings);

els.pill.addEventListener("click", (event) => {
  event.stopPropagation();
  const open = els.statusPopover.classList.contains("hidden");
  els.statusPopover.classList.toggle("hidden", !open);
  els.pill.setAttribute("aria-expanded", String(open));
});
document.addEventListener("click", (event) => {
  if (!event.target.closest(".status-wrap")) {
    els.statusPopover.classList.add("hidden");
    els.pill.setAttribute("aria-expanded", "false");
  }
  if (!event.target.closest(".attachment-wrap")) {
    els.attachmentMenu.classList.add("hidden");
    els.btnAttach.setAttribute("aria-expanded", "false");
  }
});
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  els.statusPopover.classList.add("hidden");
  els.pill.setAttribute("aria-expanded", "false");
  els.attachmentMenu.classList.add("hidden");
  els.btnAttach.setAttribute("aria-expanded", "false");
});

els.btnAttach?.addEventListener("click", (event) => {
  event.stopPropagation();
  const open = els.attachmentMenu.classList.contains("hidden");
  els.attachmentMenu.classList.toggle("hidden", !open);
  els.btnAttach.setAttribute("aria-expanded", String(open));
});
els.btnAttachFiles?.addEventListener("click", () => els.fileInput.click());
els.btnAttachFolder?.addEventListener("click", () => els.folderInput.click());
els.fileInput?.addEventListener("change", () => addAttachments(els.fileInput.files));
els.folderInput?.addEventListener("change", () => addAttachments(els.folderInput.files));

els.setTheme.addEventListener("change", () => savePrefs({ theme: els.setTheme.value }));
els.setCompact.addEventListener("change", () => savePrefs({ compact: els.setCompact.checked }));

els.setProvider.addEventListener("change", async () => {
  try {
    await refreshModelSelect(els.setProvider.value);
  } catch (error) {
    setSettingsMsg(error.message, "err");
  }
});
els.setModel.addEventListener("change", syncCustomModelInput);

els.btnRefreshModels.addEventListener("click", async () => {
  try {
    setSettingsMsg("Обновляю модели…");
    await refreshModelSelect(els.setProvider.value);
    setSettingsMsg("Список моделей обновлён", "ok");
  } catch (error) {
    setSettingsMsg(error.message, "err");
  }
});

els.btnApplyConfig.addEventListener("click", async () => {
  const provider = els.setProvider.value;
  const model = els.setModel.value === "__custom__" ? els.setModelCustom.value.trim() : els.setModel.value;
  const currentProvider = state.settings?.currentProvider;
  const currentModel = state.settings?.currentModel;
  const providerChanged = provider !== currentProvider;
  const modelChanged = Boolean(model) && model !== currentModel;
  if (els.setModel.value === "__custom__" && !model) {
    setSettingsMsg("Укажи свой ID модели", "err");
    els.setModelCustom.focus();
    return;
  }
  if (!providerChanged && !modelChanged && !els.setApplyDefaultModel.checked) {
    setSettingsMsg("Изменений нет");
    return;
  }
  els.btnApplyConfig.disabled = true;
  try {
    if (providerChanged || els.setApplyDefaultModel.checked) {
      await api("/api/settings/provider", {
        method: "POST",
        body: JSON.stringify({ name: provider, applyDefaultModel: els.setApplyDefaultModel.checked }),
      });
    }
    if (modelChanged) {
      await api("/api/settings/model", {
        method: "POST",
        body: JSON.stringify({ model, provider }),
      });
    }
    setSettingsMsg("Конфигурация сохранена", "ok");
    els.setApplyDefaultModel.checked = false;
    await loadSettingsPanel();
    await refreshStatus();
  } catch (error) {
    setSettingsMsg(error.message, "err");
  } finally {
    els.btnApplyConfig.disabled = false;
  }
});

els.btnNew.addEventListener("click", async () => {
  await api("/api/sessions", { method: "POST", body: "{}" });
  els.chat.querySelectorAll(".bubble").forEach((n) => n.remove());
  showEmptyIfNeeded();
  appendBubble("system", "Новая сессия. Напиши задачу ниже.");
  await refreshStatus();
  await refreshSessions();
  els.input.focus();
});

els.suggestions?.addEventListener("click", (event) => {
  const btn = event.target.closest("button[data-prompt]");
  if (!btn) return;
  els.input.value = btn.dataset.prompt || "";
  els.form.requestSubmit();
});

els.form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = els.input.value.trim();
  if (!text || state.busy) return;
  els.input.value = "";
  autoResize();
  const prompt = await buildPromptWithAttachments(text);
  clearAttachments();
  await sendChat(prompt);
});
els.stop.addEventListener("click", stopChat);

els.input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    els.form.requestSubmit();
  }
});
els.input.addEventListener("input", autoResize);

function autoResize() {
  els.input.style.height = "auto";
  els.input.style.height = `${Math.min(els.input.scrollHeight, 160)}px`;
}

const TEXT_ATTACHMENT_EXTENSIONS = new Set([
  "css", "csv", "html", "js", "json", "md", "mjs", "py", "sh", "sql", "svg", "tsx", "ts", "txt", "vue", "xml", "yaml", "yml",
]);

function attachmentPath(file) {
  return file.webkitRelativePath || file.name;
}

function isTextAttachment(file) {
  const extension = file.name.split(".").pop()?.toLowerCase();
  return file.type.startsWith("text/") || TEXT_ATTACHMENT_EXTENSIONS.has(extension);
}

function renderAttachments() {
  if (!state.attachments.length) {
    els.attachments.classList.add("hidden");
    els.attachments.innerHTML = "";
    return;
  }
  els.attachments.classList.remove("hidden");
  els.attachments.innerHTML = state.attachments.map((file, index) => `
    <span class="attachment-chip" title="${escapeHtml(attachmentPath(file))}">
      <svg aria-hidden="true" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M6 3h8l4 4v14H6z"/><path d="M14 3v5h5"/></svg>
      <span>${escapeHtml(file.name)}</span>
      <button type="button" data-remove-attachment="${index}" aria-label="Убрать ${escapeHtml(file.name)}">×</button>
    </span>`).join("");
  els.attachments.querySelectorAll("[data-remove-attachment]").forEach((button) => {
    button.addEventListener("click", () => {
      state.attachments.splice(Number(button.dataset.removeAttachment), 1);
      renderAttachments();
    });
  });
}

function addAttachments(files) {
  for (const file of Array.from(files || [])) {
    if (state.attachments.length >= 20) break;
    const duplicate = state.attachments.some((current) =>
      attachmentPath(current) === attachmentPath(file) && current.size === file.size && current.lastModified === file.lastModified);
    if (!duplicate) state.attachments.push(file);
  }
  renderAttachments();
  els.attachmentMenu.classList.add("hidden");
  els.btnAttach.setAttribute("aria-expanded", "false");
}

function clearAttachments() {
  state.attachments = [];
  els.fileInput.value = "";
  els.folderInput.value = "";
  renderAttachments();
}

async function buildPromptWithAttachments(text) {
  if (!state.attachments.length) return text;
  const blocks = [];
  let totalTextBytes = 0;
  for (const file of state.attachments) {
    const label = attachmentPath(file);
    if (!isTextAttachment(file) || file.size > 180_000 || totalTextBytes + file.size > 600_000) {
      blocks.push(`[Вложение: ${label}. Файл выбран локально; содержимое не вставлено в сообщение.]`);
      continue;
    }
    try {
      blocks.push(`--- ${label}\n${await file.text()}`);
      totalTextBytes += file.size;
    } catch {
      blocks.push(`[Вложение: ${label}. Не удалось прочитать файл в браузере.]`);
    }
  }
  return `${text}\n\nКонтекст из вложений:\n${blocks.join("\n\n")}`;
}

function setBusyControls(busy) {
  els.send.disabled = busy;
  els.send.classList.toggle("hidden", busy);
  els.stop.classList.toggle("hidden", !busy);
  els.stop.disabled = false;
  const label = els.stop.querySelector("span");
  if (label) label.textContent = "Остановить";
}

async function stopChat() {
  if (!state.busy && !state.serverBusy) return;
  state.stopRequested = true;
  els.stop.disabled = true;
  const label = els.stop.querySelector("span");
  if (label) label.textContent = "Останавливаю…";
  state.abortController?.abort();
  try {
    await api("/api/stop", { method: "POST" });
  } catch (error) {
    console.error("Failed to stop chat", error);
  }
}

async function sendChat(text) {
  state.busy = true;
  state.stopRequested = false;
  const controller = new AbortController();
  state.abortController = controller;
  setBusyControls(true);
  setPill("busy", "работает…");
  setLive("запуск…");

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
      body: JSON.stringify({ message: text }),
      signal: controller.signal,
    });
    if (!res.ok || !res.body) throw new Error(await res.text());

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const chunks = buffer.split("\n\n");
      buffer = chunks.pop() || "";
      for (const chunk of chunks) {
        const line = chunk.split("\n").find((l) => l.startsWith("data: "));
        if (!line) continue;
        handleEvent(JSON.parse(line.slice(6)));
      }
    }
    if (buffer.trim()) {
      const line = buffer.split("\n").find((l) => l.startsWith("data: "));
      if (line) handleEvent(JSON.parse(line.slice(6)));
    }
  } catch (error) {
    if (error.name === "AbortError" || state.stopRequested) {
      appendBubble("system", "Выполнение остановлено.");
      setPill("idle", "остановлено");
    } else {
      appendBubble("system", `Ошибка: ${error.message}`);
      setPill("error", "ошибка");
    }
  } finally {
    state.abortController = null;
    state.busy = false;
    setBusyControls(false);
    setLive("");
    try {
      const status = await refreshStatus();
      await refreshSessions();
      if (status.busy) {
        state.busy = true;
        setBusyControls(true);
        startRecoveryPolling();
      }
    } catch (error) {
      setPill("error", "нет связи");
      console.error("Failed to refresh chat status", error);
    }
    els.input.focus();
  }
}

function handleEvent(event) {
  switch (event.type) {
    case "message":
      if (event.role === "assistant") appendBubble("assistant", event.content, { markdown: true });
      else appendBubble(event.role, event.content);
      break;
    case "thinking":
    case "tool":
    case "progress":
    case "status": {
      const detail = String(event.detail || "").trim();
      if (!detail || isNoiseLive(detail)) break;
      const label = event.type === "tool"
        ? "tool"
        : event.type === "progress"
          ? "…"
          : event.role || "";
      const line = label ? `${label}: ${detail}` : detail;
      setLive(line);
      break;
    }
    case "todos":
      renderTodos(event.items);
      break;
    case "confirm":
      openModal({
        title: "Подтверждение действия",
        body: event.message,
        kind: "confirm",
        id: event.id,
        kicker: "Безопасность",
      });
      break;
    case "ask_user":
      openModal({
        title: event.question,
        body: "Выбери вариант или введи свой ответ",
        options: event.options || [],
        kind: "ask",
        id: event.id,
        kicker: "Вопрос от Fuse",
      });
      break;
    case "done":
      setPill("idle", "готово");
      setLive("");
      break;
    case "error":
      appendBubble("system", event.message);
      setPill("error", "ошибка");
      break;
    default:
      break;
  }
}

async function boot() {
  applyPrefs();
  try {
    const status = await refreshStatus();
    if (status.busy) {
      state.busy = true;
      setBusyControls(true);
    }
    await refreshHistory();
    await refreshSessions();
    if (status.busy) startRecoveryPolling();
  } catch (error) {
    hideEmpty();
    appendBubble("system", `Не удалось подключиться: ${error.message}`);
    setPill("error", "нет связи");
  }
  autoResize();
}

boot();
