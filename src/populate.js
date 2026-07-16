const {
  createTask,
  createSubtask,
  createRelation,
  getOrCreateProject,
  findTaskByTitleAndProject,
} = require("./notion-client");
const { PROPERTIES } = require("../lib/schema");
const logger = require("../lib/logger");

async function readInput() {
  if (process.argv[2]) {
    return require("fs").readFileSync(process.argv[2], "utf8");
  }
  return new Promise((resolve) => {
    let data = "";
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
  });
}

function parsePlan(raw) {
  const match = raw.match(/<task-plan>([\s\S]*?)<\/task-plan>/);
  const json = match ? match[1].trim() : raw.trim();
  return JSON.parse(json);
}

async function main() {
  const input = await readInput();
  const plan = parsePlan(input);

  if (!plan.tasks || !Array.isArray(plan.tasks)) {
    throw new Error("Invalid plan: expected a 'tasks' array");
  }

  let projectId = null;
  if (plan.project) {
    projectId = await getOrCreateProject(plan.project, plan.goal);
    logger.info(`Project: ${plan.project} (${projectId})`);
  }

  const idMap = {};

  for (const task of plan.tasks) {
    const existing = await findTaskByTitleAndProject(task.title, projectId);
    if (existing) {
      idMap[task.id] = existing;
      logger.info(`Skipped (exists): ${task.title} (${existing})`);
      continue;
    }
    const pageId = await createTask({
      title: task.title,
      description: task.description,
      status: "todo",
      provider: task.provider,
      model: task.model,
      priority: task.priority,
      projectId,
      tags: task.tags,
    });
    idMap[task.id] = pageId;
    logger.info(`Created: ${task.title} (${pageId})`);
  }

  for (const task of plan.tasks) {
    if (!task.subtasks) continue;
    for (const subtask of task.subtasks) {
      const pageId = await createSubtask(idMap[task.id], {
        title: subtask.title,
        description: subtask.description,
        status: "todo",
        provider: subtask.provider,
        model: subtask.model,
        priority: subtask.priority,
        projectId,
        tags: subtask.tags,
      });
      idMap[subtask.id] = pageId;
      logger.info(`  Subtask: ${subtask.title} (${pageId})`);
    }
  }

  for (const task of plan.tasks) {
    if (task.blocked_by) {
      for (const blockerId of task.blocked_by) {
        if (idMap[blockerId]) {
          await createRelation(
            idMap[task.id],
            PROPERTIES.blockedBy,
            idMap[blockerId]
          );
          logger.info(`  ${task.id} blocked by ${blockerId}`);
        }
      }
    }
    if (task.related) {
      for (const relatedId of task.related) {
        if (idMap[relatedId]) {
          await createRelation(
            idMap[task.id],
            PROPERTIES.relatedTo,
            idMap[relatedId]
          );
        }
      }
    }
  }

  logger.info(`Done. Created ${Object.keys(idMap).length} tasks.`);
}

main().catch((err) => {
  logger.error(err.message);
  process.exit(1);
});
