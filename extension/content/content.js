/**
 * Content-script router: pick adapter for current page and answer messages.
 */
(function () {
  function pickAdapter() {
    const adapters = globalThis.ConsAdapters || {};
    const online = adapters.onlineApp;
    const pub = adapters.publicSite;
    const url = location.href;

    // Online first when it clearly matches a client shell.
    if (online && online.matches(url)) return online;
    if (pub && pub.matches(url)) return pub;
    return pub || online || null;
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    const run = async () => {
      const adapter = pickAdapter();
      if (!adapter) {
        return { ok: false, error: "Нет адаптера для этой страницы" };
      }

      switch (msg.type) {
        case "PING":
          return {
            ok: true,
            adapter: adapter.id,
            page: adapter.detectPage(),
            url: location.href,
            title: document.title,
          };

        case "COLLECT_LIST": {
          const items = adapter.collectListItems();
          return {
            ok: true,
            adapter: adapter.id,
            page: adapter.detectPage(),
            items,
            count: items.length,
          };
        }

        case "EXTRACT_DOCUMENT": {
          const doc = await adapter.extractCurrentDocument({
            format: msg.format || "docx",
          });
          return { ok: true, adapter: adapter.id, doc };
        }

        case "RUN_SEARCH": {
          if (typeof adapter.runSearch !== "function") {
            return {
              ok: false,
              error: "Поиск из расширения доступен в онлайн-КП или на consultant.ru",
            };
          }
          const result = await adapter.runSearch(msg.query, {
            scope: msg.scope || "practice",
          });
          return { ok: true, adapter: adapter.id, ...result };
        }

        case "PROBE": {
          if (typeof adapter.probe !== "function") {
            return { ok: false, error: "Probe недоступен на этом адаптере" };
          }
          return { ok: true, probe: adapter.probe() };
        }

        default:
          return { ok: false, error: `Unknown message: ${msg.type}` };
      }
    };

    run()
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true; // async
  });
})();
