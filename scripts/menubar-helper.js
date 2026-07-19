#!/usr/bin/env node
/**
 * Headless bridge for the KADE menubar app. Reuses the exact same setup logic
 * (notion-client discovery + validation, .env/config.json writes) that
 * `npm run setup` uses — the GUI just calls this and reads JSON off stdout.
 * ponytail: no deps, no server; one process per action, JSON in/out.
 *
 *   node scripts/menubar-helper.js discover        # NOTION_TOKEN in env
 *   node scripts/menubar-helper.js save '<json>'   # {token,tasksDbId,projectsDbId,repoPath}
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const CONFIG_PATH = path.join(ROOT, "config.json");
const ENV_PATH = path.join(ROOT, ".env");

const done = (obj) => {
  process.stdout.write(JSON.stringify(obj));
  process.exit(obj.ok === false ? 1 : 0);
};

function upsertEnv(envText, key, value) {
  const line = `${key}=${value}`;
  const re = new RegExp(`^${key}=.*$`, "m");
  if (re.test(envText)) return envText.replace(re, line);
  return (envText ? envText.replace(/\n?$/, "\n") : "") + line + "\n";
}

async function discover(config, tokenEnv) {
  const token = process.env[tokenEnv];
  if (!token) return done({ ok: false, error: `${tokenEnv} not set` });
  const { discoverTemplates } = require("../src/notion-client");
  const templates = await discoverTemplates();
  done({
    ok: true,
    templates: templates.map((t) => ({
      name: t.name || "Untitled",
      pageId: t.pageId,
      tasksDbId: t.tasksDbId,
      projectsDbId: t.projectsDbId,
    })),
  });
}

async function save(config, tokenEnv, raw) {
  const { token, tasksDbId, projectsDbId, repoPath } = JSON.parse(raw || "{}");
  if (!token || !tasksDbId || !projectsDbId || !repoPath) {
    return done({ ok: false, error: "token, tasksDbId, projectsDbId, repoPath all required" });
  }

  // Validate live before persisting — same order setup.js uses.
  process.env[tokenEnv] = token;
  const { validateSchema, useTemplate } = require("../src/notion-client");
  useTemplate({ tasksDbId, projectsDbId });
  await validateSchema();

  config.notion.tasks_database_id = tasksDbId;
  config.notion.projects_database_id = projectsDbId;
  config.repo.path = repoPath;
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n");

  const existing = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, "utf8") : "";
  fs.writeFileSync(ENV_PATH, upsertEnv(existing, tokenEnv, token));

  done({ ok: true });
}

async function main() {
  const [action, arg] = process.argv.slice(2);
  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  const tokenEnv = config.notion.token_env || "NOTION_TOKEN";
  if (action === "discover") return discover(config, tokenEnv);
  if (action === "save") return save(config, tokenEnv, arg);
  done({ ok: false, error: `unknown action "${action}"` });
}

main().catch((err) => done({ ok: false, error: err.message }));
