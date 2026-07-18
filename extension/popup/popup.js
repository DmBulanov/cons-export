const els = {
  pageMeta: document.getElementById("pageMeta"),
  adapterName: document.getElementById("adapterName"),
  pageType: document.getElementById("pageType"),
  listCount: document.getElementById("listCount"),
  format: document.getElementById("format"),
  downloadFolder: document.getElementById("downloadFolder"),
  folderPreview: document.getElementById("folderPreview"),
  btnOpenDownloadsSettings: document.getElementById("btnOpenDownloadsSettings"),
  query: document.getElementById("query"),
  scope: document.getElementById("scope"),
  btnFind: document.getElementById("btnFind"),
  btnFindSave: document.getElementById("btnFindSave"),
  btnScan: document.getElementById("btnScan"),
  btnExport: document.getElementById("btnExport"),
  btnOne: document.getElementById("btnOne"),
  btnStop: document.getElementById("btnStop"),
  btnProbe: document.getElementById("btnProbe"),
  progressText: document.getElementById("progressText"),
  log: document.getElementById("log"),
};

let cachedItems = [];

async function tabMessage(payload) {
  return chrome.runtime.sendMessage({
    type: "FORWARD_TO_ACTIVE_TAB",
    payload,
  });
}

function renderProgress(progress, running) {
  if (!progress) return;
  const { current = 0, total = 0, status = "idle", log = [] } = progress;
  els.progressText.textContent =
    status === "idle"
      ? "ожидание"
      : `${status}: ${current}/${total || "?"} `;
  els.log.textContent = (log || []).join("\n");
  els.btnStop.hidden = !running;
  els.btnExport.disabled = running || cachedItems.length === 0;
}

async function refreshProgress() {
  const res = await chrome.runtime.sendMessage({ type: "GET_PROGRESS" });
  if (res?.ok) renderProgress(res.progress, res.running);
}

function applyItems(items, meta = {}) {
  cachedItems = items || [];
  els.listCount.textContent = String(cachedItems.length);
  els.btnExport.disabled = cachedItems.length === 0;
  if (meta.adapter) els.adapterName.textContent = meta.adapter;
  if (meta.page) els.pageType.textContent = meta.page;
  els.log.textContent = cachedItems
    .slice(0, 10)
    .map((it) => `${it.index}. ${it.title.slice(0, 70)}`)
    .join("\n");
  if (cachedItems.length > 10) {
    els.log.textContent += `\n… и ещё ${cachedItems.length - 10}`;
  }
  if (!cachedItems.length) {
    els.log.textContent = meta.emptyMessage || "Ничего не найдено";
  }
}

async function init() {
  const stored = await chrome.storage.local.get([
    "lastQuery",
    "lastScope",
    "downloadFolder",
    "lastFormat",
  ]);
  if (stored.lastQuery) els.query.value = stored.lastQuery;
  if (stored.lastScope) els.scope.value = stored.lastScope;
  if (stored.lastFormat) els.format.value = stored.lastFormat;
  else els.format.value = "docx";
  const folder = stored.downloadFolder || "ConsExport";
  els.downloadFolder.value = folder;
  els.folderPreview.textContent = folder;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url || !/consultant\.ru/i.test(tab.url)) {
    els.pageMeta.textContent =
      "Откройте online.consultant.ru (после входа) — или просто нажмите «Найти»";
    return;
  }
  els.pageMeta.textContent = tab.title || tab.url;

  const ping = await tabMessage({ type: "PING" });
  if (!ping?.ok) {
    els.pageMeta.textContent = ping?.error || "Не удалось связаться со страницей";
    return;
  }
  els.adapterName.textContent = ping.adapter || "—";
  els.pageType.textContent = ping.page || "—";

  if (ping.page === "list") {
    await scanList();
  }

  await refreshProgress();
}

async function scanList() {
  const res = await tabMessage({ type: "COLLECT_LIST" });
  if (!res?.ok) {
    els.listCount.textContent = "ошибка";
    els.log.textContent = res?.error || "scan failed";
    return;
  }
  applyItems(res.items, { adapter: res.adapter, page: res.page });
}

async function runFind(autoExport) {
  const query = els.query.value.trim();
  if (!query) {
    els.log.textContent = "Введите, какую практику нужно найти";
    els.query.focus();
    return;
  }

  await chrome.storage.local.set({
    lastQuery: query,
    lastScope: els.scope.value,
    lastFormat: els.format.value,
    downloadFolder: sanitizeFolder(els.downloadFolder.value),
  });

  els.progressText.textContent = autoExport
    ? "поиск + сохранение…"
    : "поиск…";
  els.log.textContent = `Ищем: ${query}`;
  els.btnFind.disabled = true;
  els.btnFindSave.disabled = true;

  try {
    const res = await chrome.runtime.sendMessage({
      type: "RUN_SEARCH_FLOW",
      query,
      scope: els.scope.value,
      autoExport,
      format: els.format.value,
    });

    if (!res?.ok) {
      els.log.textContent = res?.error || "Поиск не удался";
      els.progressText.textContent = "ошибка";
      return;
    }

    applyItems(res.items || [], {
      adapter: res.adapter || "online-app",
      page: "list",
      emptyMessage:
        "По запросу список пуст. Уточните формулировку или выберите «Всё по запросу».",
    });

    els.progressText.textContent = res.exportStarted
      ? `сохраняем ${res.count} док.`
      : `найдено: ${res.count || 0}`;

    if (res.exportStarted) {
      els.btnStop.hidden = false;
      pollWhileRunning();
    }
  } finally {
    els.btnFind.disabled = false;
    els.btnFindSave.disabled = false;
  }
}

