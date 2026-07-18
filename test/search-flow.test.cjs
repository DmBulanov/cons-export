const assert = require("node:assert/strict");
const test = require("node:test");

const { consCreateSearchFlow } = require("../extension/background/search-flow.js");
const {
  consBuildOnlineSearchUrl,
  consBuildPublicSearchUrl,
} = require("../extension/shared/runtime.js");

function item(title, n) {
  return {
    index: 1,
    title,
    url: `https://online.consultant.ru/riv/cgi/online.cgi?req=doc&base=LAW&n=${n}`,
  };
}

test("background search arms each load cycle and returns only post-scope items", async () => {
  let clock = 0;
  let state = {
    queryMatches: false,
    queryAuthoritative: false,
    activeScope: "all",
    loading: false,
    resultsReady: true,
    resultCount: 1,
    resultSignature: "stale",
    items: [item("STALE old query", 0)],
  };
  let activeCycle = null;
  let scopePending = false;
  const order = [];

  const flow = consCreateSearchFlow({
    sendToTab: async (_tabId, message) => {
      if (message.type === "GET_SEARCH_STATE") {
        return { ok: true, adapter: "online-app", state: structuredClone(state) };
      }
      assert.equal(message.type, "CLICK_SEARCH_SCOPE");
      assert.ok(activeCycle, "scope listener must be armed before the trigger message");
      order.push("scope-trigger");
      scopePending = true;
      return {
        ok: true,
        triggered: true,
        navigationExpected: true,
        beforeSignature: state.resultSignature,
      };
    },
    navigate: async (_tab, url) => {
      assert.ok(activeCycle, "query listener must be armed before tabs.update");
      assert.equal(activeCycle.state.sawLoading, false);
      assert.equal(activeCycle.state.sawComplete, true, "a stale complete may arrive first");
      order.push("query-navigate");
      activeCycle.state.sawLoading = true;
      activeCycle.state.sawComplete = true;
      state = {
        queryMatches: true,
        queryAuthoritative: true,
        activeScope: "all",
        loading: false,
        resultsReady: true,
        resultCount: 1,
        resultSignature: "broad",
        items: [item("PRE-SCOPE broad result", 1)],
      };
      assert.equal(new URL(url).searchParams.get("splusFind"), "аренда + долг");
    },
    observeTabLoadCycle: () => {
      order.push("armed");
      const cycle = {
        state: { sawLoading: false, sawComplete: true },
        dispose() {
          if (activeCycle === cycle) activeCycle = null;
        },
      };
      activeCycle = cycle;
      return cycle;
    },
    buildOnlineSearchUrl: consBuildOnlineSearchUrl,
    buildPublicSearchUrl: consBuildPublicSearchUrl,
    now: () => clock,
    delay: async (ms) => {
      clock += ms;
      if (scopePending) {
        scopePending = false;
        activeCycle.state.sawLoading = true;
        activeCycle.state.sawComplete = true;
        state = {
          queryMatches: true,
          queryAuthoritative: true,
          activeScope: "practice",
          loading: false,
          resultsReady: true,
          resultCount: 1,
          resultSignature: "practice",
          items: [item("POST-SCOPE judicial result", 2)],
        };
      }
    },
    pollMs: 100,
    settleMs: 200,
    timeoutMs: 2000,
  });

  const result = await flow.run({
    tab: {
      id: 7,
      url: "https://online.consultant.ru/riv/cgi/online.cgi?req=home&rnd=test",
    },
    adapter: "online-app",
    query: "аренда + долг",
    scope: "practice",
  });

  assert.deepEqual(order, ["armed", "query-navigate", "armed", "scope-trigger"]);
  assert.equal(result.scopeApplied, true);
  assert.deepEqual(result.items.map((entry) => entry.title), [
    "POST-SCOPE judicial result",
  ]);
  assert.doesNotMatch(JSON.stringify(result.items), /STALE|PRE-SCOPE/);
});

test("an already verified query and scope cause no navigation or click", async () => {
  let sends = 0;
  const ready = {
    queryMatches: true,
    queryAuthoritative: true,
    activeScope: "practice",
    loading: false,
    resultsReady: true,
    resultCount: 1,
    resultSignature: "ready",
    items: [item("Ready", 3)],
  };
  const flow = consCreateSearchFlow({
    sendToTab: async (_tabId, message) => {
      sends += 1;
      assert.equal(message.type, "GET_SEARCH_STATE");
      return { ok: true, adapter: "online-app", state: ready };
    },
    navigate: async () => assert.fail("unexpected navigation"),
    observeTabLoadCycle: () => assert.fail("unexpected load observer"),
    buildOnlineSearchUrl: consBuildOnlineSearchUrl,
    buildPublicSearchUrl: consBuildPublicSearchUrl,
  });

  const result = await flow.run({
    tab: { id: 8, url: "https://online.consultant.ru/?req=card&page=splus" },
    adapter: "online-app",
    query: "ready",
    scope: "practice",
  });

  assert.equal(sends, 1);
  assert.equal(result.items[0].title, "Ready");
});

