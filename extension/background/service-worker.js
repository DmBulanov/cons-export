/**
 * Background: export queue, fetch public documents, trigger downloads.
 * (Classic SW — no DOMParser; HTML is stripped with regex helpers.)
 */

importScripts("../shared/filename.js");

const state = {
  running: false,
  stopRequested: false,
  progress: { current: 0, total: 0, status: "idle", lastError: null, log: [] },
};

function setProgress(patch) {
  Object.assign(state.progress, patch);
  chrome.storage.session.set({ exportProgress: state.progress }).catch(() => {});
}

function logLine(line) {
  const entry = `${new Date().toLocaleTimeString()} ${line}`;
  state.progress.log = [...(state.progress.log || []).slice(-40), entry];
  setProgress({ log: state.progress.log });
}

async function getDownloadFolder() {
  const { downloadFolder } = await chrome.storage.local.get("downloadFolder");
  let folder = String(downloadFolder || "ConsExport").trim();
  folder = folder
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "")
    .replace(/\.\./g, "")
    .replace(/[<>:"|?*\u0000-\u001f]/g, "_");
  return folder || "ConsExport";
}

/** Save under Chrome Downloads / {folder}/… without Save As dialog. */
async function downloadTextFile(filename, content, mime) {
  const type = mime || "text/plain;charset=utf-8";
  const folder = await getDownloadFolder();
  let url;
  try {
    const blob = new Blob([content], { type });
    url = URL.createObjectURL(blob);
  } catch {
    const base64 = btoa(unescape(encodeURIComponent(content)));
    url = `data:${type};base64,${base64}`;
  }
  try {
    await chrome.downloads.download({
      url,
      filename: `${folder}/${filename}`,
      saveAs: false,
      conflictAction: "uniquify",
    });
  } finally {
    if (url.startsWith("blob:")) {
      setTimeout(() => URL.revokeObjectURL(url), 20000);
    }
  }
}

function decodeEntities(s) {
  return String(s)
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)));
}

