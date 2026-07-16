/** Resolve a task's Repository value (GitHub URL or local path) to a working directory. */
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

function expandHome(p) {
  if (!p) return p;
  if (p === "~") return process.env.HOME || p;
  if (p.startsWith("~/")) return path.join(process.env.HOME || "", p.slice(2));
  return p;
}

function isRepoUrl(value) {
  return /^(https?:\/\/|git@|ssh:\/\/)/.test(value);
}

function repoNameFromUrl(url) {
  return url
    .replace(/\.git$/, "")
    .replace(/\/+$/, "")
    .split(/[/:]/)
    .pop();
}

// value: GitHub URL → clone into reposRoot/<name> once; local path → use as-is;
// empty → fallback. Returns an absolute working directory for the agent's cwd.
function resolveRepoDir(value, reposRoot, fallback, { clone = true } = {}) {
  const v = (value || "").trim();
  if (!v) return expandHome(fallback);
  if (!isRepoUrl(v)) return expandHome(v);

  const root = expandHome(reposRoot || "~/projects");
  const dir = path.join(root, repoNameFromUrl(v));
  if (clone && !fs.existsSync(dir)) {
    fs.mkdirSync(root, { recursive: true });
    execSync(`git clone ${JSON.stringify(v)} ${JSON.stringify(dir)}`, {
      stdio: "inherit",
    });
  }
  return dir;
}

module.exports = { resolveRepoDir, isRepoUrl, repoNameFromUrl, expandHome };

// ponytail: one runnable self-check for the money path (URL/path parsing + resolution).
if (require.main === module) {
  const assert = require("node:assert/strict");
  assert.equal(isRepoUrl("https://github.com/you/telemetry"), true);
  assert.equal(isRepoUrl("git@github.com:you/telemetry.git"), true);
  assert.equal(isRepoUrl("/Users/me/projects/x"), false);
  assert.equal(isRepoUrl("~/projects/x"), false);
  assert.equal(repoNameFromUrl("https://github.com/you/telemetry.git"), "telemetry");
  assert.equal(repoNameFromUrl("git@github.com:you/telemetry.git"), "telemetry");
  assert.equal(repoNameFromUrl("https://github.com/you/telemetry/"), "telemetry");
  assert.equal(expandHome("~/p"), path.join(process.env.HOME || "", "p"));
  assert.equal(resolveRepoDir("/tmp/x", "~/projects", "/fallback"), "/tmp/x");
  assert.equal(resolveRepoDir("", "~/projects", "/fallback"), "/fallback");
  assert.equal(
    resolveRepoDir("https://github.com/you/telemetry", "/repos", "/fb", { clone: false }),
    "/repos/telemetry"
  );
  console.log("repo.js self-check passed");
}
