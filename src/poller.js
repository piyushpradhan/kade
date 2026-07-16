const {
  queryInProgressUnassigned,
  reclaimStale,
  validateSchema,
  getTaskDescription,
  markAssigned,
  markComplete,
  getBlockedByTasks,
  getTaskTitle,
  getTaskProvider,
  getTaskModel,
  getResolvedModel,
  mapStatus,
} = require("./notion-client");
const { spawnAgent } = require("./providers");
const config = require("../config.json");
const logger = require("../lib/logger");

require("dotenv").config();

const activeJobs = new Set();

function shortId(id) {
  return String(id || "").replace(/-/g, "").slice(0, 8);
}

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

  logger.info(`[poller] [${tag}] fetching task description from Notion`);
  const description = await getTaskDescription(task.id);
  const prompt = description || title;
  logger.info(
    `[poller] [${tag}] prompt ready (${prompt.length} chars, source: ${description ? "description" : "title"})`
  );

  logger.info(`[poller] [${tag}] marking task Assigned + recording Started At`);
  await markAssigned(task.id);
  activeJobs.add(task.id);

  logger.info(`[poller] [${tag}] handing off to dispatcher`);

  try {
    const { exitCode, stdout, stderr } = await spawnAgent(
      provider,
      prompt,
      config.repo.path,
      model,
      tag
    );
    logger.info(
      `[poller] [${tag}] dispatcher returned exit=${exitCode} (stdout ${stdout.length}B, stderr ${stderr.length}B)`
    );
    logger.info(`[poller] [${tag}] updating Notion (status, timestamps, output)`);
    await markComplete(task.id, exitCode, stdout, stderr);
    logger.info(
      `[poller] [${tag}] done → ${exitCode === 0 ? config.notion.success_status || "Review" : config.notion.failure_status || "Not Started"}`
    );
  } catch (err) {
    logger.error(`[poller] [${tag}] dispatch error: ${err.message}`);
    logger.info(`[poller] [${tag}] recording failure in Notion`);
    await markComplete(task.id, 1, "", err.message);
  } finally {
    activeJobs.delete(task.id);
    logger.info(`[poller] [${tag}] released from active jobs (${activeJobs.size} active)`);
  }
}

async function tick() {
  // P1: self-heal crash-stranded tasks before dispatching new ones.
  const reclaimed = await reclaimStale(activeJobs);
  if (reclaimed.length) {
    logger.info(`[poller] reclaimed ${reclaimed.length} stale task(s) for re-dispatch`);
  }

  if (activeJobs.size >= config.poll.max_concurrent) {
    logger.info(
      `[poller] Max concurrency reached (${activeJobs.size}), skipping`
    );
    return;
  }

  const tasks = await queryInProgressUnassigned();
  logger.info(
    `[poller] tick: ${tasks.length} In-Progress + unassigned task(s) found, ${activeJobs.size} active job(s)`
  );

  for (const task of tasks) {
    if (activeJobs.size >= config.poll.max_concurrent) {
      logger.info(`[poller] concurrency cap hit, deferring remaining tasks`);
      break;
    }

    // P5: skip anything already claimed by an overlapping tick.
    if (activeJobs.has(task.id)) continue;

    const tag = shortId(task.id);
    const title = getTaskTitle(task);
    logger.info(`[poller] [${tag}] checking blockers for "${title}"`);

    const blockers = await getBlockedByTasks(task.id);
    const unresolved = blockers.filter(
      (b) => b.status !== mapStatus("done")
    );
    if (unresolved.length > 0) {
      logger.info(
        `[poller] [${tag}] blocked by ${unresolved.length} unresolved task(s), skipping`
      );
      continue;
    }

    if (blockers.length > 0) {
      logger.info(`[poller] [${tag}] all ${blockers.length} blocker(s) done, proceeding`);
    }
    // P5: claim synchronously before the non-awaited spawn to close the window.
    activeJobs.add(task.id);
    dispatchTask(task);
  }
}

async function start() {
  try {
    await validateSchema();
  } catch (err) {
    logger.error(err.message);
    process.exit(1);
  }
  logger.info(
    `[poller] Starting daemon. Poll interval: ${config.poll.interval_seconds}s, max concurrent: ${config.poll.max_concurrent}`
  );
  tick();
  setInterval(tick, config.poll.interval_seconds * 1000);
}

if (require.main === module) {
  start();
}

module.exports = { tick, start, dispatchTask };