test("auth redirects and an unconfirmed scope fail closed", async () => {
  const authFlow = consCreateSearchFlow({
    sendToTab: async () => ({
      ok: false,
      code: "AUTH_REQUIRED",
      error: "login",
    }),
    navigate: async () => {},
    observeTabLoadCycle: () => ({ state: {}, dispose() {} }),
    buildOnlineSearchUrl: consBuildOnlineSearchUrl,
    buildPublicSearchUrl: consBuildPublicSearchUrl,
  });
  await assert.rejects(
    authFlow.run({
      tab: { id: 9, url: "https://online.consultant.ru/?req=home" },
      adapter: "online-app",
      query: "test",
      scope: "practice",
    }),
    (error) => error.code === "AUTH_REQUIRED"
  );

  let clock = 0;
  const wrongScope = {
    queryMatches: true,
    queryAuthoritative: true,
    activeScope: "all",
    loading: false,
    resultsReady: true,
    resultCount: 1,
    resultSignature: "all",
    items: [item("Broad", 4)],
  };
  const mismatchFlow = consCreateSearchFlow({
    sendToTab: async (_tabId, message) =>
      message.type === "GET_SEARCH_STATE"
        ? { ok: true, adapter: "online-app", state: wrongScope }
        : { ok: true, triggered: true, navigationExpected: true },
    navigate: async () => {},
    observeTabLoadCycle: () => ({
      state: { sawLoading: true, sawComplete: true },
      dispose() {},
    }),
    buildOnlineSearchUrl: consBuildOnlineSearchUrl,
    buildPublicSearchUrl: consBuildPublicSearchUrl,
    now: () => clock,
    delay: async (ms) => {
      clock += ms;
    },
    pollMs: 100,
    settleMs: 100,
    timeoutMs: 400,
  });
  await assert.rejects(
    mismatchFlow.run({
      tab: { id: 10, url: "https://online.consultant.ru/?req=card&page=splus" },
      adapter: "online-app",
      query: "test",
      scope: "practice",
    }),
    (error) => error.code === "SEARCH_TIMEOUT"
  );
});

test("public search uses the same verified navigation flow without a scope click", async () => {
  let clock = 0;
  let navigations = 0;
  let state = {
    queryMatches: false,
    queryAuthoritative: false,
    activeScope: "all",
    loading: false,
    resultsReady: false,
    resultCount: 0,
    resultSignature: "empty",
    items: [],
  };
  let cycle;
  const flow = consCreateSearchFlow({
    sendToTab: async (_tabId, message) => {
      assert.equal(message.type, "GET_SEARCH_STATE");
      return { ok: true, adapter: "public-site", state };
    },
    navigate: async (_tab, url) => {
      navigations += 1;
      assert.equal(new URL(url).searchParams.get("q"), "публичный запрос");
      cycle.state.sawLoading = true;
      cycle.state.sawComplete = true;
      state = {
        queryMatches: true,
        queryAuthoritative: true,
        activeScope: "all",
        loading: false,
        resultsReady: true,
        resultCount: 1,
        resultSignature: "public",
        items: [
          {
            index: 1,
            title: "Public result",
            url: "https://www.consultant.ru/document/cons_doc_LAW_1/",
          },
        ],
      };
    },
    observeTabLoadCycle: () => {
      cycle = { state: { sawLoading: false, sawComplete: false }, dispose() {} };
      return cycle;
    },
    buildOnlineSearchUrl: consBuildOnlineSearchUrl,
    buildPublicSearchUrl: consBuildPublicSearchUrl,
    now: () => clock,
    delay: async (ms) => {
      clock += ms;
    },
    pollMs: 100,
    settleMs: 100,
    timeoutMs: 1000,
  });

  const result = await flow.run({
    tab: { id: 11, url: "https://www.consultant.ru/" },
    adapter: "public-site",
    query: "публичный запрос",
    scope: "all",
  });
  assert.equal(navigations, 1);
  assert.equal(result.items[0].title, "Public result");
});
