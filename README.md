# KADE

Notion-driven AI task orchestration. Break prompts into structured tasks in Notion, then auto-dispatch them to provider CLIs (Claude, Codex, OpenCode, Grok, Gemini) with zero token cost on database operations.

## Setup

1. **Notion integration** — Create at [notion.so/my-integrations](https://www.notion.so/my-integrations) and copy the token.

2. **Share databases** — Open your [KADE setup](https://descriptive-tomato-e8d.notion.site/KADE-Workspace-Template-39f7db1ae37b80f3a84ff22c7d37c46f?source=copy_link) page and invite the integration to both **Projects** and **Tasks** databases.

3. **Run the guided setup**:

```bash
npm install
npm run setup
```

`npm run setup` prompts for your token, the two database ids (paste the id or the full Notion URL), and the working repo path, writes `.env` + `config.json`, then validates the live schema.

<details>
<summary>Prefer to do it by hand?</summary>

```bash
cp .env.example .env   # set NOTION_TOKEN
# then edit config.json: notion.tasks_database_id, notion.projects_database_id, repo.path
```
</details>

On startup the poller also validates the live Notion schema (property names + Status options) and exits with a clear diff if anything is missing.

## Usage

### Populate tasks from a plan

```bash
node src/populate.js test/sample-plan.json
```

Or pipe JSON from your CLI session:

```bash
./scripts/populate-from-stdin.sh < test/sample-plan.json
```

### Run the poller daemon

```bash
./scripts/start-poller.sh
```

The poller watches for tasks with **Status = In Progress** and **Assigned = false**, then dispatches them to the configured provider CLI. On completion, status moves to **Done** (success) or back to **Not Started** (failure), per `config.json`. If the poller crashes mid-run, stale tasks are automatically reclaimed and re-dispatched after the lease timeout.

## Workflow

1. Ask your CLI agent to plan a task (see `AGENTS.md` for the JSON format)
2. Run `populate.js` with the output
3. Review tasks in Notion
4. Move tasks to **In Progress** when ready
5. Poller dispatches to the provider CLI
6. Review completed work and mark **Done**

## Notion schema

Uses the standard Projects + Tasks template with KADE extensions on Tasks:

| Property | Purpose |
|---|---|
| Provider | Which CLI agent runs the task |
| Model | Which model to pass to the CLI (`--model` / `-m`) |
| Repository | Which repo/dir the task runs in (GitHub URL or path); blank = default |
| Assigned | Prevents double-dispatch |
| Blocked By / Related To | Task dependencies |
| Started At / Completed on | Timestamps |
| Exit Code / Error Log | Agent result tracking |

Database IDs are configured in `config.json`.

## One template per repo

Each **KADE setup** page is a self-contained template for one repository. Duplicate the page per repo — the binding travels *in Notion*, so it works on any machine.

**How a task finds its directory** (first match wins):

1. The task's **Repository** field — optional per-task override, blank by default (lets an agent work on another repo).
2. The **template default**, stored once in the **Tasks DB description** as `repo=<url>` and read once per database.
3. `repo.path` in `config.json` (the machine's default / fallback).

A repo value can be a **GitHub URL** (`https://github.com/you/telemetry`) — cloned once into `repos_root/<name>` (default `~/projects`, set in `config.json`) — or an **absolute local path**, used as-is. The repo lives at the *template* level, so it isn't repeated on every task.

**Install a new repo (no config editing):**

1. Duplicate the KADE setup page.
2. Set the default repo **once** — edit the Tasks DB description to `repo=<url>`, or put `repo` in your plan (`populate.js` writes it to the description for you).
3. Share both databases with your integration.

The poller **auto-discovers** every KADE "Tasks" database shared with the integration (one poller watches them all) and clones each repo on first run. Set `poll.discover: false` in `config.json` to watch only the configured DB.

**Export / move machines:** nothing machine-specific lives in Notion — duplicate or share the page anywhere; the new machine only needs its own `repos_root`.

## Project structure

```
kade/
├── config.json          # Database IDs, poll settings, provider adapters
├── src/
│   ├── populate.js      # JSON → Notion pages
│   ├── poller.js        # Watches + dispatches
│   ├── providers.js     # CLI spawn logic
│   ├── notion-client.js # Notion API wrapper
│   └── updater.js       # Post-completion updates
├── lib/
│   ├── schema.js        # Property name mappings
│   └── logger.js
└── scripts/
    ├── populate-from-stdin.sh
    └── start-poller.sh
```
