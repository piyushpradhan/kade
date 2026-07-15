# KADE

Notion-driven AI task orchestration. Break prompts into structured tasks in Notion, then auto-dispatch them to provider CLIs (Claude, Codex, OpenCode, Grok, Gemini) with zero token cost on database operations.

## Setup

1. **Notion integration** — Create at [notion.so/my-integrations](https://www.notion.so/my-integrations) and copy the token.

2. **Share databases** — Open your [KADE setup](https://www.notion.so/KADE-setup-4317db1ae37b83d4bbd781dc769ef881) page and invite the integration to both **Projects** and **Tasks** databases.

3. **Add Status options** — In the Tasks database, edit the **Status** property and add:
   - `Review` (for completed tasks awaiting human review)
   - `Blocked` (optional, for blocked tasks)
   
   Also add `Urgent` to the **Priority** select if not present.

4. **Configure environment**:

```bash
cp .env.example .env
# Edit .env with your NOTION_TOKEN
npm install
```

5. **Edit `config.json`** — Set `repo.path` to the repository where agents should work.

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

The poller watches for tasks with **Status = In Progress** and **Assigned = false**, then dispatches them to the configured provider CLI. On completion, status moves to **Review** (success) or back to **Not Started** (failure).

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
| Assigned | Prevents double-dispatch |
| Blocked By / Related To | Task dependencies |
| Started At / Completed on | Timestamps |
| Exit Code / Error Log | Agent result tracking |

Database IDs are configured in `config.json`.

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
