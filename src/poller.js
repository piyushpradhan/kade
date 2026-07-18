const {
  queryInProgressUnassigned,
  discoverTemplates,
  reclaimStale,
  validateSchema,
  getTaskDescription,
  markAssigned,
  markComplete,
  markNeedsDecision,
  hasPendingDecision,
  wasCompleted,
  getDecisionReply,
  getBlockerIds,
  getPageStatusName,
  getTaskTitle,
  getTaskProvider,
  getTaskModel,
  getResolvedModel,
  getTaskRepository,
  getTaskProjectDir,
  getDataSourceRepo,
  getRepositoryDefaultLocation,
  countProjectTasks,
  hasOpenProjectTasks,
  setProjectStatus,
  mapStatus,
  PROPERTIES,
} = require("./notion-client");
const { spawnAgent, killAllChildren } = require("./providers");
const { applyPlan } = require("./populate");
const { resolveWorkingDir, isRepoName } = require("../lib/repo");
const {
  extractPlan,
  extractDecision,
  resumePreamble,
  sanitizeTasks,
  orchestrationPreamble,
} = require("../lib/plan");
const { stripAnsi } = require("../lib/output");
const config = require("../config.json");
const logger = require("../lib/logger");

require("dotenv").config();

const activeJobs = new Set();

// --- Orchestration knobs ----------------------------------------------------
const ORCH = config.orchestration || {};
const ORCH_ENABLED = ORCH.enabled !== false;
const ORCH_PREAMBLE = ORCH.preamble !== false;
const AUTO_START = ORCH.auto_start !== false;
const MAX_FOLLOWUPS = ORCH.max_followups_per_run || 20;
const MAX_PROJECT_TASKS = ORCH.max_tasks_per_project || 50;
const PROJECT_ROLLUP = ORCH.project_rollup !== false;

// Statuses that count as "resolved" for blocker purposes.
const RESOLVED = new Set([mapStatus("done"), mapStatus("archived")]);

function shortId(id) {
  return String(id || "").replace(/-/g, "").slice(0, 8);
}

function taskProjectId(task) {
  return task.properties?.[PROPERTIES.project]?.relation?.[0]?.id || null;
}

// --- Template discovery (cached) --------------------------------------------
// A search per tick is wasteful; templates change rarely. Refresh on a TTL and
// keep the last good list on failure.
let templatesCache = { at: 0, list: [] };

async function getTemplates(force = false) {
  const ttlMs = (config.poll.discover_ttl_seconds ?? 300) * 1000;
  if (!force && Date.now() - templatesCache.at < ttlMs) return templatesCache.list;
  try {
    const list = await discoverTemplates();
    templatesCache = { at: Date.now(), list };
  } catch (err) {
    logger.warn(`[poller] template discovery failed (${err.message}); keeping previous list (${templatesCache.list.length} template(s))`);
  }
  return templatesCache.list;
}

// Every KADE Tasks DB this poller should watch: the configured one plus any
// other templates shared with the integration (deduped).
async function getTargetDatabases() {
  const dbs = new Set([config.notion.tasks_database_id]);
  if (config.poll.discover !== false) {
    for (const t of await getTemplates()) dbs.add(t.tasksDbId);
  }
  return [...dbs];
}