function stripTags(html) {
  return decodeEntities(
    String(html)
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p>/gi, "\n\n")
      .replace(/<\/div>/gi, "\n")
      .replace(/<\/tr>/gi, "\n")
      .replace(/<\/h[1-6]>/gi, "\n\n")
      .replace(/<[^>]+>/g, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}

function extractBetween(html, startRe, endRe) {
  const start = html.search(startRe);
  if (start < 0) return null;
  const from = html.slice(start);
  const endMatch = from.search(endRe);
  return endMatch > 0 ? from.slice(0, endMatch) : from.slice(0, 500000);
}

/** Parse a public consultant.ru document HTML string without DOM. */
function parsePublicDocument(html, pageUrl) {
  const h1 =
    html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1] ||
    html.match(/document-page__title[^>]*>([\s\S]*?)<\//i)?.[1] ||
    "";
  const title =
    stripTags(h1).replace(/\s+/g, " ").trim() ||
    stripTags(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "")
      .replace(/\s*\\?\s*КонсультантПлюс.*$/i, "")
      .trim() ||
    "document";

  let bodyHtml =
    extractBetween(
      html,
      /class="[^"]*document-page__main[^"]*"/i,
      /class="[^"]*document-page__separator[^"]*"|class="[^"]*footer|<footer/i
    ) ||
    extractBetween(
      html,
      /class="[^"]*content document-page[^"]*"/i,
      /<footer|class="[^"]*footer/i
    ) ||
    html;

  bodyHtml = bodyHtml
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "");

  const text = stripTags(bodyHtml);
  const outHtml = `<!DOCTYPE html><html lang="ru"><head><meta charset="utf-8"><title>${escapeHtml(
    title
  )}</title><link rel="canonical" href="${escapeHtml(
    pageUrl
  )}"></head><body>${bodyHtml}</body></html>`;

  return { title, text, html: outHtml };
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function exportPublicList(items, format) {
  state.running = true;
  state.stopRequested = false;
  setProgress({
    current: 0,
    total: items.length,
    status: "running",
    lastError: null,
    log: [],
  });
  logLine(`Старт: ${items.length} док. → .${format}`);

  let okCount = 0;
  for (let i = 0; i < items.length; i++) {
    if (state.stopRequested) {
      logLine("Остановлено пользователем");
      break;
    }
    const item = items[i];
    setProgress({ current: i + 1, total: items.length, status: "running" });

    try {
      const res = await fetch(item.url, { credentials: "include" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const raw = await res.text();
      const doc = parsePublicDocument(raw, item.url);
      const title = doc.title || item.title;
      const filename = consSafeFilename(
        title,
        i + 1,
        format === "html" ? "html" : "txt"
      );
      const body = format === "html" ? doc.html : doc.text;
      const mime =
        format === "html" ? "text/html;charset=utf-8" : "text/plain;charset=utf-8";
      await downloadTextFile(filename, body, mime);
      okCount += 1;
      logLine(`OK [${i + 1}] ${title.slice(0, 70)}`);
    } catch (e) {
      logLine(`ERR [${i + 1}] ${e.message || e}`);
      setProgress({ lastError: String(e) });
    }

    await new Promise((r) => setTimeout(r, 400));
  }

  state.running = false;
  setProgress({
    status: state.stopRequested ? "stopped" : "done",
    current: okCount,
    total: items.length,
  });
  logLine(`Готово: ${okCount}/${items.length}`);
}

/**
 * Online / SPA: open each document URL in a tab, extract, download, close.
 * Works when list items have real navigable URLs.
 */
async function exportViaTabs(items, format) {
  state.running = true;
  state.stopRequested = false;
  setProgress({
    current: 0,
    total: items.length,
    status: "running",
    lastError: null,
    log: [],
  });
  logLine(`Старт (вкладки): ${items.length} док. → .${format}`);

  let okCount = 0;
  for (let i = 0; i < items.length; i++) {
    if (state.stopRequested) {
      logLine("Остановлено пользователем");
      break;
    }
    const item = items[i];
    setProgress({ current: i + 1, total: items.length, status: "running" });

    if (!item.url || item.url === "about:blank") {
      logLine(`SKIP [${i + 1}] нет URL — нужна калибровка UI`);
      continue;
    }

    let tabId = null;
    try {
      const tab = await chrome.tabs.create({ url: item.url, active: false });
      tabId = tab.id;
      await waitTabComplete(tabId, 30000);
      await new Promise((r) => setTimeout(r, 700));

      const extracted = await sendToTab(tabId, {
        type: "EXTRACT_DOCUMENT",
        format,
      });
      if (!extracted?.ok || !extracted.doc) {
        throw new Error(extracted?.error || "extract failed");
      }
      if (extracted.doc.nativeSaveTriggered) {
        logLine(
          `NATIVE [${i + 1}] ${format} — ждём загрузку КП (${(
            extracted.doc.title || item.title
          ).slice(0, 50)})`
        );
        okCount += 1;
        await new Promise((r) => setTimeout(r, 1800));
        continue;
      }
      const ext = format === "html" ? "html" : "txt";
      const filename = consSafeFilename(
        extracted.doc.title || item.title,
        i + 1,
        ext
      );
      const body = format === "html" ? extracted.doc.html : extracted.doc.text;
      const mime =
        format === "html" ? "text/html;charset=utf-8" : "text/plain;charset=utf-8";
      await downloadTextFile(filename, body, mime);
      okCount += 1;
      logLine(`OK [${i + 1}] ${(extracted.doc.title || item.title).slice(0, 70)}`);
    } catch (e) {
      logLine(`ERR [${i + 1}] ${e.message || e}`);
      setProgress({ lastError: String(e) });
    } finally {
      if (tabId != null) {
        try {
          await chrome.tabs.remove(tabId);
        } catch {
          /* ignore */
        }
      }
    }
  }

  state.running = false;
  setProgress({
    status: state.stopRequested ? "stopped" : "done",
    current: okCount,
    total: items.length,
  });
  logLine(`Готово: ${okCount}/${items.length}`);
}

function waitTabComplete(tabId, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error("timeout loading tab"));
    }, timeoutMs);

    function listener(id, info) {
      if (id === tabId && info.status === "complete") {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId).then((t) => {
      if (t.status === "complete") {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    });
  });
}

