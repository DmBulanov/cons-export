/**
 * Adapter for the public site www.consultant.ru
 * (search results + document pages — no client login required).
 */
(function () {
  const PublicSiteAdapter = {
    id: "public-site",

    matches(url) {
      try {
        const u = new URL(url);
        if (!u.hostname.endsWith("consultant.ru")) return false;
        // Online client hosts are handled by online-app adapter.
        if (/^(login|online|client)\./i.test(u.hostname)) return false;
        return (
          u.pathname.startsWith("/search") ||
          u.pathname.startsWith("/document/") ||
          u.hostname === "www.consultant.ru" ||
          u.hostname === "consultant.ru"
        );
      } catch {
        return false;
      }
    },

    detectPage() {
      const path = location.pathname;
      if (path.startsWith("/search")) return "list";
      if (path.startsWith("/document/")) return "document";
      return "unknown";
    },

    /** Collect document links from a search-results page. */
    collectListItems() {
      const items = [];
      const seen = new Set();
      document
        .querySelectorAll("a.search-results__link[href*='/document/']")
        .forEach((a, i) => {
          const href = a.href;
          if (!href || seen.has(href)) return;
          seen.add(href);
          const title = a.innerText.replace(/^\d+\s*/, "").replace(/\s+/g, " ").trim();
          items.push({ index: i + 1, title, url: href });
        });
      return items;
    },

    /**
     * Public-site search: navigate to /search/?q=…
     */
    async runSearch(query, options = {}) {
      const q = String(query || "").trim();
      if (!q) throw new Error("Пустой запрос");
      const target = `https://www.consultant.ru/search/?q=${encodeURIComponent(q)}`;
      if (!location.href.startsWith(target.split("?")[0]) || !location.search.includes("q=")) {
        location.assign(target);
        // Navigation will unload this document; caller should wait/re-query.
        return { query: q, navigating: true, url: target, items: [], count: 0 };
      }
      const items = this.collectListItems();
      return { query: q, scope: options.scope || "all", items, count: items.length, url: location.href };
    },

    /**
     * Expand "полный текст" if present, then extract title + body.
     * @returns {{ title: string, text: string, html: string }}
     */
    async extractCurrentDocument() {
      const fullBtn = document.querySelector(".full-text__button");
      if (fullBtn && /полный/i.test(fullBtn.textContent || "")) {
        fullBtn.click();
        await new Promise((r) => setTimeout(r, 800));
      }

      const title =
        document.querySelector("h1")?.innerText?.trim() ||
        document.querySelector(".document-page__title")?.innerText?.trim() ||
        document.title.replace(/\s*\\?\s*КонсультантПлюс.*$/i, "").trim();

      const root =
        document.querySelector(".document-page__main") ||
        document.querySelector(".content.document-page") ||
        document.querySelector("main") ||
        document.body;

      // Drop chrome: nav, search, promo
      const clone = root.cloneNode(true);
      clone
        .querySelectorAll(
          "nav, .header, .breadcrumbs, .search, script, style, .promo, iframe"
        )
        .forEach((el) => el.remove());

      const text = clone.innerText.replace(/\n{3,}/g, "\n\n").trim();
      const html = `<!DOCTYPE html><html lang="ru"><head><meta charset="utf-8"><title>${escapeHtml(
        title
      )}</title></head><body>${clone.innerHTML}</body></html>`;

      return { title, text, html, url: location.href };
    },

    probe() {
      return {
        url: location.href,
        title: document.title,
        hostname: location.hostname,
        listCount: this.collectListItems().length,
        page: this.detectPage(),
        hasFullTextButton: Boolean(document.querySelector(".full-text__button")),
      };
    },
  };

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  globalThis.ConsAdapters = globalThis.ConsAdapters || {};
  globalThis.ConsAdapters.publicSite = PublicSiteAdapter;
})();