// --- Follow-up orchestration --------------------------------------------------
// A successful agent may end its output with a <task-plan> block. Those tasks
// are written back into the SAME template: top-level ones become subtasks of
// the finished task, wired with blocked_by/related, and auto-started so the
// workflow continues without anyone touching the board.
async function applyFollowUps(task, ctx) {
  const tag = ctx.tag;
  const plan = extractPlan(ctx.stdout);
  if (!plan) return;

  const tasks = sanitizeTasks(plan.tasks, { maxTasks: MAX_FOLLOWUPS });
  if (tasks.length === 0) {
    logger.warn(`[poller] [${tag}] follow-up plan had no usable tasks (max ${MAX_FOLLOWUPS}); ignoring`);
    return;
  }

  const dbId = task.parent?.database_id;
  const templates = await getTemplates();
  const tpl = templates.find((t) => t.tasksDbId === dbId);
  const projectId = taskProjectId(task);

  if (projectId) {
    const count = await countProjectTasks(projectId, dbId, MAX_PROJECT_TASKS + 1);
    if (count >= MAX_PROJECT_TASKS) {
      logger.warn(
        `[poller] [${tag}] project already has ${count} task(s) (cap ${MAX_PROJECT_TASKS}) — refusing to add ${tasks.length} follow-up(s)`
      );
      return;
    }
  }

  const result = await applyPlan(
    { ...plan, tasks },
    {
      parentTaskId: task.id,
      projectId,
      defaultStatus: AUTO_START ? "in_progress" : "todo",
      defaults: { provider: ctx.provider, model: ctx.model },
      tasksDbId: dbId,
      projectsDbId: tpl?.projectsDbId,
    }
  );
  logger.info(
    `[poller] [${tag}] follow-ups: created ${result.created.length}, skipped ${result.skipped.length} existing (auto-start: ${AUTO_START})`
  );
}

// --- Project rollup -----------------------------------------------------------
// Keep the board coherent: a project goes In Progress when one of its tasks
// starts, and Done when its last open task finishes.
async function rollupProject(task, phase) {
  if (!PROJECT_ROLLUP) return;
  const projectId = taskProjectId(task);
  const dbId = task.parent?.database_id;
  if (!projectId || !dbId) return;
  try {
    if (phase === "started") {
      await setProjectStatus(projectId, "in_progress");
    } else if (!(await hasOpenProjectTasks(projectId, dbId))) {
      await setProjectStatus(projectId, "done");
      logger.info(`[poller] project ${shortId(projectId)} has no open tasks → Done`);
    }
  } catch (err) {
    logger.warn(`[poller] project rollup failed (${err.message})`);
  }
}

