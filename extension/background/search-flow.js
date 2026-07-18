/** Navigation-safe search orchestration. Pure enough to exercise with Node mocks. */
(function () {
  function flowError(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
  }

  function consCreateSearchFlow(dependencies) {
    const {
      sendToTab,
      navigate,
      observeTabLoadCycle,
      buildOnlineSearchUrl,
      buildPublicSearchUrl,
      delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      now = Date.now,
      timeoutMs = 12000,
      pollMs = 250,
      settleMs = 1000,
    } = dependencies || {};

    if (
      typeof sendToTab !== "function" ||
      typeof navigate !== "function" ||
      typeof observeTabLoadCycle !== "function"
    ) {
      throw new Error("Search flow dependencies are incomplete");
    }

    function responseError(response, fallback) {
      const code = response?.code || "SEARCH_STATE_ERROR";
      const message = response?.error || fallback;
      if (code === "AUTH_REQUIRED") {
        return flowError(code, "Сессия завершилась; войдите в КонсультантПлюс повторно");
      }
      return flowError(code, message);
    }

    async function readState(tabId, query, expectedAdapter) {
      const response = await sendToTab(tabId, {
        type: "GET_SEARCH_STATE",
        query,
      });
      if (!response?.ok) {
        throw responseError(response, "Не удалось прочитать состояние поиска");
      }
      if (response.adapter !== expectedAdapter) {
        throw flowError(
          "ADAPTER_CHANGED",
          "После перехода открылся другой интерфейс КонсультантПлюс"
        );
      }
      if (!response.state || typeof response.state !== "object") {
        throw flowError("SEARCH_STATE_ERROR", "Страница вернула некорректное состояние поиска");
      }
      return response.state;
    }

    function stateKey(state) {
      return [
        state.resultSignature || "",
        Number(state.resultCount || 0),
        state.emptyResults ? "empty" : "items",
      ].join(":");
    }

    async function waitForState(tabId, options) {
      const deadline = now() + (options.timeoutMs || timeoutMs);
      let stableKey = null;
      let stableSince = null;
      let lastError = null;

      while (now() < deadline) {
        try {
          const state = await readState(tabId, options.query, options.adapter);
          const loadEvidence =
            !options.requireLoadCycle ||
            Boolean(options.loadCycle?.state?.sawLoading && options.loadCycle?.state?.sawComplete);
          const ready =
            state.queryMatches === true &&
            state.queryAuthoritative === true &&
            state.resultsReady === true &&
            state.loading !== true &&
            (!options.scope || state.activeScope === options.scope) &&
            loadEvidence;

          if (ready) {
            const key = stateKey(state);
            if (stableKey !== key) {
              stableKey = key;
              stableSince = now();
            }
            if (now() - stableSince >= settleMs) return state;
          } else {
            stableKey = null;
            stableSince = null;
          }
        } catch (error) {
          if (["AUTH_REQUIRED", "ADAPTER_CHANGED"].includes(error?.code)) throw error;
          lastError = error;
          stableKey = null;
          stableSince = null;
        }
        await delay(pollMs);
      }

      throw flowError(
        "SEARCH_TIMEOUT",
        lastError?.message || "Не удалось подтвердить обновление поисковой выдачи"
      );
    }

    async function navigateForQuery(tab, adapter, query) {
      const searchUrl =
        adapter === "online-app"
          ? buildOnlineSearchUrl(tab.url, query)
          : buildPublicSearchUrl(query);
      const loadCycle = observeTabLoadCycle(tab.id);
      try {
        await navigate(tab, searchUrl);
        return await waitForState(tab.id, {
          adapter,
          query,
          loadCycle,
          requireLoadCycle: true,
        });
      } finally {
        loadCycle.dispose();
      }
    }

    async function applyOnlineScope(tabId, query, scope, state) {
      if (state.activeScope === scope) return state;

      const loadCycle = observeTabLoadCycle(tabId);
      try {
        const response = await sendToTab(tabId, {
          type: "CLICK_SEARCH_SCOPE",
          query,
          scope,
        });
        if (!response?.ok) {
          throw responseError(response, "Не удалось переключить область поиска");
        }
        if (!response.triggered) {
          return await waitForState(tabId, {
            adapter: "online-app",
            query,
            scope,
            requireLoadCycle: false,
          });
        }
        return await waitForState(tabId, {
          adapter: "online-app",
          query,
          scope,
          loadCycle,
          requireLoadCycle: response.navigationExpected !== false,
        });
      } finally {
        loadCycle.dispose();
      }
    }

    async function run({ tab, adapter, query, scope }) {
      if (!tab?.id || !tab.url) throw flowError("TAB_MISSING", "Рабочая вкладка недоступна");
      if (!query) throw flowError("EMPTY_QUERY", "Введите запрос");
      if (!["online-app", "public-site"].includes(adapter)) {
        throw flowError("UNSUPPORTED_PAGE", "Поиск недоступен для этого интерфейса");
      }
      if (adapter === "public-site" && scope !== "all") {
        throw flowError(
          "UNSUPPORTED_SCOPE",
          "На публичном сайте доступна только область «Всё по запросу»"
        );
      }
      if (adapter === "online-app" && !["all", "practice"].includes(scope)) {
        throw flowError("UNSUPPORTED_SCOPE", "Неизвестная область поиска");
      }

      let state;
      try {
        state = await readState(tab.id, query, adapter);
      } catch (error) {
        if (["AUTH_REQUIRED", "ADAPTER_CHANGED"].includes(error?.code)) throw error;
        state = null;
      }

      if (
        !state?.queryMatches ||
        !state?.queryAuthoritative ||
        !state?.resultsReady ||
        state.loading
      ) {
        state = await navigateForQuery(tab, adapter, query);
      }

      if (adapter === "online-app") {
        state = await applyOnlineScope(tab.id, query, scope, state);
      } else if (state.activeScope !== "all") {
        throw flowError("SCOPE_NOT_APPLIED", "Не удалось подтвердить область поиска");
      }

      if (
        !state.queryMatches ||
        !state.queryAuthoritative ||
        !state.resultsReady ||
        state.loading ||
        state.activeScope !== scope
      ) {
        throw flowError("SEARCH_STATE_MISMATCH", "Итоговая выдача не соответствует запросу");
      }

      const items = Array.isArray(state.items) ? state.items : [];
      return {
        adapter,
        query,
        scope,
        scopeApplied: true,
        items,
        count: items.length,
        emptyResults: Boolean(state.emptyResults),
      };
    }

    return { readState, run, waitForState };
  }

  globalThis.consCreateSearchFlow = consCreateSearchFlow;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = { consCreateSearchFlow };
  }
})();
