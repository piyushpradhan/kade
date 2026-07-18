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

`npm run setup` prompts for your token, then **auto-discovers** your template's Projects + Tasks databases from the shared page (no ids to paste — pick a default if you have several), asks for the working repo path, writes `.env` + `config.json`, and validates the live schema. If nothing is shared yet it falls back to asking for the ids by hand.

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

With multiple templates, target one by its page name (no config edit):

```bash
node src/populate.js --template Telemetry test/sample-plan.json
```

The name matches the KADE page title (exact, else a unique substring); both its Tasks and Projects DBs are discovered from that page. Omit the flag to use the pair in `config.json`. You can also set `"template": "Telemetry"` in the plan JSON.

Or pipe JSON from your CLI session:

```bash
./scripts/populate-from-stdin.sh < test/sample-plan.json
```

### Run the poller daemon

```bash
./scripts/start-poller.sh
```

The poller watches for tasks with **Status = In Progress** and **Assigned = false**, then dispatches them to the configured provider CLI (highest priority first). On completion, status moves to **Done** (success) or back to **Not Started** (failure), per `config.json`. If the poller crashes mid-run, stale tasks are automatically reclaimed and re-dispatched after the lease timeout.

### Autonomous follow-ups

A dispatched agent isn't limited to its own run. Every prompt carries a short KADE preamble teaching the agent the `<task-plan>` format; if the work decomposes, the agent ends its output with a plan block, and the poller writes it back into the **same template**:

- Top-level follow-ups become **subtasks of the finished task** and inherit its project (plus its provider/model unless the plan overrides).
- `blocked_by` / `related` wires the follow-ups together; blocked tasks wait until their blockers resolve.
- Follow-ups are created as **In Progress** (`auto_start`), so the loop continues with no one touching the board — the agent's graph of related tickets works itself to completion.
- Guardrails: ≤ `max_followups_per_run` tasks per plan, ≤ `max_tasks_per_project` per project, title+project dedup (a retried plan can't double-create), and project rollup — a project flips to **In Progress** when work starts and **Done** when its last open task finishes.

Set `orchestration.enabled: false` in `config.json` to turn the whole loop off (plain one-shot dispatch).

### Human decisions (In Review)

When an agent can't proceed without a choice only a human can make, it ends with a `<needs-decision>` block. KADE parks the ticket instead of marking it Done:

1. **Status** → **In Review**
2. The page body opens with a harness-style prompt (yellow callout + question + numbered options + how to answer) — the same content you'd see if Claude Code or OpenCode had paused for input
3. Agent narrative is written underneath as **Output** (context, not the ask)
4. A page comment notifies you of the question

**How to answer:**

1. Type your choice in the **Decision** property at the top of the page (recommended), *or* reply in a page comment
2. Set **Status** → **In Progress**

The poller resumes the **same provider session** with your answer (no re-run from scratch). Add a `Decision` rich-text property on the Tasks database if your template doesn't have one yet — without it, comments alone still work.

## Workflow

1. Ask your CLI agent to plan a task (see `AGENTS.md` for the JSON format)
2. Run `populate.js` with the output
3. Review tasks in Notion
4. Move tasks to **In Progress** when ready
5. Poller dispatches to the provider CLI
6. The agent finishes — and may schedule its own follow-up subtasks, which the poller picks up on the next tick
7. Review completed work; a project flips to **Done** when its last open task finishes

## Reliability

- **Transport** — every Notion call goes through one process-wide throttle (respects the ~3 req/s average) with exponential backoff on 429/5xx/network errors (`Retry-After` honored). A tick that throws is logged, never fatal; ticks never overlap.
- **Crash recovery** — a task stuck `In Progress + Assigned` past its lease (provider timeout + 5 min) is reset and re-dispatched. `SIGINT`/`SIGTERM` stops the daemon and kills the whole agent process trees.
- **Agents** — stdout/stderr capture is capped (tail kept) so a runaway agent can't OOM the daemon; timeouts SIGTERM then SIGKILL the entire process group.
- **Idempotency** — populate dedups by title+project (tasks and subtasks); relation writes are batched and merged, never clobbering existing blockers.
- **Output hygiene** — each run replaces the prior "Output"/"Error output" section instead of piling them up, and output is capped before writing to Notion.

## Configuration

| Key | Purpose |
|---|---|
| `poll.interval_seconds` / `max_concurrent` / `api_delay_ms` | Tick cadence, parallel agent cap, Notion throttle |
| `poll.discover` / `discover_ttl_seconds` | Watch every shared template; how often to re-scan |
| `orchestration.enabled` / `preamble` | Master switch for the follow-up loop / prompt preamble |
| `orchestration.auto_start` | Create follow-ups as In Progress (else Not Started) |
| `orchestration.max_followups_per_run` / `max_tasks_per_project` | Token-spend guardrails |
| `orchestration.project_rollup` | Project status tracks its tasks |
| `output.max_capture_bytes` / `notion_max_chars` | Agent capture cap / Notion write-back cap |

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
| Decision | Human answer when a task is parked **In Review** (optional; comments work without it) |

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
3. Share the databases with your integration — or, once, share the **parent page** that holds every template: Notion access inherits to child pages, so duplicates land pre-shared and you never revisit integration settings.

Populate that template with `--template <page name>` (above); the poller finds it automatically.

The poller **auto-discovers** every KADE "Tasks" database shared with the integration (one poller watches them all) and clones each repo on first run. Set `poll.discover: false` in `config.json` to watch only the configured DB.

**Export / move machines:** nothing machine-specific lives in Notion — duplicate or share the page anywhere; the new machine only needs its own `repos_root`.

## Project structure

```
kade/
├── config.json          # Database IDs, poll/orchestration settings, provider adapters
├── src/
│   ├── populate.js      # JSON → Notion pages (CLI + reusable applyPlan)
│   ├── poller.js        # Watches, dispatches, schedules follow-ups
│   ├── providers.js     # CLI spawn logic (caps, timeouts, process groups)
│   ├── notion-client.js # Notion API wrapper (throttle + retry + pagination)
│   └── updater.js       # Post-completion updates
├── lib/
│   ├── plan.js          # Plan parsing, follow-up extraction, relation batching
│   ├── schema.js        # Property name mappings
│   ├── models.js        # Provider/model catalog
│   ├── repo.js          # Repo URL/path → working directory
│   ├── output.js        # ANSI strip + Notion-size chunking
│   └── logger.js
└── scripts/
    ├── populate-from-stdin.sh
    └── start-poller.sh
```
