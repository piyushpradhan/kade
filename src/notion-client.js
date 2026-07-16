require("dotenv").config();

const { Client } = require("@notionhq/client");
const config = require("../config.json");
const {
  PROPERTIES,
  PROJECT_PROPERTIES,
  mapStatus,
  mapPriority,
  mapProjectStatus,
  mapProjectPriority,
} = require("../lib/schema");
const { resolveModel, inferProvider } = require("../lib/models");
const { stripAnsi, chunkText } = require("../lib/output");
const logger = require("../lib/logger");

const notion = new Client({
  auth: process.env[config.notion.token_env],
});

const TASKS_DB = config.notion.tasks_database_id;
const PROJECTS_DB = config.notion.projects_database_id;
const SUCCESS_STATUS = config.notion.success_status || mapStatus("done");
const FAILURE_STATUS = config.notion.failure_status || mapStatus("todo");
const OUTPUT_MARKERS = new Set(["Output", "Error output"]);

// A task Assigned longer than this with no live job is presumed crash-stranded.
const LEASE_TIMEOUT_MS =
  (config.poll.lease_timeout_seconds ||
    Math.max(
      ...Object.values(config.providers).map((p) => p.timeout_seconds || 600)
    ) + 300) * 1000;

function blockText(block) {
  const type = block.type;
  const rich = block[type]?.rich_text;
  if (!rich) return "";
  return rich.map((t) => t.plain_text).join("");
}