// --- Dispatch -------------------------------------------------------------------
async function dispatchTask(task) {
  const tag = shortId(task.id);
  const title = getTaskTitle(task);
  const provider = getTaskProvider(task);
  const model = getResolvedModel(task);
  const requestedModel = getTaskModel(task);

  logger.info(`[poller] [${tag}] picked up task "${title}"`);

  if (requestedModel && requestedModel !== model) {
    logger.warn(
      `[poller] [${tag}] requested model "${requestedModel}" not in catalog for ${provider}; falling back to "${model}"`
    );
  }

  logger.info(
    `[poller] [${tag}] resolved provider=${provider} model=${model || "default"}`
  );

  // Resume path: a previously-run task that parked on a <needs-decision> and was
  // moved back to In Progress. Its page id is the provider session id, so we
  // resume that conversation with just the human's answer instead of re-running.
  const resuming = wasCompleted(task) && (await hasPendingDecision(task.id));
  let prompt;
  let source;
  if (resuming) {
    const decision = await getDecisionReply(task.id);
    prompt = resumePreamble(decision);
    source = `resume (decision ${decision ? `${decision.length} chars` : "none given"})`;
  } else {
    logger.info(`[poller] [${tag}] fetching task description from Notion`);
    const description = await getTaskDescription(task.id);
    const body = description || title;
    prompt =
      ORCH_ENABLED && ORCH_PREAMBLE
        ? `${orchestrationPreamble({ maxTasks: MAX_FOLLOWUPS })}\n${body}`
        : body;
    source = `${description ? "description" : "title"}${ORCH_ENABLED && ORCH_PREAMBLE ? ", with orchestration preamble" : ""}`;
  }
  logger.info(`[poller] [${tag}] prompt ready (${prompt.length} chars, source: ${source})`);

  logger.info(`[poller] [${tag}] marking task Assigned + recording Started At`);
  await markAssigned(task.id);
  activeJobs.add(task.id);
  rollupProject(task, "started");

  logger.info(`[poller] [${tag}] handing off to dispatcher`);

  try {
    // Working dir: Project Directory (local, used as-is) → Repository (GitHub
    // URL, cloned) → the task's template default (DB description) → lookup
    // through the Repositories database if the value is a bare name → the
    // machine default in config.
    const dbId = task.parent?.database_id;
    const reposDbId = config.notion.repositories_database_id;
    let templateRepo = dbId ? await getDataSourceRepo(dbId) : null;
    let repository = getTaskRepository(task);

    // Resolve bare names through the Repositories database: when the Repository
    // URL or template default is not a URL and not a path, it may be a page
    // name in the Repositories DB whose "Default Location" holds the real URL
    // or path. Only runs when the DB is configured.
    if (reposDbId) {
      if (repository && isRepoName(repository)) {
        const resolved = await getRepositoryDefaultLocation(repository, reposDbId);
        if (resolved) {
          logger.info(`[poller] [${tag}] Repository "${repository}" → Default Location "${resolved}"`);
          repository = resolved;
        }
      }
      if (templateRepo && isRepoName(templateRepo)) {
        const resolved = await getRepositoryDefaultLocation(templateRepo, reposDbId);
        if (resolved) {
          logger.info(`[poller] [${tag}] template repo "${templateRepo}" → Default Location "${resolved}"`);
          templateRepo = resolved;
        }
      }
    }

    const cwd = resolveWorkingDir(
      {
        projectDir: getTaskProjectDir(task),
        repository,
        templateRepo,
      },
      config.repos_root,
      config.repo.path
    );
    logger.info(`[poller] [${tag}] working directory: ${cwd}`);
    const { exitCode, stdout, stderr } = await spawnAgent(
      provider,
      prompt,
      cwd,
      model,
      tag,
      { sessionId: task.id, resume: resuming }
    );
    logger.info(
      `[poller] [${tag}] dispatcher returned exit=${exitCode} (stdout ${stdout.length}B, stderr ${stderr.length}B)`
    );

    // A successful run that ends with <needs-decision> parks for a human instead
    // of completing: move to Review, keep the ticket open, no follow-ups yet.
    const decision = exitCode === 0 ? extractDecision(stripAnsi(stdout)) : null;
    if (decision) {
      logger.info(`[poller] [${tag}] agent needs a decision — parking → ${config.notion.review_status || "In Review"}`);
      await markNeedsDecision(task.id, decision, stdout);
      return;
    }

    logger.info(`[poller] [${tag}] updating Notion (status, timestamps, output)`);
    await markComplete(task.id, exitCode, stdout, stderr);
    logger.info(
      `[poller] [${tag}] done → ${exitCode === 0 ? config.notion.success_status || "Review" : config.notion.failure_status || "Not Started"}`
    );

    if (exitCode === 0 && ORCH_ENABLED) {
      try {
        await applyFollowUps(task, { tag, provider, model, stdout: stripAnsi(stdout) });
      } catch (err) {
        // Follow-up creation must never fail the (already completed) task.
        logger.error(`[poller] [${tag}] follow-up plan failed: ${err.message}`);
      }
    }
    await rollupProject(task, "finished");
  } catch (err) {
    logger.error(`[poller] [${tag}] dispatch error: ${err.message}`);
    logger.info(`[poller] [${tag}] recording failure in Notion`);
    try {
      await markComplete(task.id, 1, "", err.message);
    } catch (err2) {
      // Nothing more we can do — the lease will reclaim the task later.
      logger.error(`[poller] [${tag}] could not record failure in Notion: ${err2.message}`);
    }
    await rollupProject(task, "finished");
  } finally {
    activeJobs.delete(task.id);
    logger.info(`[poller] [${tag}] released from active jobs (${activeJobs.size} active)`);
  }
}