async function sendToTab(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: [
        "shared/filename.js",
        "content/adapters/public-site.js",
        "content/adapters/online-app.js",
        "content/content.js",
      ],
    });
    return chrome.tabs.sendMessage(tabId, message);
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const run = async () => {
    switch (msg.type) {
      case "GET_PROGRESS":
        return { ok: true, progress: state.progress, running: state.running };

      case "STOP_EXPORT":
        state.stopRequested = true;
        logLine("Запрос остановки…");
        return { ok: true };

      case "START_PUBLIC_EXPORT": {
        if (state.running) return { ok: false, error: "Уже выполняется" };
        const { items, format } = msg;
        if (!items?.length) return { ok: false, error: "Список пуст" };
        exportPublicList(items, format || "docx");
        return { ok: true, started: true, total: items.length };
      }

      case "START_TAB_EXPORT": {
        if (state.running) return { ok: false, error: "Уже выполняется" };
        const { items, format } = msg;
        if (!items?.length) return { ok: false, error: "Список пуст" };
        exportViaTabs(items, format || "docx");
        return { ok: true, started: true, total: items.length };
      }

      case "SAVE_EXTRACTED": {
        const { doc, format, index } = msg;
        if (!doc) return { ok: false, error: "Нет документа" };
        if (doc.nativeSaveTriggered) {
          return { ok: true, native: true };
        }
        const ext = format === "html" ? "html" : "txt";
        const filename = consSafeFilename(doc.title, index, ext);
        const body = format === "html" ? doc.html : doc.text;
        const mime =
          format === "html" ? "text/html;charset=utf-8" : "text/plain;charset=utf-8";
        await downloadTextFile(filename, body, mime);
        return { ok: true, filename };
      }

      case "FORWARD_TO_ACTIVE_TAB": {
        const [tab] = await chrome.tabs.query({
          active: true,
          currentWindow: true,
        });
        if (!tab?.id) return { ok: false, error: "Нет активной вкладки" };
        return sendToTab(tab.id, msg.payload);
      }

      case "RUN_SEARCH_FLOW": {
        const query = String(msg.query || "").trim();
        if (!query) return { ok: false, error: "Введите запрос" };
        const scope = msg.scope || "practice";
        const autoExport = Boolean(msg.autoExport);
        const format = msg.format || "docx";

        let tab = await findOnlineTab();
        if (!tab) {
          // Open online home; user must already be logged in (cookies).
          tab = await chrome.tabs.create({
            url: "https://online.consultant.ru/riv/cgi/online.cgi?req=home",
            active: true,
          });
          await waitTabComplete(tab.id, 45000);
          await new Promise((r) => setTimeout(r, 1200));
        } else {
          await chrome.tabs.update(tab.id, { active: true });
        }

        let result = await sendToTab(tab.id, {
          type: "RUN_SEARCH",
          query,
          scope,
        });

        // Public site may navigate away — wait and collect again
        if (result?.navigating) {
          await waitTabComplete(tab.id, 30000);
          await new Promise((r) => setTimeout(r, 1000));
          result = await sendToTab(tab.id, { type: "COLLECT_LIST" });
          if (result?.ok) {
            result = {
              ok: true,
              query,
              items: result.items,
              count: result.items?.length || 0,
              adapter: result.adapter,
            };
          }
        }

        // Online search also often navigates — re-collect after settle
        if (result?.ok && (!result.items || result.items.length === 0)) {
          await new Promise((r) => setTimeout(r, 1500));
          const again = await sendToTab(tab.id, { type: "COLLECT_LIST" });
          if (again?.ok && again.items?.length) {
            result.items = again.items;
            result.count = again.items.length;
          }
        }

        if (!result?.ok) {
          return { ok: false, error: result?.error || "Поиск не удался" };
        }

        if (autoExport && result.items?.length) {
          if (state.running) {
            return { ok: false, error: "Экспорт уже выполняется" };
          }
          exportViaTabs(result.items, format);
          return {
            ok: true,
            ...result,
            exportStarted: true,
          };
        }

        return { ok: true, ...result };
      }

      case "GET_SETTINGS": {
        const folder = await getDownloadFolder();
        return { ok: true, downloadFolder: folder };
      }

      default:
        return { ok: false, error: `Unknown: ${msg.type}` };
    }
  };

  run()
    .then(sendResponse)
    .catch((e) => sendResponse({ ok: false, error: String(e) }));
  return true;
});

async function findOnlineTab() {
  const tabs = await chrome.tabs.query({ url: ["*://online.consultant.ru/*"] });
  if (tabs.length) return tabs[0];
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (active?.url && /consultant\.ru/i.test(active.url)) return active;
  return null;
}