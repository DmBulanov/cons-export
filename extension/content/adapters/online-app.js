/**
 * Adapter for authenticated online ConsultantPlus
 * (https://online.consultant.ru/… after login.consultant.ru).
 *
 * Calibrated 2026-07-18 against live session:
 *  - search list: a.x-page-components-search-result-item__extra-title
 *  - document body: .pageContainer.x-page-document-content
 *  - save: button.dots → «Сохранить в файл» → format row
 *  - quick Word: button.word
 *  - next in hit-list: button.next
 */
(function () {
  const FORMAT_MATCH = {
    docx: /формате\s*DOCX/i,
    rtf: /формате\s*RTF/i,
    txt: /без форматирования/i,
    txt_unicode: /UNICODE/i,
    pdf: /формате\s*PDF(?!\s*для)/i,
    pdf_ebook: /эл\.?\s*книг/i,
    epub: /EPUB/i,
    html: /формате\s*HTML/i,
    fb2: /FB2/i,
    xml: /Word 2003 XML|XML/i,
  };

  const NATIVE_FORMATS = new Set(Object.keys(FORMAT_MATCH));

  const SEARCH_SCOPES = Object.freeze(["all", "practice"]);

  function isConsultantHost(hostname) {
    const host = String(hostname || "").toLowerCase();
    return host === "consultant.ru" || host.endsWith(".consultant.ru");
  }

  function adapterError(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function normalizedText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function resultSignature(items) {
    const source = (items || []).map((item) => `${item.url}\n${item.title}`).join("\n---\n");
    let hash = 2166136261;
    for (let index = 0; index < source.length; index += 1) {
      hash ^= source.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16);
  }

  function isPresetActive(element) {
    if (!element) return false;
    if (element.matches?.(":checked, [aria-selected='true'], [aria-pressed='true']")) {
      return true;
    }
    if (element.querySelector?.(":checked, [aria-selected='true'], [aria-pressed='true']")) {
      return true;
    }
    const marker = [
      element.className,
      element.getAttribute?.("data-state"),
      element.getAttribute?.("data-selected"),
    ]
      .filter(Boolean)
      .join(" ");
    return /(?:^|[-_\s])(active|checked|current|selected)(?:$|[-_\s])/i.test(marker);
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  const OnlineAppAdapter = {
    id: "online-app",

    getCapabilities(page = this.detectPage()) {
      const search = !["auth-required", "unsupported"].includes(page);
      const documentReady = page === "document" && Boolean(this._docRoot());
      const resultsReady =
        (page === "list" || page === "search") &&
        (this.collectListItems().length > 0 || this._hasEmptyResultsMessage());
      return {
        search,
        searchReady: search && Boolean(this._findSearchInput()),
        resultsReady,
        searchScopes: search ? SEARCH_SCOPES : [],
        collectList: page === "list" || page === "search",
        extractDocument: documentReady,
        documentReady,
        wordSaveReady: documentReady && Boolean(document.querySelector("button.word")),
        menuSaveReady: documentReady && Boolean(document.querySelector("button.dots")),
        exportFormats: ["docx", "pdf", "rtf", "txt", "html"],
        nativeSave: documentReady,
      };
    },

    matches(url) {
      try {
        const u = new URL(url);
        if (!isConsultantHost(u.hostname)) return false;
        if (/^(online|login|client|web)\./i.test(u.hostname)) return true;
        // SPA path after auth on other consultant hosts
        if (/online\.cgi/i.test(u.pathname + u.search)) return true;
        return false;
      } catch {
        return false;
      }
    },

    detectPage() {
      if (this._isAuthRequired()) return "auth-required";
      if (
        /[?&]req=doc\b/i.test(location.search) ||
        document.querySelector(
          ".pageContainer.x-page-document-content, .x-page-document-content, .contextToolbar button.word"
        )
      ) {
        return "document";
      }
      if (
        document.querySelector(
          "a.x-page-components-search-result-item__extra-title, .x-page-components-search-result-item"
        )
      ) {
        return "list";
      }
      if (/[?&]req=home\b/i.test(location.search)) return "home";
      if (/[?&]page=splus\b|[?&]req=card\b/i.test(location.href)) return "search";
      if (this._findSearchInput()) return "search";
      return "unsupported";
    },

    _isAuthRequired() {
      if (/^login\./i.test(location.hostname)) return true;
      const password = document.querySelector('input[type="password"]');
      if (!password) return false;
      return /(?:войти|вход|логин|парол)/i.test(document.body?.innerText || "");
    },

    _findSearchInput() {
      return document.querySelector(
        [
          "input.x-page-components-search-panel__filter",
          ".x-page-components-search-panel input.x-input__field",
          "[class*='search-panel'] input.x-input__field",
          "input[name='splusFind']",
        ].join(", ")
      );
    },

    _findSearchButton(input) {
      const container = input?.closest?.(
        "form, .x-page-components-search-panel, [class*='search-panel']"
      );
      const candidates = container?.querySelectorAll?.("button, a, [role=button]") || [];
      return [...candidates].find((element) =>
        /^найти$/i.test(normalizedText(element.innerText || element.textContent))
      );
    },

    collectListItems() {
      const items = [];
      const seen = new Set();
      const links = document.querySelectorAll(
        "a.x-page-components-search-result-item__extra-title, a.x-page-components-search-result-item__extra-text"
      );

      links.forEach((a) => {
        const href = a.href;
        if (!href || seen.has(href)) return;
        if (!/[?&]req=doc\b/i.test(href)) return;
        seen.add(href);
        const title = a.innerText.replace(/\s+/g, " ").trim();
        if (!title) return;
        items.push({
          index: items.length + 1,
          title,
          url: href,
        });
      });

      return items;
    },

    currentSearchQuery() {
      const inputValue = normalizedText(this._findSearchInput()?.value);
      if (inputValue) return inputValue;
      return this._urlSearchQuery();
    },

    _urlSearchQuery() {
      try {
        return normalizedText(new URL(location.href).searchParams.get("splusFind"));
      } catch {
        return "";
      }
    },

    _activeSearchScope() {
      const practice = this._findScopePreset(/судебная практика/i);
      if (isPresetActive(practice)) return "practice";
      const all = this._findScopePreset(
        /^(?:все|все документы|все материалы|все результаты|все по запросу)$/i
      );
      return isPresetActive(all) ? "all" : null;
    },

    getSearchState(expectedQuery = "") {
      const items = this.collectListItems();
      const loading = this._isResultsLoading();
      const emptyResults = this._hasEmptyResultsMessage();
      const query = normalizedText(expectedQuery);
      const urlQuery = this._urlSearchQuery();
      return {
        queryMatches: Boolean(query) && this.currentSearchQuery() === query,
        queryAuthoritative: Boolean(query) && urlQuery === query,
        activeScope: this._activeSearchScope(),
        loading,
        emptyResults,
        resultsReady: !loading && (items.length > 0 || emptyResults),
        resultCount: items.length,
        resultSignature: resultSignature(items),
        items,
      };
    },

    triggerSearchScope(scope) {
      if (!SEARCH_SCOPES.includes(scope)) {
        throw adapterError("UNSUPPORTED_SCOPE", `Неизвестная область поиска: ${scope}`);
      }
      const state = this.getSearchState();
      if (state.activeScope === scope) {
        return { triggered: false, scopeApplied: true, beforeSignature: state.resultSignature };
      }
      const preset = this._findScopePreset(
        scope === "practice"
          ? /судебная практика/i
          : /^(?:все|все документы|все материалы|все результаты|все по запросу)$/i
      );
      if (!preset) {
        throw adapterError("SCOPE_NOT_FOUND", `Переключатель области «${scope}» не найден`);
      }
      setTimeout(() => {
        if (preset.isConnected !== false) preset.click();
      }, 0);
      return {
        triggered: true,
        scopeApplied: false,
        navigationExpected: true,
        beforeSignature: state.resultSignature,
      };
    },

    /**
     * Run quick search for a query, optionally filter to judicial practice.
     * @param {string} query
     * @param {{ scope?: 'all'|'practice' }} [options]
     */
    async runSearch(query, options = {}) {
      const q = String(query || "").trim();
      if (!q) throw new Error("Пустой запрос");
      const scope = options.scope || "practice";
      if (!SEARCH_SCOPES.includes(scope)) {
        throw adapterError("UNSUPPORTED_SCOPE", `Неизвестная область поиска: ${scope}`);
      }

      const page = this.detectPage();
      if (page === "auth-required") {
        throw adapterError("AUTH_REQUIRED", "Сначала войдите в онлайн-КонсультантПлюс");
      }
      if (page === "unsupported") {
        throw adapterError(
          "UNSUPPORTED_PAGE",
          "На этой странице не найден интерфейс онлайн-КонсультантПлюс"
        );
      }

      const state = this.getSearchState(q);
      if (
        state.queryMatches &&
        state.queryAuthoritative &&
        state.activeScope === scope &&
        state.resultsReady
      ) {
        return {
          query: q,
          scope,
          scopeApplied: true,
          count: state.items.length,
          items: state.items,
          url: location.href,
        };
      }

      return {
        query: q,
        scope,
        scopeApplied: false,
        navigating: true,
        count: 0,
        items: [],
        url: consBuildOnlineSearchUrl(location.href, q),
      };
    },

    _resultsRoot() {
      return (
        document.querySelector(
          ".x-page-search-plus-results, [class*='search-results'], [class*='search-result-list']"
        ) || document.body
      );
    },

    _hasEmptyResultsMessage() {
      return /(?:ничего не найдено|документы не найдены|по вашему запросу[^.]{0,80}не найден)/i.test(
        document.body?.innerText || ""
      );
    },

    _isResultsLoading() {
      const root = this._resultsRoot();
      const selector =
        "[aria-busy='true'], [data-loading='true'], progress, " +
        "[class*='spinner'], [class*='loader']";
      const marker = root?.matches?.(selector)
        ? root
        : root?.querySelector?.(selector);
      if (!marker) return false;
      if (marker.hidden || marker.getAttribute?.("aria-hidden") === "true") return false;
      return true;
    },

    _findScopePreset(labelRe) {
      return [...document.querySelectorAll(
        ".x-page-search-plus-presets__preset, [class*='presets__preset'], a, button, [role=tab]"
      )].find((element) => labelRe.test(normalizedText(element.innerText || element.textContent)));
    },

    _docTitle() {
      return (
        document.title.replace(/\s*[-–|]\s*КонсультантПлюс.*$/i, "").trim() ||
        document
          .querySelector(".pageContainer, .x-page-document-content")
          ?.innerText?.trim()
          ?.split("\n")
          .find((l) => l.trim().length > 10)
          ?.trim() ||
        "document"
      );
    },

    _docRoot() {
      return (
        document.querySelector(".pageContainer.x-page-document-content") ||
        document.querySelector(".x-page-document-content") ||
        document.querySelector(".pageContainer") ||
        document.querySelector("[class*='document-content']")
      );
    },

    async _openSaveFormatMenu() {
      // Close stray menus
      document.body.click();
      await sleep(150);

      const dots = document.querySelector("button.dots");
      if (!dots) throw new Error("Кнопка «Ещё» (dots) не найдена");
      dots.click();
      await sleep(350);

      const saveRow = [...document.querySelectorAll(".x-menu__content-row")].find(
        (r) => /сохранить в файл/i.test(r.innerText || "")
      );
      if (!saveRow) throw new Error("Пункт «Сохранить в файл» не найден");

      saveRow.dispatchEvent(
        new MouseEvent("mouseenter", { bubbles: true, cancelable: true })
      );
      saveRow.dispatchEvent(
        new MouseEvent("mousemove", { bubbles: true, cancelable: true })
      );
      saveRow.click();
      await sleep(400);

      // Format submenu should be the menu containing DOCX/PDF rows
      const hasFormats = [...document.querySelectorAll(".x-menu__content-row")].some(
        (r) => /формате\s*DOCX|без форматирования/i.test(r.innerText || "")
      );
      if (!hasFormats) {
        // retry hover
        saveRow.dispatchEvent(
          new MouseEvent("mouseover", { bubbles: true, cancelable: true })
        );
        await sleep(400);
      }
    },

    async nativeSave(formatKey) {
      const needle = FORMAT_MATCH[formatKey];
      if (!needle) throw new Error(`Неизвестный формат: ${formatKey}`);

      await this._openSaveFormatMenu();

      const formatRow = [...document.querySelectorAll(".x-menu__content-row")].find(
        (r) => needle.test((r.innerText || "").replace(/\s+/g, " "))
      );
      if (!formatRow) {
        throw new Error(`Формат «${formatKey}» не найден в меню`);
      }
      formatRow.click();
      await sleep(800);
      return true;
    },

    async extractCurrentDocument(options = {}) {
      const format = (options.format || "docx").toLowerCase();
      const title = this._docTitle();

      // Native KP export (triggers browser download)
      if (format === "docx" || format === "word") {
        const wordBtn = document.querySelector("button.word");
        if (wordBtn) {
          wordBtn.click();
          await sleep(800);
          return {
            title,
            text: "",
            html: "",
            nativeSaveTriggered: true,
            url: location.href,
            format: "docx",
          };
        }
      }

      if (NATIVE_FORMATS.has(format) && format !== "html" && format !== "txt") {
        await this.nativeSave(format);
        return {
          title,
          text: "",
          html: "",
          nativeSaveTriggered: true,
          url: location.href,
          format,
        };
      }

      // Fast path: pull text/HTML from the document pane
      const root = this._docRoot();
      if (!root) {
        throw adapterError(
          "DOCUMENT_NOT_READY",
          "Область документа не найдена; дождитесь загрузки документа и повторите экспорт"
        );
      }

      const clone = root.cloneNode(true);
      clone
        .querySelectorAll("script, style, .contextToolbar, .contextPanel")
        .forEach((el) => el.remove());

      const text = clone.innerText.replace(/\n{3,}/g, "\n\n").trim();
      const html = `<!DOCTYPE html><html lang="ru"><head><meta charset="utf-8"><title>${escapeHtml(
        title
      )}</title><link rel="canonical" href="${escapeHtml(
        location.href
      )}"></head><body>${clone.innerHTML}</body></html>`;

      return { title, text, html, url: location.href, format };
    },

    /** Move to next document in current search hit-list (if available). */
    async goNextDocument() {
      const next = document.querySelector("button.next:not(.disabled)");
      if (!next) return false;
      next.click();
      await sleep(900);
      return true;
    },

    probe() {
      return {
        hostname: location.hostname,
        page: this.detectPage(),
        listCount: this.collectListItems().length,
        hasWord: Boolean(document.querySelector("button.word")),
        hasDots: Boolean(document.querySelector("button.dots")),
        hasNext: Boolean(document.querySelector("button.next")),
        hasDocPane: Boolean(this._docRoot()),
        docTextLen: this._docRoot()?.innerText?.length || 0,
      };
    },
  };

  globalThis.ConsAdapters = globalThis.ConsAdapters || {};
  globalThis.ConsAdapters.onlineApp = OnlineAppAdapter;
})();