// --- Tick -----------------------------------------------------------------------
async function tickOnce() {
  const targetDbs = await getTargetDatabases();

  // P1: self-heal crash-stranded tasks before dispatching new ones. One bad DB
  // must not take down the whole tick.
  let reclaimed = 0;
  for (const db of targetDbs) {
    try {
      reclaimed += (await reclaimStale(activeJobs, db)).length;
    } catch (err) {
      logger.error(`[poller] reclaim failed for DB ${shortId(db)}: ${err.message}`);
    }
  }
  if (reclaimed) {
    logger.info(`[poller] reclaimed ${reclaimed} stale task(s) for re-dispatch`);
  }

  if (activeJobs.size >= config.poll.max_concurrent) {
    logger.info(
      `[poller] Max concurrency reached (${activeJobs.size}), skipping`
    );
    return;
  }

  const tasks = [];
  for (const db of targetDbs) {
    try {
      tasks.push(...(await queryInProgressUnassigned(db)));
    } catch (err) {
      logger.error(`[poller] query failed for DB ${shortId(db)}: ${err.message}`);
    }
  }

  // Higher-priority tasks dispatch first when several are waiting.
  const rank = { Urgent: 0, High: 1, Medium: 2, Low: 3 };
  const prio = (t) => rank[t.properties?.[PROPERTIES.priority]?.select?.name] ?? 2;
  tasks.sort((a, b) => prio(a) - prio(b));

  logger.info(
    `[poller] tick: ${tasks.length} In-Progress + unassigned task(s) across ${targetDbs.length} template(s), ${activeJobs.size} active job(s)`
  );

  // Blocker statuses are cached for the tick — several tasks commonly share
  // the same blockers, and blocker state won't change mid-tick meaningfully.
  const statusCache = new Map();
  const statusOf = async (pageId) => {
    if (!statusCache.has(pageId)) statusCache.set(pageId, await getPageStatusName(pageId));
    return statusCache.get(pageId);
  };

  for (const task of tasks) {
    if (activeJobs.size >= config.poll.max_concurrent) {
      logger.info(`[poller] concurrency cap hit, deferring remaining tasks`);
      break;
    }

    // P5: skip anything already claimed by an overlapping dispatch.
    if (activeJobs.has(task.id)) continue;

    const tag = shortId(task.id);
    const title = getTaskTitle(task);
    const blockerIds = getBlockerIds(task);

    if (blockerIds.length > 0) {
      logger.info(`[poller] [${tag}] checking ${blockerIds.length} blocker(s) for "${title}"`);
      let unresolved = 0;
      for (const id of blockerIds) {
        if (!RESOLVED.has(await statusOf(id))) unresolved++;
      }
      if (unresolved > 0) {
        logger.info(
          `[poller] [${tag}] blocked by ${unresolved} unresolved task(s), skipping`
        );
        continue;
      }
      logger.info(`[poller] [${tag}] all ${blockerIds.length} blocker(s) done, proceeding`);
    }

    // P5: claim synchronously before the non-awaited dispatch to close the window.
    // The finally releases the claim even if dispatch throws before its own
    // try/finally (e.g. description fetch fails) — a leaked claim would block
    // re-dispatch and lease reclaim for the process's lifetime.
    activeJobs.add(task.id);
    dispatchTask(task)
      .catch((err) =>
        logger.error(`[poller] [${tag}] unhandled dispatch failure: ${err.message}`)
      )
      .finally(() => activeJobs.delete(task.id));
  }
}

// A slow tick must never overlap the next one, and a failed tick must never
// kill the daemon.
let ticking = false;
async function tick() {
  if (ticking) {
    logger.warn(`[poller] previous tick still running, skipping this interval`);
    return;
  }
  ticking = true;
  try {
    await tickOnce();
  } catch (err) {
    logger.error(`[poller] tick failed: ${err.message}`);
  } finally {
    ticking = false;
  }
}

// --- Lifecycle --------------------------------------------------------------------
let timer = null;
let shuttingDown = false;

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.warn(
    `[poller] ${signal} received — shutting down (${activeJobs.size} job(s) in flight; expired leases will reclaim them on next start)`
  );
  if (timer) clearInterval(timer);
  killAllChildren("SIGTERM");
  setTimeout(() => process.exit(0), 500).unref?.();
}

async function start() {
  try {
    await validateSchema();
  } catch (err) {
    logger.error(err.message);
    process.exit(1);
  }
  logger.info(
    `[poller] Starting daemon. Poll interval: ${config.poll.interval_seconds}s, max concurrent: ${config.poll.max_concurrent}, orchestration: ${ORCH_ENABLED ? "on" : "off"}`
  );
  tick();
  timer = setInterval(tick, config.poll.interval_seconds * 1000);
}

if (require.main === module) {
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("unhandledRejection", (err) =>
    logger.error(`[poller] unhandled rejection: ${err?.stack || err}`)
  );
  start();
}

module.exports = { tick, start, dispatchTask };
