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

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
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

    matches(url) {
      try {
        const u = new URL(url);
        if (!u.hostname.endsWith("consultant.ru")) return false;
        if (/^(online|login|client|web)\./i.test(u.hostname)) return true;
        // SPA path after auth on other consultant hosts
        if (/online\.cgi/i.test(u.pathname + u.search)) return true;
        return false;
      } catch {
        return false;
      }
    },

    detectPage() {
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
      return "unknown";
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

    /**
     * Run quick search for a query, optionally filter to judicial practice.
     * @param {string} query
     * @param {{ scope?: 'all'|'practice' }} [options]
     */
    async runSearch(query, options = {}) {
      const q = String(query || "").trim();
      if (!q) throw new Error("Пустой запрос");
      const scope = options.scope || "practice";

      const input =
        document.querySelector(
          "input.x-page-components-search-panel__filter, input.x-input__field"
        ) || document.querySelector('input[type="text"]');

      if (input) {
        input.focus();
        const setter = Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          "value"
        )?.set;
        if (setter) setter.call(input, q);
        else input.value = q;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));

        const btn = [...document.querySelectorAll("button, a, [role=button]")].find(
          (el) => /^найти$/i.test((el.innerText || "").trim())
        );
        if (btn) btn.click();
        else
          input.dispatchEvent(
            new KeyboardEvent("keydown", {
              key: "Enter",
              code: "Enter",
              keyCode: 13,
              bubbles: true,
            })
          );
      } else {
        // Navigate via URL if search box missing
        const rnd = new URL(location.href).searchParams.get("rnd") || "";
        const url =
          `${location.origin}${location.pathname}?req=card&page=splus&splusFind=` +
          `${encodeURIComponent(q)}${rnd ? `&rnd=${encodeURIComponent(rnd)}` : ""}#splus`;
        location.assign(url);
      }

      // Wait for result links
      const deadline = Date.now() + 20000;
      while (Date.now() < deadline) {
        await sleep(400);
        if (this.collectListItems().length > 0) break;
        if (/page=splus|splusFind=/i.test(location.href) && document.body.innerText.length > 500) {
          // page loaded but maybe still rendering
          await sleep(600);
          break;
        }
      }

      if (scope === "practice") {
        await this._clickScopePreset(/судебная практика/i);
        await sleep(700);
      }

      const items = this.collectListItems();
      return {
        query: q,
        scope,
        count: items.length,
        items,
        url: location.href,
      };
    },

    async _clickScopePreset(labelRe) {
      const preset = [...document.querySelectorAll(
        ".x-page-search-plus-presets__preset, [class*='presets__preset'], a, button, [role=tab]"
      )].find((el) => labelRe.test((el.innerText || "").replace(/\s+/g, " ").trim()));
      if (preset) {
        preset.click();
        return true;
      }
      return false;
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
        // fallback: try native txt
        await this.nativeSave("txt");
        return {
          title,
          text: "",
          html: "",
          nativeSaveTriggered: true,
          url: location.href,
          format: "txt",
        };
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
        url: location.href,
        title: document.title,
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
