#!/usr/bin/env node
/**
 * Interactive KADE setup — collects the handful of values install needs,
 * writes .env + config.json, and verifies the Notion schema.
 * ponytail: stdlib readline + ANSI only, no prompt/color deps.
 */

const fs = require("fs");
const path = require("path");
const readline = require("readline");

const ROOT = path.join(__dirname, "..");
const CONFIG_PATH = path.join(ROOT, "config.json");
const ENV_PATH = path.join(ROOT, ".env");

const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  magenta: "\x1b[35m",
};
const paint = (color, s) => `${color}${s}${c.reset}`;

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const question = (q) => new Promise((res) => rl.question(q, res));

async function ask(label, { def, required, hint } = {}) {
  const suffix = def ? paint(c.dim, ` (${def})`) : "";
  const hintLine = hint ? paint(c.dim, `  ${hint}\n`) : "";
  for (;;) {
    process.stdout.write(hintLine);
    const answer = (await question(`${paint(c.cyan, "?")} ${label}${suffix} ${paint(c.dim, "›")} `)).trim();
    const value = answer || def || "";
    if (value || !required) return value;
    console.log(paint(c.red, "  This one is required.\n"));
  }
}

// Prompt for the token. It echoes to the terminal like any other answer.
async function askSecret(label) {
  return (await question(`${paint(c.cyan, "?")} ${label} ${paint(c.dim, "›")} `)).trim();
}

// Accept a raw 32-char id, a hyphenated id, or a full Notion URL.
function normalizeId(input) {
  const hex = (input.match(/[0-9a-fA-F]{32}/) || [])[0];
  if (!hex) return input.trim();
  const h = hex.toLowerCase();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function upsertEnv(envText, key, value) {
  const line = `${key}=${value}`;
  const re = new RegExp(`^${key}=.*$`, "m");
  if (re.test(envText)) return envText.replace(re, line);
  return (envText ? envText.replace(/\n?$/, "\n") : "") + line + "\n";
}

async function manualDatabases(config) {
  console.log(paint(c.dim, "  Paste the id or the full Notion URL.\n"));
  return {
    tasksId: normalizeId(await ask("Tasks database", { def: config.notion.tasks_database_id, required: true })),
    projectsId: normalizeId(await ask("Projects database", { def: config.notion.projects_database_id, required: true })),
  };
}

// Auto-discover the template's Tasks+Projects DBs from the shared page — no id
// pasting. Falls back to manual entry with no token or if search finds nothing
// (e.g. the page isn't shared yet, or Notion's search index hasn't caught up).
async function resolveDatabases(config, token, tokenEnv) {
  if (!token) return manualDatabases(config);

  process.env[tokenEnv] = token;
  delete require.cache[require.resolve("../src/notion-client")];
  const { discoverTemplates, templateLabel } = require("../src/notion-client");

  process.stdout.write(paint(c.dim, "  Searching your shared pages… "));
  let templates = [];
  try {
    templates = await discoverTemplates();
  } catch (err) {
    console.log(paint(c.red, "failed") + paint(c.dim, ` (${err.message})`));
    return manualDatabases(config);
  }

  if (templates.length === 0) {
    console.log(paint(c.yellow, "none found"));
    console.log(paint(c.dim, "  Share the KADE page with your integration, then re-run — or enter ids by hand.\n"));
    return manualDatabases(config);
  }

  let chosen = templates[0];
  if (templates.length === 1) {
    console.log(paint(c.green, "found ") + paint(c.dim, `"${chosen.name}"`));
  } else {
    const labels = templates.map((t) => templateLabel(templates, t));
    console.log(paint(c.green, `found ${templates.length}`));
    templates.forEach((t, i) => console.log(paint(c.dim, `    ${i + 1}. `) + labels[i]));
    const pick = Number(await ask("Default template #", { def: "1", required: true }));
    chosen = templates[pick - 1] || templates[0];
    const chosenLabel = labels[templates.indexOf(chosen)];
    console.log(paint(c.dim, `  Default → ${chosenLabel}. Populate others with `) + paint(c.cyan, "--template <name>") + "\n");
  }
  return { tasksId: chosen.tasksDbId, projectsId: chosen.projectsDbId };
}

async function main() {
  console.log(paint(c.bold + c.magenta, "\n  ⬡ KADE setup\n"));
  console.log(paint(c.dim, "  Notion-driven AI task orchestration. Let's wire up the basics.\n"));

  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  const tokenEnv = config.notion.token_env || "NOTION_TOKEN";

  console.log(paint(c.bold, "  1. Notion integration"));
  console.log(paint(c.dim, "     Create one at https://www.notion.so/my-integrations and share your KADE page with it.\n"));
  const token = await askSecret(`Paste your ${tokenEnv}`);

  console.log(paint(c.bold, "\n  2. Template"));
  const { tasksId, projectsId } = await resolveDatabases(config, token, tokenEnv);

  console.log(paint(c.bold, "\n  3. Working repo") + paint(c.dim, "  where agents run"));
  const repoPath = await ask("Repo path", { def: config.repo.path || process.cwd(), required: true });

  // Persist.
  config.notion.tasks_database_id = tasksId;
  config.notion.projects_database_id = projectsId;
  config.repo.path = repoPath;
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n");
  console.log(paint(c.green, "\n  ✓ ") + paint(c.dim, "config.json updated"));

  if (token) {
    const existing = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, "utf8") : "";
    fs.writeFileSync(ENV_PATH, upsertEnv(existing, tokenEnv, token));
    console.log(paint(c.green, "  ✓ ") + paint(c.dim, `.env updated (${tokenEnv})`));
  } else {
    console.log(paint(c.yellow, "  ! ") + paint(c.dim, "no token entered — set it in .env before running the poller"));
  }

  // Verify against the live template if we have a token.
  if (token) {
    process.env[tokenEnv] = token;
    process.stdout.write(paint(c.dim, "\n  Validating Notion schema… "));
    try {
      // Reuse the module loaded during discovery (don't re-require — that would
      // re-read the stale cached config.json). Point it at the ids we just wrote.
      const { validateSchema, useTemplate } = require("../src/notion-client");
      useTemplate({ tasksDbId: tasksId, projectsDbId: projectsId });
      await validateSchema();
      console.log(paint(c.green, "ok\n"));
    } catch (err) {
      console.log(paint(c.red, "failed"));
      console.log(paint(c.red, "  " + err.message.split("\n").join("\n  ")) + "\n");
      console.log(paint(c.dim, "  Fix the template (or config) and re-run: ") + paint(c.cyan, "npm run setup\n"));
      rl.close();
      process.exit(1);
    }
  }

  console.log(paint(c.bold + c.green, "  All set.") + paint(c.dim, " Next:"));
  console.log(paint(c.cyan, "    node src/populate.js test/sample-plan.json") + paint(c.dim, "  # create tasks"));
  console.log(paint(c.cyan, "    ./scripts/start-poller.sh") + paint(c.dim, "                  # run the daemon\n"));
  rl.close();
}

main().catch((err) => {
  console.error(paint(c.red, `\nSetup failed: ${err.message}`));
  rl.close();
  process.exit(1);
});
