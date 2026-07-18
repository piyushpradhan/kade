const {
  createTask,
  createSubtask,
  mergeRelations,
  getOrCreateProject,
  findTaskByTitleAndProject,
  setTemplateRepo,
  resolveTemplate,
  useTemplate,
} = require("./notion-client");
const { PROPERTIES } = require("../lib/schema");
const { parsePlan, relationWrites } = require("../lib/plan");
const logger = require("../lib/logger");

// argv: [--template <name>] [plan.json]. Flag picks which discovered template
// (parent-page name) to write to; the positional is the plan file (else stdin).
function parseArgs(argv = process.argv.slice(2)) {
  const out = { template: null, file: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--template") out.template = argv[++i];
    else out.file = argv[i];
  }
  return out;
}

async function readInput(file) {
  if (file) {
    return require("fs").readFileSync(file, "utf8");
  }
  return new Promise((resolve) => {
    let data = "";
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
  });
}

// Write a plan into Notion. Shared by the CLI (human plans) and the poller
// (agent follow-up plans). Options:
//   parentTaskId  — make top-level plan tasks subtasks of this page (follow-ups)
//   projectId     — skip project lookup, attach tasks to this project
//   defaultStatus — "todo" for CLI, "in_progress" to auto-dispatch follow-ups
//   defaults      — { provider, model } inherited by tasks that don't specify
//   tasksDbId / projectsDbId — explicit target DBs (else the process globals)
async function applyPlan(plan, {
  parentTaskId = null,
  projectId = null,
  defaultStatus = "todo",
  defaults = {},
  tasksDbId,
  projectsDbId,
} = {}) {
  if (!plan.tasks || !Array.isArray(plan.tasks)) {
    throw new Error("Invalid plan: expected a 'tasks' array");
  }

  let pid = projectId;
  if (!pid && plan.project) {
    pid = await getOrCreateProject(plan.project, plan.goal, projectsDbId);
    logger.info(`Project: ${plan.project} (${pid})`);
  }

  // The repo is a template-level property: set it once in the Tasks DB, not on
  // every task. A task's own `repo` is the rare per-task override.
  if (plan.repo) {
    await setTemplateRepo(plan.repo, tasksDbId);
    logger.info(`Template repo → ${plan.repo}`);
  }

  const idMap = {};
  const created = [];
  const skipped = [];

  const taskData = (t, inheritedRepo) => ({
    title: t.title,
    description: t.description,
    status: t.status || defaultStatus,
    provider: t.provider || defaults.provider,
    model: t.model || defaults.model,
    priority: t.priority,
    projectId: pid,
    tags: t.tags,
    repository: t.repo || inheritedRepo,
    projectDir: t.project_dir,
  });

  for (const task of plan.tasks) {
    const existing = await findTaskByTitleAndProject(task.title, pid, tasksDbId);
    if (existing) {
      idMap[task.id] = existing;
      skipped.push(task.title);
      logger.info(`Skipped (exists): ${task.title} (${existing})`);
      continue;
    }
    const pageId = parentTaskId
      ? await createSubtask(parentTaskId, taskData(task), tasksDbId)
      : await createTask(taskData(task), tasksDbId);
    idMap[task.id] = pageId;
    created.push(task.title);
    logger.info(`Created: ${task.title} (${pageId})`);
  }

  for (const task of plan.tasks) {
    if (!task.subtasks || !idMap[task.id]) continue;
    for (const subtask of task.subtasks) {
      const existing = await findTaskByTitleAndProject(subtask.title, pid, tasksDbId);
      if (existing) {
        idMap[subtask.id] = existing;
        skipped.push(subtask.title);
        logger.info(`  Skipped (exists): ${subtask.title} (${existing})`);
        continue;
      }
      const pageId = await createSubtask(idMap[task.id], taskData(subtask, task.repo), tasksDbId);
      idMap[subtask.id] = pageId;
      created.push(subtask.title);
      logger.info(`  Subtask: ${subtask.title} (${pageId})`);
    }
  }

  // Batched, merge-based relation writes: one read+write per (task, property),
  // unioned with whatever is already there — never clobbers sibling blockers.
  const allTasks = plan.tasks.flatMap((t) => [t, ...(t.subtasks || [])]);
  const writes = relationWrites(allTasks, idMap, {
    blockedByProp: PROPERTIES.blockedBy,
    relatedToProp: PROPERTIES.relatedTo,
  });
  for (const w of writes) {
    await mergeRelations(w.pageId, w.property, w.ids);
    logger.info(`  Linked ${w.property}: ${w.ids.length} relation(s) on ${w.pageId}`);
  }

  logger.info(`Done. Created ${created.length}, skipped ${skipped.length} existing.`);
  return { projectId: pid, idMap, created, skipped };
}

async function main() {
  const args = parseArgs();
  const input = await readInput(args.file);
  const plan = parsePlan(input);

  if (!plan.tasks || !Array.isArray(plan.tasks)) {
    throw new Error("Invalid plan: expected a 'tasks' array");
  }

  // Retarget at a specific template (flag wins over plan.template); default is
  // the DB pair in config.json.
  const templateName = args.template || plan.template;
  if (templateName) {
    const t = await resolveTemplate(templateName);
    useTemplate(t);
    logger.info(`Template: ${t.name} → tasks ${t.tasksDbId}, projects ${t.projectsDbId}`);
  }

  await applyPlan(plan);
}

if (require.main === module) {
  main().catch((err) => {
    logger.error(err.message);
    process.exit(1);
  });
}

module.exports = { applyPlan, parseArgs, parsePlan };
