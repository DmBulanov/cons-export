const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const source = fs.readFileSync(
  path.resolve(__dirname, "../extension/popup/popup.js"),
  "utf8"
);

test("cached result provenance is exported with the cached list", () => {
  assert.match(source, /let cachedQuery = ""/);
  assert.match(source, /let cachedScope = "current-list"/);
  assert.match(source, /cachedQuery = String\(meta\.query \|\| ""\)/);
  assert.match(source, /cachedScope = String\(meta\.scope \|\| "current-list"\)/);
  assert.match(source, /query: cachedQuery,[\s\S]*scope: cachedScope/);
  assert.doesNotMatch(
    source,
    /type: "START_TAB_EXPORT",[\s\S]{0,400}query: els\.query\.value\.trim\(\)/
  );
});

test("copied diagnostics use the shared allowlist and never copy the job log", () => {
  assert.match(source, /type: "GET_DOWNLOAD_DIAGNOSTICS"/);
  assert.match(source, /consBuildSafeDiagnosticsSnapshot/);
  assert.doesNotMatch(
    source,
    /btnProbe[\s\S]{0,1200}(?:progress\.log|response\.progress|job\.log)/
  );
});
