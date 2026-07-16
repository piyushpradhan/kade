# Notion sync: reliability plan

## TL;DR

- **Cheaper?** No — and nothing to do. The current design already uses the official REST SDK
  directly (`@notionhq/client`), so Notion API calls cost **$0** and **zero LLM tokens**. That
  was the whole point of KADE and it works. There is no cheaper transport to switch to.
- **More reliable?** Yes — but with ~5 small patches, **not** a rewrite. Polling + REST is the
  right shape for a *local* daemon dispatching to *local* CLIs. Push/webhooks would add moving
  parts and network dependencies for no cost saving (see "Alternatives rejected").
- **Do not rewrite the transport.** Spend the effort on crash recovery and schema validation.

The real risk today is not cost or throughput — it's that a crash silently strands in-flight
tasks and that the code's schema assumptions drift from the live template with no guardrail.

---

## What the setup does today

- `src/populate.js` — plan JSON → Notion pages (project, tasks, subtasks, relations). Free, no tokens.
- `src/poller.js` — 30s `setInterval` polling `databases.query` for
  `Status = In Progress AND Assigned = false`, checks blockers, marks `Assigned`, reads the page
  body as the prompt, spawns the provider CLI, writes stdout/stderr back and sets final status.
- `lib/schema.js` / `lib/models.js` — hardcoded property names + option lists that must match
  the live Notion template exactly.

---

## Cost reality check

| Concern | Status |
|---|---|
| LLM tokens on DB reads/writes | **Already zero** — direct REST, no MCP/AI in the loop |
| Notion API dollar cost | **Free** — no per-request billing on any plan |
| Polling compute | Negligible (a few requests / 30s) |
| Notion rate limit (~3 req/s avg) | Not hit — `api_delay_ms: 350` self-throttles |

Conclusion: "cheaper" is a solved problem. Skip it. All value is in reliability/robustness.

---

## Reliability gaps found (ranked)

### P1 — Crash strands in-flight tasks forever (highest leverage)
`markAssigned` sets `Assigned = true` *before* spawning (`src/notion-client.js:216`), and only
`markComplete` ever resets it (`:287`). If the poller is killed / crashes / the box reboots
mid-run, the task stays `In Progress + Assigned = true` and is filtered out of every future tick
(`queryInProgressUnassigned`, `:177`). It is silently stuck with no recovery path.

**Fix:** lease reclaim. On startup (and once per tick), find tasks with
`Status = In Progress AND Assigned = true AND Started At < now - LEASE_TIMEOUT` that aren't in the
in-process `activeJobs` set, and reset `Assigned = false` so they re-dispatch. `Started At` is
already recorded, so no schema change. ~15 lines in `notion-client.js` + one call in `poller.tick`.

```
LEASE_TIMEOUT ≈ max(provider.timeout_seconds) + margin  (e.g. 15 min)
reclaimStale(): query In Progress + Assigned=true, filter by Started At age & not-active, set Assigned=false
```

### P2 — No startup schema validation (silent drift)
Property names and option names are hardcoded in two files and must match the template exactly.
They already drifted: `lib/schema.js:32,34` map `review → "Review"` and `blocked → "Blocked"`, but
the **live Tasks template has neither status** (only `Not Started, In Progress, Done, Archived`).
It only works today because `config.json` overrides `success_status: "Done"` — the `mapStatus("review")`
fallback at `notion-client.js:22` points at a non-existent option. Any future path that emits those
values throws an opaque Notion 400 mid-run.

**Fix:** fail fast. On poller startup, `databases.retrieve` (one call, free) and assert that every
property KADE writes exists and that the `Status`/`Priority`/`Provider`/`Model` option names it can
emit are present. Print a clear diff and exit non-zero if not. ~30 lines, runs once. This also
replaces the README's brittle "manually add Review/Blocked" step — those statuses aren't used.

### P3 — Phantom statuses + Projects priority mismatch
- Remove `review`/`blocked` from `STATUS` in `lib/schema.js` (dead + invalid), or add them to the
  template. Pick one; don't leave the mapping pointing at options that don't exist.
- Projects `Priority` has only `Low/Medium/High` (no `Urgent`), but `mapPriority` can emit `Urgent`
  (`schema.js:47`). `createProject` defaults to `medium` so it's latent, but clamp Project priority
  to the three valid options to avoid a 400 if a plan ever sets an urgent project.

### P4 — `populate.js` is not idempotent
Re-running a plan re-creates every task (`src/populate.js:45`). Projects dedupe by name
(`getOrCreateProject`), tasks never do — a half-failed run doubles rows on retry.

**Fix:** before `createTask`, query the Tasks DB for an existing page with the same
`Project + Task name` and skip/update if found. ~10 lines. (Cheaper alternative if titles aren't
unique: write the plan's stable `id` into `Error Log` or a dedicated text prop and filter on it.)

### P5 — Claim window allows rare double-dispatch
`tick` fires `dispatchTask(task)` without awaiting (`src/poller.js:120`); `activeJobs` is only
updated *inside* `dispatchTask` after `await markAssigned`. Two overlapping ticks (or a slow
`markAssigned`) could pick the same task twice. Cross-tick is guarded by the `Assigned` flag, so
the real-world risk is low, but it exists.

**Fix (lazy):** `await markAssigned` and add `task.id` to `activeJobs` *synchronously* before the
non-awaited spawn, and skip any task already in `activeJobs` at the top of the loop. No new
infra — just move the claim before the async gap.

---

## Optional (only if it ever hurts)

- **Blocker check is O(tasks × blockers) retrieves per tick** (`notion-client.js:315`). Fine at
  current scale. If task volume grows, cache blocker statuses within a tick, or query the whole DB
  once per tick and resolve blockers in memory instead of per-relation `pages.retrieve`.

---

## Alternatives considered and rejected

**Notion webhooks (push instead of poll).** Notion supports integration webhooks now. Rejected:
it needs a public HTTPS endpoint (tunnel or hosted server) for a daemon that otherwise talks only
to localhost CLIs, plus a verification handshake and missed-event reconciliation — which means
you keep the poller anyway as a safety net. More parts, not cheaper (polling is already free), and
30s latency is a non-issue for "I moved a card, an agent picks it up."

**Notion SQL / data-source query via MCP.** The template exposes SQLite tables, but that path runs
through the AI/MCP layer (costs tokens, needs Business+). It reintroduces exactly the token cost
KADE was built to avoid. Rejected.

**Local queue (SQLite/file) as source of truth, Notion as mirror.** More durable and fewer API
calls, but Notion *is* the human UI — the user drives state by dragging cards to "In Progress".
Can't demote it. The only local durability worth adding is the in-flight lease in P1, nothing more.

**Replace `@notionhq/client`.** It's the official SDK, already installed, and does the job. No
cheaper dependency exists. Keep it.

---

## Suggested order

1. **P1** lease reclaim — turns silent-stuck into self-healing. Biggest win, ~15 lines.
2. **P2** startup schema check — catches drift before it corrupts a run, ~30 lines.
3. **P3** fix phantom statuses / project priority — a few lines, removes latent 400s.
4. **P4** idempotent populate — safe retries.
5. **P5** move the claim before the spawn — closes the double-dispatch window.

Net: no new dependencies, no new services, no transport change. ~5 targeted edits across
`notion-client.js`, `poller.js`, `schema.js`, and `populate.js`, plus deleting the README's
obsolete "add Review/Blocked status" instructions.
