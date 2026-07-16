const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { resolveRepoDir, isRepoUrl, repoNameFromUrl, expandHome } = require("../lib/repo");

test("isRepoUrl distinguishes URLs from local paths", () => {
  assert.equal(isRepoUrl("https://github.com/you/telemetry"), true);
  assert.equal(isRepoUrl("git@github.com:you/telemetry.git"), true);
  assert.equal(isRepoUrl("ssh://git@host/you/x.git"), true);
  assert.equal(isRepoUrl("/Users/me/projects/x"), false);
  assert.equal(isRepoUrl("~/projects/x"), false);
});

test("repoNameFromUrl extracts the repo name", () => {
  assert.equal(repoNameFromUrl("https://github.com/you/telemetry.git"), "telemetry");
  assert.equal(repoNameFromUrl("git@github.com:you/telemetry.git"), "telemetry");
  assert.equal(repoNameFromUrl("https://github.com/you/telemetry/"), "telemetry");
});

test("resolveRepoDir: local path passthrough and fallback", () => {
  assert.equal(resolveRepoDir("/tmp/x", "~/projects", "/fallback"), "/tmp/x");
  assert.equal(resolveRepoDir("", "~/projects", "/fallback"), "/fallback");
  assert.equal(resolveRepoDir("  ", "~/projects", "/fallback"), "/fallback");
});

test("resolveRepoDir: URL maps under repos_root (no clone in test)", () => {
  assert.equal(
    resolveRepoDir("https://github.com/you/telemetry", "/repos", "/fb", { clone: false }),
    "/repos/telemetry"
  );
});

test("expandHome expands ~", () => {
  assert.equal(expandHome("~/p"), path.join(process.env.HOME || "", "p"));
  assert.equal(expandHome("/abs"), "/abs");
});