function isOutputMarker(block) {
  if (block.type !== "heading_3") return false;
  return OUTPUT_MARKERS.has(blockText(block).trim());
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shortId(id) {
  return String(id || "").replace(/-/g, "").slice(0, 8);
}

async function withRateLimit(fn) {
  const result = await fn();
  if (config.poll.api_delay_ms) {
    await sleep(config.poll.api_delay_ms);
  }
  return result;
}

function richText(content) {
  if (!content) return [];
  return [{ text: { content: String(content).slice(0, 2000) } }];
}

function pageBlocks(description) {
  if (!description) return undefined;
  return [
    {
      object: "block",
      type: "paragraph",
      paragraph: { rich_text: richText(description) },
    },
  ];
}

async function findProjectByName(name) {
  const response = await withRateLimit(() =>
    notion.databases.query({
      database_id: PROJECTS_DB,
      filter: {
        property: PROJECT_PROPERTIES.title,
        title: { equals: name },
      },
    })
  );
  return response.results[0]?.id || null;
}

async function createProject({ name, goal, status, priority }) {
  const page = await withRateLimit(() =>
    notion.pages.create({
      parent: { database_id: PROJECTS_DB },
      properties: {
        [PROJECT_PROPERTIES.title]: { title: richText(name) },
        [PROJECT_PROPERTIES.status]: {
          status: { name: mapProjectStatus(status || "planning") },
        },
        [PROJECT_PROPERTIES.priority]: {
          select: { name: mapProjectPriority(priority || "medium") },
        },
        ...(goal && {
          [PROJECT_PROPERTIES.summary]: { rich_text: richText(goal) },
        }),
      },
    })
  );
  return page.id;
}

async function getOrCreateProject(name, goal) {
  const existing = await findProjectByName(name);
  if (existing) return existing;
  return createProject({ name, goal, status: "planning" });
}

async function createTask({
  title,
  description,
  status,
  provider,
  model,
  priority,
  projectId,
  tags,
  repository,
}) {
  const resolvedProvider =
    provider || inferProvider(model) || config.default_provider;
  const resolvedModel = resolveModel(resolvedProvider, model);

  const page = await withRateLimit(() =>
    notion.pages.create({
      parent: { database_id: TASKS_DB },
      properties: {
        [PROPERTIES.title]: { title: richText(title) },
        [PROPERTIES.status]: { status: { name: mapStatus(status || "todo") } },
        [PROPERTIES.provider]: { select: { name: resolvedProvider } },
        ...(resolvedModel && {
          [PROPERTIES.model]: { select: { name: resolvedModel } },
        }),
        [PROPERTIES.priority]: {
          select: { name: mapPriority(priority || "medium") },
        },
        [PROPERTIES.assigned]: { checkbox: false },
        ...(projectId && {
          [PROPERTIES.project]: { relation: [{ id: projectId }] },
        }),
        ...(tags?.length && {
          [PROPERTIES.tags]: {
            multi_select: tags.map((t) => ({ name: t })),
          },
        }),
        ...(repository && {
          [PROPERTIES.repository]: { url: repository },
        }),
      },
      ...(description && { children: pageBlocks(description) }),
    })
  );
  return page.id;
}

async function createSubtask(parentId, taskData) {
  const pageId = await createTask(taskData);
  await withRateLimit(() =>
    notion.pages.update({
      page_id: pageId,
      properties: {
        [PROPERTIES.parentTask]: { relation: [{ id: parentId }] },
      },
    })
  );
  return pageId;
}

async function createRelation(pageId, propertyName, relatedPageId) {
  await withRateLimit(() =>
    notion.pages.update({
      page_id: pageId,
      properties: {
        [propertyName]: { relation: [{ id: relatedPageId }] },
      },
    })
  );
}

async function queryInProgressUnassigned(dbId = TASKS_DB) {
  const response = await withRateLimit(() =>
    notion.databases.query({
      database_id: dbId,
      filter: {
        and: [
          {
            property: PROPERTIES.status,
            status: { equals: mapStatus("in_progress") },
          },
          { property: PROPERTIES.assigned, checkbox: { equals: false } },
        ],
      },
    })
  );
  return response.results;
}

// P1: crash recovery. Reset tasks that are In Progress + Assigned but have no live
// job and whose lease has expired, so a future tick re-dispatches them.
async function reclaimStale(activeJobIds, dbId = TASKS_DB) {
  const response = await withRateLimit(() =>
    notion.databases.query({
      database_id: dbId,
      filter: {
        and: [
          {
            property: PROPERTIES.status,
            status: { equals: mapStatus("in_progress") },
          },
          { property: PROPERTIES.assigned, checkbox: { equals: true } },
        ],
      },
    })
  );

  const now = Date.now();
  const reclaimed = [];
  for (const task of response.results) {
    if (activeJobIds.has(task.id)) continue;
    const started = task.properties[PROPERTIES.startedAt]?.date?.start;
    const age = started ? now - new Date(started).getTime() : Infinity;
    if (age < LEASE_TIMEOUT_MS) continue;

    await withRateLimit(() =>
      notion.pages.update({
        page_id: task.id,
        properties: { [PROPERTIES.assigned]: { checkbox: false } },
      })
    );
    reclaimed.push(task.id);
    logger.warn(
      `[notion] ${shortId(task.id)} lease expired (age ${Number.isFinite(age) ? Math.round(age / 1000) + "s" : "no Started At"}), reset Assigned=false for re-dispatch`
    );
  }
  return reclaimed;
}

// P2: fail fast on schema drift before it corrupts a run.
async function validateSchema() {
  const errors = [];
  const tasksDb = await withRateLimit(() =>
    notion.databases.retrieve({ database_id: TASKS_DB })
  );
  const projectsDb = await withRateLimit(() =>
    notion.databases.retrieve({ database_id: PROJECTS_DB })
  );

  const requireProps = (db, label, names) => {
    for (const name of names) {
      if (!db.properties[name]) errors.push(`${label} DB missing property "${name}"`);
    }
  };
  requireProps(tasksDb, "Tasks", Object.values(PROPERTIES));
  requireProps(projectsDb, "Projects", Object.values(PROJECT_PROPERTIES));

  // Status is a `status`-type property; its options CANNOT be auto-created by the
  // API, so missing options here 400 mid-run. select options (Priority/Provider/
  // Model) auto-create on write, so we don't assert those.
  // ponytail: validate status options only; selects self-heal on first write.
  const statusOptions = (
    tasksDb.properties[PROPERTIES.status]?.status?.options || []
  ).map((o) => o.name);
  const requiredStatuses = [
    ...new Set(["Not Started", "In Progress", "Done", SUCCESS_STATUS, FAILURE_STATUS]),
  ];
  for (const s of requiredStatuses) {
    if (!statusOptions.includes(s)) {
      errors.push(
        `Tasks Status missing option "${s}" (has: ${statusOptions.join(", ") || "none"})`
      );
    }
  }

  if (errors.length) {
    throw new Error(
      "Notion schema validation failed:\n  - " + errors.join("\n  - ")
    );
  }
  logger.info("[notion] schema validation passed");
}

// P4: dedup for idempotent populate — find an existing task by title (+ project).
async function findTaskByTitleAndProject(title, projectId) {
  const filters = [{ property: PROPERTIES.title, title: { equals: title } }];
  if (projectId) {
    filters.push({ property: PROPERTIES.project, relation: { contains: projectId } });
  }
  const response = await withRateLimit(() =>
    notion.databases.query({
      database_id: TASKS_DB,
      filter: filters.length > 1 ? { and: filters } : filters[0],
    })
  );
  return response.results[0]?.id || null;
}

async function getTaskDescription(pageId) {
  logger.info(`[notion] ${shortId(pageId)} reading page content blocks`);
  const blocks = await withRateLimit(() =>
    notion.blocks.children.list({ block_id: pageId })
  );
  const lines = [];
  let stoppedAtMarker = false;
  for (const b of blocks.results) {
    if (isOutputMarker(b)) {
      stoppedAtMarker = true;
      break;
    }
    lines.push(blockText(b));
  }
  const text = lines.filter(Boolean).join("\n");
  logger.info(
    `[notion] ${shortId(pageId)} read ${blocks.results.length} block(s), ${text.length} chars of text${stoppedAtMarker ? " (stopped at prior output marker)" : ""}`
  );
  return text;
}

async function markAssigned(pageId) {
  logger.info(`[notion] ${shortId(pageId)} marking Assigned=true + Started At`);
  await withRateLimit(() =>
    notion.pages.update({
      page_id: pageId,
      properties: {
        [PROPERTIES.assigned]: { checkbox: true },
        [PROPERTIES.startedAt]: { date: { start: new Date().toISOString() } },
      },
    })
  );
}

async function appendOutputBlocks(pageId, output, success) {
  const text = stripAnsi(output).trim();
  const chunks = chunkText(text, 2000);
  if (chunks.length === 0) {
    logger.info(`[notion] ${shortId(pageId)} no output text to write`);
    return;
  }

  logger.info(
    `[notion] ${shortId(pageId)} writing ${chunks.length} output block(s) (${text.length} chars, ${success ? "success" : "error"})`
  );

  const blockFor = (chunk) =>
    success
      ? {
          object: "block",
          type: "paragraph",
          paragraph: { rich_text: richText(chunk) },
        }
      : {
          object: "block",
          type: "code",
          code: { rich_text: richText(chunk), language: "plain text" },
        };

  const blocks = [
    {
      object: "block",
      type: "heading_3",
      heading_3: {
        rich_text: richText(success ? "Output" : "Error output"),
      },
    },
    ...chunks.map(blockFor),
  ];

  for (let i = 0; i < blocks.length; i += 100) {
    await withRateLimit(() =>
      notion.blocks.children.append({
        block_id: pageId,
        children: blocks.slice(i, i + 100),
      })
    );
  }
  logger.info(`[notion] ${shortId(pageId)} output blocks written`);
}

async function markComplete(pageId, exitCode, stdout = "", stderr = "") {
  const success = exitCode === 0;
  const tag = shortId(pageId);
  logger.info(
    `[notion] ${tag} markComplete start (exit=${exitCode}, success=${success}, → ${success ? SUCCESS_STATUS : FAILURE_STATUS})`
  );

  const properties = {
    [PROPERTIES.status]: {
      status: { name: success ? SUCCESS_STATUS : FAILURE_STATUS },
    },
    [PROPERTIES.assigned]: { checkbox: false },
    [PROPERTIES.completedAt]: { date: { start: new Date().toISOString() } },
    [PROPERTIES.exitCode]: { number: exitCode },
  };

  if (!success && stderr) {
    properties[PROPERTIES.errorLog] = {
      rich_text: richText(stripAnsi(stderr).slice(0, 2000)),
    };
  }

  logger.info(`[notion] ${tag} updating page properties (status, timestamps, exit code)`);
  await withRateLimit(() =>
    notion.pages.update({
      page_id: pageId,
      properties,
    })
  );
  logger.info(`[notion] ${tag} page properties updated`);

  const output = success ? stdout : stderr || stdout;
  if (output && stripAnsi(output).trim()) {
    await appendOutputBlocks(pageId, output, success);
  } else {
    logger.info(`[notion] ${tag} no output to append to page body`);
  }
}

async function getBlockedByTasks(pageId) {
  const page = await withRateLimit(() =>
    notion.pages.retrieve({ page_id: pageId })
  );
  const relations = page.properties[PROPERTIES.blockedBy]?.relation || [];
  const blockedBy = [];

  for (const rel of relations) {
    const blockedPage = await withRateLimit(() =>
      notion.pages.retrieve({ page_id: rel.id })
    );
    const status =
      blockedPage.properties[PROPERTIES.status]?.status?.name || "";
    blockedBy.push({ id: rel.id, status });
  }

  return blockedBy;
}

function getTaskTitle(task) {
  return task.properties[PROPERTIES.title]?.title?.[0]?.plain_text || "Untitled";
}

function getTaskProvider(task) {
  const model = getTaskModel(task);
  return (
    task.properties[PROPERTIES.provider]?.select?.name ||
    inferProvider(model) ||
    config.default_provider
  );
}

function getTaskModel(task) {
  return task.properties[PROPERTIES.model]?.select?.name || null;
}

function getResolvedModel(task) {
  const provider = getTaskProvider(task);
  const model = getTaskModel(task);
  return resolveModel(provider, model);
}

// Per-task repo override — a GitHub URL or local path. Empty → poller falls back.
function getTaskRepository(task) {
  return task.properties[PROPERTIES.repository]?.url || null;
}

// Auto-discover every KADE "Tasks" database shared with this integration, so
// adding a repo is just: duplicate the template + share it — no config editing.
// A DB counts as KADE if it's titled "Tasks" and carries the marker properties.
async function discoverTaskDatabases() {
  const found = [];
  let cursor;
  do {
    const res = await withRateLimit(() =>
      notion.search({
        filter: { value: "database", property: "object" },
        start_cursor: cursor,
      })
    );
    for (const db of res.results) {
      const title = db.title?.[0]?.plain_text;
      const props = db.properties || {};
      if (
        title === "Tasks" &&
        props[PROPERTIES.provider] &&
        props[PROPERTIES.assigned] &&
        props[PROPERTIES.status]
      ) {
        found.push(db.id);
      }
    }
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);
  return found;
}

module.exports = {
  createTask,
  createSubtask,
  createRelation,
  createProject,
  getOrCreateProject,
  queryInProgressUnassigned,
  discoverTaskDatabases,
  reclaimStale,
  validateSchema,
  findTaskByTitleAndProject,
  LEASE_TIMEOUT_MS,
  getTaskDescription,
  markAssigned,
  markComplete,
  getBlockedByTasks,
  getTaskTitle,
  getTaskProvider,
  getTaskModel,
  getResolvedModel,
  getTaskRepository,
  PROPERTIES,
  mapStatus,
  isOutputMarker,
  blockText,
};
