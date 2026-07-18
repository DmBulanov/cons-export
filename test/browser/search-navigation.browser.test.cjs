const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { chromium } = require("playwright");

const extensionPath = path.resolve(__dirname, "../../extension");
const SEARCH_QUERY = "навигационная регрессия";
const expectedSearchUrl = new URL("https://online.consultant.ru/riv/cgi/online.cgi");
expectedSearchUrl.searchParams.set("req", "card");
expectedSearchUrl.searchParams.set("page", "splus");
expectedSearchUrl.searchParams.set("splusFind", SEARCH_QUERY);
expectedSearchUrl.hash = "splus";
const SEARCH_URL = expectedSearchUrl.href;
const SEARCH_REQUEST_URL = SEARCH_URL.replace("#splus", "");

function pageHtml({ scope, query }) {
  const isPractice = scope === "practice";
  const title = isPractice ? "POST-SCOPE судебная практика" : "PRE-SCOPE все документы";
  const documentId = isPractice ? "2" : "1";
  const activeAll = isPractice ? "" : " x-page-search-plus-presets__preset--active";
  const activePractice = isPractice ? " x-page-search-plus-presets__preset--active" : "";
  return `<!doctype html>
    <meta charset="utf-8">
    <title>Синтетический КонсультантПлюс</title>
    <input class="x-page-components-search-panel__filter" value="${query.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}">
    <button type="button">Найти</button>
    <div class="x-page-search-plus-presets">
      <button class="x-page-search-plus-presets__preset${activeAll}" data-preset="1">Все документы</button>
      <button class="x-page-search-plus-presets__preset${activePractice}" data-preset="2">Судебная практика</button>
    </div>
    <main class="x-page-search-plus-results">
      <a class="x-page-components-search-result-item__extra-title" href="?req=doc&base=LAW&n=${documentId}">${title}</a>
    </main>
    <script>
      document.querySelector('[data-preset="2"]').addEventListener("click", () => {
        // window.name survives a same-URL document navigation and lets the fixture
        // prove that the scope control, rather than the initial query load, caused it.
        window.name = "cons-export-scope-click";
        location.reload();
      });
    </script>`;
}

test("search flow survives a same-URL scope navigation and returns only post-scope items", async (t) => {
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "cons-export-search-flow-"));
  let context;
  t.after(async () => {
    await context?.close();
    await fs.rm(userDataDir, { recursive: true, force: true });
  });

  context = await chromium.launchPersistentContext(userDataDir, {
    channel: "chromium",
    headless: true,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
    ],
  });

  let [worker] = context.serviceWorkers();
  worker ||= await context.waitForEvent("serviceworker", { timeout: 15000 });
  const extensionId = new URL(worker.url()).hostname;

  const requests = [];
  await context.route("https://online.consultant.ru/**", async (route) => {
    const url = new URL(route.request().url());
    const query = url.searchParams.get("splusFind") || "";
    const isSearch = query === SEARCH_QUERY;
    requests.push({ url: url.href, query, isSearch });
    const searchLoads = requests.filter((entry) => entry.isSearch).length;
    // First search load is the broad result list. The next request has exactly
    // the same URL and must therefore have come from the scope control reload.
    await route.fulfill({
      contentType: "text/html; charset=utf-8",
      body: pageHtml({
        query,
        scope: isSearch && searchLoads > 1 ? "practice" : "all",
      }),
    });
  });

  const consultant = await context.newPage();
  await consultant.goto("https://online.consultant.ru/riv/cgi/online.cgi?req=home");
  await consultant.locator(".x-page-components-search-panel__filter").waitFor();

  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup/popup.html`);
  await popup.locator("#btnFind").waitFor();
  await popup.locator("#query").fill(SEARCH_QUERY);
  await popup.locator("#scope").selectOption("practice");
  await popup.locator("#btnFind").click();

  try {
    await popup.waitForFunction(() => {
      const progress = document.querySelector("#progressText")?.textContent || "";
      return /^найдено:\s*1$/.test(progress);
    }, undefined, { timeout: 20000 });
  } catch (error) {
    const state = await popup.evaluate(() => ({
      progress: document.querySelector("#progressText")?.textContent,
      log: document.querySelector("#log")?.textContent,
    }));
    error.message += `; popup state: ${JSON.stringify(state)}; search requests: ${requests.length}`;
    throw error;
  }

  const resultLog = await popup.locator("#log").textContent();
  assert.match(resultLog, /POST-SCOPE судебная практика/);
  assert.doesNotMatch(resultLog, /PRE-SCOPE все документы/);

  const searchRequests = requests.filter((entry) => entry.isSearch);
  assert.equal(searchRequests.length, 2, "query navigation and scope navigation must both occur");
  assert.equal(searchRequests[0].url, SEARCH_REQUEST_URL);
  assert.equal(searchRequests[1].url, SEARCH_REQUEST_URL, "scope must tolerate a reload to the identical URL");
  assert.equal(await consultant.evaluate(() => window.name), "cons-export-scope-click");
  assert.equal(consultant.url(), SEARCH_URL);
  assert.match(await consultant.locator(".x-page-components-search-result-item__extra-title").textContent(), /POST-SCOPE/);
});