els.btnFind.addEventListener("click", () => runFind(false));
els.btnFindSave.addEventListener("click", () => runFind(true));

function sanitizeFolder(raw) {
  let folder = String(raw || "ConsExport").trim();
  folder = folder
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "")
    .replace(/\.\./g, "")
    .replace(/[<>:"|?*\u0000-\u001f]/g, "_");
  return folder || "ConsExport";
}

els.downloadFolder.addEventListener("change", async () => {
  const folder = sanitizeFolder(els.downloadFolder.value);
  els.downloadFolder.value = folder;
  els.folderPreview.textContent = folder;
  await chrome.storage.local.set({ downloadFolder: folder });
});

els.format.addEventListener("change", async () => {
  await chrome.storage.local.set({ lastFormat: els.format.value });
});

els.btnOpenDownloadsSettings.addEventListener("click", () => {
  // chrome://pages cannot be opened from extension popup on all builds;
  // try, and fall back to copying the path.
  chrome.tabs.create({ url: "chrome://settings/downloads" }).catch(() => {
    els.log.textContent =
      "Откройте вручную: chrome://settings/downloads\n" +
      "1) Укажите папку «Загрузки» (или свою рабочую)\n" +
      "2) Выключите «Всегда указывать место для скачивания»";
  });
});

els.btnScan.addEventListener("click", scanList);

els.btnExport.addEventListener("click", async () => {
  if (!cachedItems.length) await scanList();
  if (!cachedItems.length) return;

  const format = els.format.value;
  const adapter = els.adapterName.textContent;
  const uniqueUrls = new Set(cachedItems.map((i) => i.url).filter(Boolean));

  if (adapter !== "public-site" && uniqueUrls.size < Math.min(2, cachedItems.length)) {
    els.log.textContent =
      "Список найден, но у пунктов нет отдельных URL.\n" +
      "Сначала нажмите «Найти», дождитесь выдачи, затем экспорт.";
    return;
  }

  let type = "START_TAB_EXPORT";
  if (adapter === "public-site" && (format === "txt" || format === "html")) {
    type = "START_PUBLIC_EXPORT";
  }

  const res = await chrome.runtime.sendMessage({
    type,
    items: cachedItems,
    format,
  });
  if (!res?.ok) {
    els.log.textContent = res?.error || "Не удалось запустить";
    return;
  }
  els.btnStop.hidden = false;
  pollWhileRunning();
});

els.btnOne.addEventListener("click", async () => {
  const format = els.format.value;
  const extracted = await tabMessage({
    type: "EXTRACT_DOCUMENT",
    format,
  });
  if (!extracted?.ok) {
    els.log.textContent = extracted?.error || "Не удалось извлечь";
    return;
  }
  if (extracted.doc?.nativeSaveTriggered) {
    els.log.textContent =
      `КП сохраняет как ${extracted.doc.format || format}.\n` +
      "Файл должен появиться в загрузках браузера.";
    return;
  }
  const saved = await chrome.runtime.sendMessage({
    type: "SAVE_EXTRACTED",
    doc: extracted.doc,
    format,
    index: 1,
  });
  els.log.textContent = saved?.ok
    ? `Сохранено: ${saved.filename}`
    : saved?.error || "Ошибка сохранения";
});

els.btnStop.addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "STOP_EXPORT" });
  await refreshProgress();
});

els.btnProbe.addEventListener("click", async () => {
  const res = await tabMessage({ type: "PROBE" });
  if (!res?.ok) {
    els.log.textContent = res?.error || "Probe недоступен на этой странице";
    return;
  }
  const text = JSON.stringify(res.probe, null, 2);
  els.log.textContent = text.slice(0, 2500);
  try {
    await navigator.clipboard.writeText(text);
    els.progressText.textContent = "Разведка скопирована в буфер";
  } catch {
    els.progressText.textContent = "Разведка готова (скопируйте из лога)";
  }
});

function pollWhileRunning() {
  const timer = setInterval(async () => {
    const res = await chrome.runtime.sendMessage({ type: "GET_PROGRESS" });
    if (!res?.ok) return;
    renderProgress(res.progress, res.running);
    if (!res.running) clearInterval(timer);
  }, 500);
}

init().catch((e) => {
  els.pageMeta.textContent = String(e);
});
