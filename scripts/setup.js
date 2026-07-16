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

// Read a secret without echoing it to the terminal.
function askSecret(label) {
  return new Promise((res) => {
    const stdin = process.stdin;
    process.stdout.write(`${paint(c.cyan, "?")} ${label} ${paint(c.dim, "›")} `);
    const wasRaw = stdin.isRaw;
    if (stdin.isTTY) stdin.setRawMode(true);
    let buf = "";
    const onData = (ch) => {
      const s = ch.toString("utf8");
      if (s === "\r" || s === "\n") {
        if (stdin.isTTY) stdin.setRawMode(wasRaw);
        stdin.removeListener("data", onData);
        process.stdout.write("\n");
        res(buf.trim());
      } else if (s === "\x03") {
        process.exit(1); // ctrl-c
      } else if (s === "\x7f" || s === "\b") {
        if (buf.length) {
          buf = buf.slice(0, -1);
          process.stdout.write("\b \b");
        }
      } else if (s >= " ") {
        buf += s;
        process.stdout.write("*");
      }
    };
    stdin.on("data", onData);
  });
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

async function main() {
  console.log(paint(c.bold + c.magenta, "\n  ⬡ KADE setup\n"));
  console.log(paint(c.dim, "  Notion-driven AI task orchestration. Let's wire up the basics.\n"));

  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  const tokenEnv = config.notion.token_env || "NOTION_TOKEN";

  console.log(paint(c.bold, "  1. Notion integration"));
  console.log(paint(c.dim, "     Create one at https://www.notion.so/my-integrations and share both DBs with it.\n"));
  const token = await askSecret(`Paste your ${tokenEnv}`);

  console.log(paint(c.bold, "\n  2. Databases") + paint(c.dim, "  (paste the id or the full Notion URL)"));
  const tasksId = normalizeId(
    await ask("Tasks database", { def: config.notion.tasks_database_id, required: true })
  );
  const projectsId = normalizeId(
    await ask("Projects database", { def: config.notion.projects_database_id, required: true })
  );

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
      delete require.cache[require.resolve("../src/notion-client")];
      const { validateSchema } = require("../src/notion-client");
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
