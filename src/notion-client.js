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
const { resolveProviderIcon } = require("../lib/icon");
const { stripAnsi, chunkText, mdToBlocks, stripControlBlocks } = require("../lib/output");
const {
  DECISION_MARKER,
  DECISION_COMMENT_PREFIX,
  buildDecisionBlocks,
  formatDecisionComment,
} = require("../lib/decision");
const logger = require("../lib/logger");

const notion = new Client({
  auth: process.env[config.notion.token_env],
});

// Mutable so `useTemplate` can retarget populate at a discovered template's
// DBs for this process, without editing config.json per repo.
let TASKS_DB = config.notion.tasks_database_id;
let PROJECTS_DB = config.notion.projects_database_id;
const SUCCESS_STATUS = config.notion.success_status || mapStatus("done");
const FAILURE_STATUS = config.notion.failure_status || mapStatus("todo");
const REVIEW_STATUS = config.notion.review_status || mapStatus("review");
// "Decision needed" is a marker too, so getTaskDescription/clearPriorOutput
// treat the parked-decision section as KADE-written output.
const OUTPUT_MARKERS = new Set(["Output", "Error output", DECISION_MARKER]);
// Set by validateSchema when the optional Decision rich_text property exists.
let HAS_DECISION_PROP = false;

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

// --- Transport: global throttle + retry ------------------------------------
// Every Notion call funnels through one queue so parallel dispatches can't
// burst past Notion's ~3 req/s average, and retryable failures (429, 5xx,
// network) get exponential backoff with Retry-After honored. Non-retryable
// errors (400/401/404 validation) surface immediately.
const API_DELAY_MS = config.poll.api_delay_ms ?? 350;
const MAX_ATTEMPTS = 6;

let queue = Promise.resolve();
let lastStart = 0;

function isRetryable(err) {
  const code = err?.code;
  if (
    ["rate_limited", "internal_server_error", "service_unavailable", "bad_gateway", "conflict_error"].includes(code)
  ) {
    return true;
  }
  const status = err?.status;
  if (status === 429 || (status != null && status >= 500)) return true;
  if (err?.name === "RequestTimeoutError") return true;
  if (
    status == null &&
    !code &&
    /fetch failed|econnreset|etimedout|enotfound|eai_again|socket hang up|network/i.test(
      String(err?.message || err)
    )
  ) {
    return true;
  }
  return false;
}

function retryAfterMs(err) {
  const headers = err?.headers;
  const raw =
    headers &&
    (typeof headers.get === "function" ? headers.get("retry-after") : headers["retry-after"]);
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null;
}

// Serialize call starts at >= API_DELAY_MS apart, process-wide.
function throttled(fn) {
  const run = async () => {
    const wait = API_DELAY_MS - (Date.now() - lastStart);
    if (wait > 0) await sleep(wait);
    lastStart = Date.now();
    return fn();
  };
  const p = queue.then(run);
  queue = p.catch(() => {}); // a failed call must not break the chain
  return p;
}

async function api(fn, label = "call") {
  for (let attempt = 1; ; attempt++) {
    try {
      return await throttled(fn);
    } catch (err) {
      if (!isRetryable(err) || attempt >= MAX_ATTEMPTS) throw err;
      const wait =
        retryAfterMs(err) ??
        Math.min(500 * 2 ** attempt, 15000) + Math.floor(Math.random() * 250);
      logger.warn(
        `[notion] ${label} failed (${err.code || err.message}); retry ${attempt}/${MAX_ATTEMPTS - 1} in ${Math.round(wait)}ms`
      );
      await sleep(wait);
    }
  }
}

// Fetch every page of a paginated Notion endpoint (queries, block lists, search).
async function paginate(call, label) {
  const out = [];
  let cursor;
  do {
    const res = await api(() => call(cursor), label);
    out.push(...res.results);
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);
  return out;
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

async function findProjectByName(name, dbId = PROJECTS_DB) {
  const response = await api(
    () =>
      notion.databases.query({
        database_id: dbId,
        filter: {
          property: PROJECT_PROPERTIES.title,
          title: { equals: name },
        },
      }),
    "findProjectByName"
  );
  return response.results[0]?.id || null;
}

async function createProject({ name, goal, status, priority }, dbId = PROJECTS_DB) {
  const page = await api(
    () =>
      notion.pages.create({
        parent: { database_id: dbId },
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
      }),
    "createProject"
  );
  return page.id;
}

async function getOrCreateProject(name, goal, dbId = PROJECTS_DB) {
  const existing = await findProjectByName(name, dbId);
  if (existing) return existing;
  return createProject({ name, goal, status: "planning" }, dbId);
}

async function createTask(
  {
    title,
    description,
    status,
    provider,
    model,
    priority,
    projectId,
    parentId,
    tags,
    repository,
    projectDir,
  },
  dbId = TASKS_DB
) {
  const resolvedProvider =
    provider || inferProvider(model) || config.default_provider;
  const resolvedModel = resolveModel(resolvedProvider, model);
  const icon = resolveProviderIcon(resolvedProvider);

  const page = await api(
    () =>
      notion.pages.create({
        parent: { database_id: dbId },
        ...(icon && { icon }),
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
          ...(parentId && {
            [PROPERTIES.parentTask]: { relation: [{ id: parentId }] },
          }),
          ...(tags?.length && {
            [PROPERTIES.tags]: {
              multi_select: tags.map((t) => ({ name: t })),
            },
          }),
          ...(repository && {
            [PROPERTIES.repository]: { url: repository },
          }),
          ...(projectDir && {
            [PROPERTIES.projectDir]: { rich_text: richText(projectDir) },
          }),
        },
        ...(description && { children: pageBlocks(description) }),
      }),
    "createTask"
  );
  return page.id;
}

async function createSubtask(parentId, taskData, dbId = TASKS_DB) {
  return createTask({ ...taskData, parentId }, dbId);
}

async function updatePageIcon(pageId) {
  const page = await api(() => notion.pages.retrieve({ page_id: pageId }), "updatePageIcon:read");
  const provider = page.properties?.[PROPERTIES.provider]?.select?.name;
  const icon = resolveProviderIcon(provider);
  if (!icon) return false;
  await api(
    () => notion.pages.update({ page_id: pageId, icon }),
    "updatePageIcon:write"
  );
  return true;
}

// Merge-write a relation property. Notion relation updates REPLACE the whole
// array, so we read the current value first and union — per-relation writes
// would clobber each other (multi-blocker tasks) and wipe manual edits.
async function mergeRelations(pageId, propertyName, relatedIds) {
  const page = await api(() => notion.pages.retrieve({ page_id: pageId }), "mergeRelations:read");
  const existing = (page.properties[propertyName]?.relation || []).map((r) => r.id);
  const merged = [...new Set([...existing, ...relatedIds])];
  if (merged.length === existing.length) return false;
  await api(
    () =>
      notion.pages.update({
        page_id: pageId,
        properties: {
          [propertyName]: { relation: merged.map((id) => ({ id })) },
        },
      }),
    "mergeRelations:write"
  );
  return true;
}

// Single-relation convenience wrapper kept for callers that add one link.
async function createRelation(pageId, propertyName, relatedPageId) {
  return mergeRelations(pageId, propertyName, [relatedPageId]);
}

async function queryInProgressUnassigned(dbId = TASKS_DB) {
  return paginate(
    (cursor) =>
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
        start_cursor: cursor,
      }),
    "queryInProgressUnassigned"
  );
}

// P1: crash recovery. Reset tasks that are In Progress + Assigned but have no live
// job and whose lease has expired, so a future tick re-dispatches them.
async function reclaimStale(activeJobIds, dbId = TASKS_DB) {
  const results = await paginate(
    (cursor) =>
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
        start_cursor: cursor,
      }),
    "reclaimStale:query"
  );

  const now = Date.now();
  const reclaimed = [];
  for (const task of results) {
    if (activeJobIds.has(task.id)) continue;
    const started = task.properties[PROPERTIES.startedAt]?.date?.start;
    const age = started ? now - new Date(started).getTime() : Infinity;
    if (age < LEASE_TIMEOUT_MS) continue;

    await api(
      () =>
        notion.pages.update({
          page_id: task.id,
          properties: { [PROPERTIES.assigned]: { checkbox: false } },
        }),
      "reclaimStale:reset"
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
  const tasksDb = await api(() =>
    notion.databases.retrieve({ database_id: TASKS_DB }), "validateSchema:tasks"
  );
  const projectsDb = await api(() =>
    notion.databases.retrieve({ database_id: PROJECTS_DB }), "validateSchema:projects"
  );

  // Only the properties the dispatch loop reads/writes every run are hard
  // requirements. The rest (model, tags, repository, project directory, the
  // relations) are optional — a template missing one must not abort the whole
  // daemon; they're written conditionally and read with optional chaining.
  const CORE_TASK_PROPS = [
    PROPERTIES.title,
    PROPERTIES.status,
    PROPERTIES.assigned,
    PROPERTIES.provider,
    PROPERTIES.startedAt,
    PROPERTIES.completedAt,
    PROPERTIES.exitCode,
  ];
  const CORE_PROJECT_PROPS = [PROJECT_PROPERTIES.title, PROJECT_PROPERTIES.status];

  const checkProps = (db, label, core, all) => {
    for (const name of core) {
      if (!db.properties[name]) errors.push(`${label} DB missing required property "${name}"`);
    }
    const optionalMissing = all.filter((n) => !core.includes(n) && !db.properties[n]);
    if (optionalMissing.length) {
      logger.warn(`[notion] ${label} DB missing optional propert${optionalMissing.length > 1 ? "ies" : "y"} ${optionalMissing.map((n) => `"${n}"`).join(", ")} — related features disabled until added`);
    }
  };
  checkProps(tasksDb, "Tasks", CORE_TASK_PROPS, Object.values(PROPERTIES));
  checkProps(projectsDb, "Projects", CORE_PROJECT_PROPS, Object.values(PROJECT_PROPERTIES));

  // Status is a `status`-type property; its options CANNOT be auto-created by the
  // API, so missing options here 400 mid-run. select options (Priority/Provider/
  // Model) auto-create on write, so we don't assert those.
  // ponytail: validate status options only; selects self-heal on first write.
  const statusOptions = (
    tasksDb.properties[PROPERTIES.status]?.status?.options || []
  ).map((o) => o.name);
  const requiredStatuses = [
    ...new Set(["Not Started", "In Progress", "Done", SUCCESS_STATUS, FAILURE_STATUS, REVIEW_STATUS]),
  ];
  for (const s of requiredStatuses) {
    if (!statusOptions.includes(s)) {
      errors.push(
        `Tasks Status missing option "${s}" (has: ${statusOptions.join(", ") || "none"})`
      );
    }
  }

  // Decision rich_text: humans type their answer here when a task is In Review.
  // Auto-create when missing so the harness-style UX works without manual setup.
  // Wrong type → warn and fall back to page comments only.
  const decisionProp = tasksDb.properties[PROPERTIES.decision];
  HAS_DECISION_PROP = decisionProp?.type === "rich_text";
  if (decisionProp && !HAS_DECISION_PROP) {
    logger.warn(
      `[notion] Tasks property "${PROPERTIES.decision}" exists but is type "${decisionProp.type}" (want rich_text) — comment fallback only`
    );
  } else if (!decisionProp) {
    try {
      await api(
        () =>
          notion.databases.update({
            database_id: TASKS_DB,
            properties: { [PROPERTIES.decision]: { rich_text: {} } },
          }),
        "validateSchema:ensureDecision"
      );
      HAS_DECISION_PROP = true;
      logger.info(
        `[notion] added "${PROPERTIES.decision}" rich_text property to Tasks DB (for In Review answers)`
      );
    } catch (err) {
      logger.warn(
        `[notion] could not add "${PROPERTIES.decision}" property (${err.message}) — decision replies use page comments only`
      );
    }
  }

  if (errors.length) {
    throw new Error(
      "Notion schema validation failed:\n  - " + errors.join("\n  - ")
    );
  }
  logger.info(
    `[notion] schema validation passed${HAS_DECISION_PROP ? " (Decision property available)" : ""}`
  );
}

// P4: dedup for idempotent populate — find an existing task by title (+ project).
async function findTaskByTitleAndProject(title, projectId, dbId = TASKS_DB) {
  const filters = [{ property: PROPERTIES.title, title: { equals: title } }];
  if (projectId) {
    filters.push({ property: PROPERTIES.project, relation: { contains: projectId } });
  }
  const response = await api(
    () =>
      notion.databases.query({
        database_id: dbId,
        filter: filters.length > 1 ? { and: filters } : filters[0],
      }),
    "findTaskByTitleAndProject"
  );
  return response.results[0]?.id || null;
}

// Count tasks in a project (bounded — used for the follow-up cap guardrail).
async function countProjectTasks(projectId, dbId = TASKS_DB, cap = 100) {
  const response = await api(
    () =>
      notion.databases.query({
        database_id: dbId,
        filter: { property: PROPERTIES.project, relation: { contains: projectId } },
        page_size: Math.min(Math.max(cap, 1), 100),
      }),
    "countProjectTasks"
  );
  return response.results.length;
}

// Any not-Done, not-Archived task left in the project? One row is enough.
async function hasOpenProjectTasks(projectId, dbId = TASKS_DB) {
  const response = await api(
    () =>
      notion.databases.query({
        database_id: dbId,
        filter: {
          and: [
            { property: PROPERTIES.project, relation: { contains: projectId } },
            { property: PROPERTIES.status, status: { does_not_equal: mapStatus("done") } },
            { property: PROPERTIES.status, status: { does_not_equal: mapStatus("archived") } },
          ],
        },
        page_size: 1,
      }),
    "hasOpenProjectTasks"
  );
  return response.results.length > 0;
}

async function setProjectStatus(projectId, status) {
  await api(
    () =>
      notion.pages.update({
        page_id: projectId,
        properties: {
          [PROJECT_PROPERTIES.status]: { status: { name: mapProjectStatus(status) } },
        },
      }),
    "setProjectStatus"
  );
}

async function getTaskDescription(pageId) {
  logger.info(`[notion] ${shortId(pageId)} reading page content blocks`);
  // Page through the body, stopping early at the first prior-output marker —
  // anything past it is KADE-written output, not prompt material.
  const lines = [];
  let cursor;
  let total = 0;
  let stoppedAtMarker = false;
  do {
    const res = await api(
      () => notion.blocks.children.list({ block_id: pageId, start_cursor: cursor }),
      "getTaskDescription"
    );
    total += res.results.length;
    for (const b of res.results) {
      if (isOutputMarker(b)) {
        stoppedAtMarker = true;
        break;
      }
      lines.push(blockText(b));
    }
    cursor = res.has_more && !stoppedAtMarker ? res.next_cursor : undefined;
  } while (cursor);
  const text = lines.filter(Boolean).join("\n");
  logger.info(
    `[notion] ${shortId(pageId)} read ${total} block(s), ${text.length} chars of text${stoppedAtMarker ? " (stopped at prior output marker)" : ""}`
  );
  return text;
}

async function markAssigned(pageId) {
  logger.info(`[notion] ${shortId(pageId)} marking Assigned=true + Started At`);
  await api(
    () =>
      notion.pages.update({
        page_id: pageId,
        properties: {
          [PROPERTIES.assigned]: { checkbox: true },
          [PROPERTIES.startedAt]: { date: { start: new Date().toISOString() } },
        },
      }),
    "markAssigned"
  );
}

// Delete prior KADE-written output (everything from the first "Output"/"Error
// output" heading onward) so re-runs don't pile up stale blocks.
async function clearPriorOutput(pageId) {
  const blocks = await paginate(
    (cursor) => notion.blocks.children.list({ block_id: pageId, start_cursor: cursor }),
    "clearPriorOutput:list"
  );
  const idx = blocks.findIndex(isOutputMarker);
  if (idx === -1) return 0;
  for (const b of blocks.slice(idx)) {
    await api(() => notion.blocks.delete({ block_id: b.id }), "clearPriorOutput:delete");
  }
  return blocks.length - idx;
}

const NOTION_MAX_CHARS = config.output?.notion_max_chars ?? 100000;

async function appendOutputBlocks(pageId, output, success) {
  let text = stripControlBlocks(stripAnsi(output));
  let truncated = false;
  if (text.length > NOTION_MAX_CHARS) {
    truncated = true;
    text = text.slice(text.length - NOTION_MAX_CHARS);
  }
  if (!text) {
    logger.info(`[notion] ${shortId(pageId)} no output text to write`);
    return;
  }

  // Success output is agent markdown → render it as proper Notion blocks. Error
  // output stays a raw code block (a stack trace is not markdown).
  const bodyBlocks = success
    ? mdToBlocks(text)
    : chunkText(text, 2000).map((chunk) => ({
        object: "block",
        type: "code",
        code: { rich_text: richText(chunk), language: "plain text" },
      }));

  logger.info(
    `[notion] ${shortId(pageId)} writing ${bodyBlocks.length} output block(s) (${text.length} chars${truncated ? ", truncated to tail" : ""}, ${success ? "success" : "error"})`
  );

  const blocks = [
    {
      object: "block",
      type: "heading_3",
      heading_3: {
        rich_text: richText(success ? "Output" : "Error output"),
      },
    },
    ...(truncated
      ? [
          {
            object: "block",
            type: "paragraph",
            paragraph: {
              rich_text: richText(
                `[kade] output truncated — showing last ${NOTION_MAX_CHARS} chars`
              ),
            },
          },
        ]
      : []),
    ...bodyBlocks,
  ];

  for (let i = 0; i < blocks.length; i += 100) {
    await api(
      () =>
        notion.blocks.children.append({
          block_id: pageId,
          children: blocks.slice(i, i + 100),
        }),
      "appendOutputBlocks"
    );
  }
  logger.info(`[notion] ${shortId(pageId)} output blocks written`);
}

// Clear the Decision property so a new park starts blank and a completed task
// doesn't keep a stale answer. No-op when the template has no Decision property.
// Defined above markComplete / markNeedsDecision so both can call it.
function decisionClearProps() {
  if (!HAS_DECISION_PROP) return {};
  return { [PROPERTIES.decision]: { rich_text: [] } };
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
    // Drop any parked answer so the property is clean for a future re-run.
    ...decisionClearProps(),
  };

  if (!success && stderr) {
    properties[PROPERTIES.errorLog] = {
      rich_text: richText(stripAnsi(stderr).slice(0, 2000)),
    };
  }

  logger.info(`[notion] ${tag} updating page properties (status, timestamps, exit code)`);
  await api(
    () =>
      notion.pages.update({
        page_id: pageId,
        properties,
      }),
    "markComplete:properties"
  );
  logger.info(`[notion] ${tag} page properties updated`);

  const output = success ? stdout : stderr || stdout;
  if (output && stripAnsi(output).trim()) {
    // Replace prior output rather than piling another section on each re-run.
    try {
      const removed = await clearPriorOutput(pageId);
      if (removed) logger.info(`[notion] ${tag} cleared ${removed} prior output block(s)`);
    } catch (err) {
      logger.warn(`[notion] ${tag} could not clear prior output: ${err.message}`);
    }
    await appendOutputBlocks(pageId, output, success);
  } else {
    logger.info(`[notion] ${tag} no output to append to page body`);
  }
}

// --- Decision gating (park → resume) ----------------------------------------
// When an agent ends its run with a <needs-decision> block it can't proceed
// without a human. Instead of marking Done, park the task in In Review with a
// harness-style prompt on the page body (question + options + how to answer),
// clear the Decision property for a fresh answer, and post a notification
// comment. The task keeps its page id as the provider session id so a later
// resume continues the same conversation. See poller.dispatchTask for resume.
async function appendDecisionBlocks(pageId, question) {
  const blocks = buildDecisionBlocks(stripAnsi(question).trim(), {
    hasDecisionProp: HAS_DECISION_PROP,
  });
  for (let i = 0; i < blocks.length; i += 100) {
    await api(
      () => notion.blocks.children.append({ block_id: pageId, children: blocks.slice(i, i + 100) }),
      "appendDecisionBlocks"
    );
  }
}

async function postComment(pageId, text) {
  await api(
    () => notion.comments.create({ parent: { page_id: pageId }, rich_text: richText(text) }),
    "postComment"
  );
}

async function markNeedsDecision(pageId, question, output = "") {
  const tag = shortId(pageId);
  logger.info(`[notion] ${tag} parking for human decision → ${REVIEW_STATUS}`);
  await api(
    () =>
      notion.pages.update({
        page_id: pageId,
        properties: {
          [PROPERTIES.status]: { status: { name: REVIEW_STATUS } },
          [PROPERTIES.assigned]: { checkbox: false },
          [PROPERTIES.completedAt]: { date: { start: new Date().toISOString() } },
          [PROPERTIES.exitCode]: { number: 0 },
          // Blank the answer field so the human fills it for this round.
          ...decisionClearProps(),
        },
      }),
    "markNeedsDecision:properties"
  );

  try {
    await clearPriorOutput(pageId);
  } catch (err) {
    logger.warn(`[notion] ${tag} could not clear prior output: ${err.message}`);
  }
  // Decision section FIRST so opening an In Review page shows the harness
  // prompt above any agent narrative; output is context underneath.
  await appendDecisionBlocks(pageId, question);
  if (output && stripAnsi(output).trim()) await appendOutputBlocks(pageId, output, true);
  try {
    await postComment(pageId, formatDecisionComment(stripAnsi(question).trim()));
  } catch (err) {
    logger.warn(`[notion] ${tag} could not post decision comment: ${err.message}`);
  }
}

// Resume signal: a parked task carries a "Decision needed" marker block. Only
// called for tasks that already ran (Completed on set), so fresh tasks pay
// nothing for this extra read.
async function hasPendingDecision(pageId) {
  const blocks = await paginate(
    (cursor) => notion.blocks.children.list({ block_id: pageId, start_cursor: cursor }),
    "hasPendingDecision"
  );
  return blocks.some((b) => b.type === "heading_3" && blockText(b).trim() === DECISION_MARKER);
}

function wasCompleted(task) {
  return !!task.properties?.[PROPERTIES.completedAt]?.date?.start;
}

// Prefer the Decision property (top of the page — harness-like), then the most
// recent page comment that isn't KADE's own question. Empty when they flipped
// Status without answering. Always attempts the property (even if schema
// validation didn't see it on the primary DB — multi-template safe).
async function getDecisionReply(pageId) {
  try {
    const page = await api(
      () => notion.pages.retrieve({ page_id: pageId }),
      "getDecisionReply:property"
    );
    const prop = page.properties?.[PROPERTIES.decision];
    if (prop) {
      const text = (prop.rich_text || []).map((t) => t.plain_text).join("").trim();
      if (text) return text;
      // Property exists on this template — prefer it for future clear/writes
      // even when the primary DB lacked it at startup.
      HAS_DECISION_PROP = true;
    }
  } catch (err) {
    logger.warn(
      `[notion] ${shortId(pageId)} could not read Decision property: ${err.message}`
    );
  }

  const comments = await paginate(
    (cursor) => notion.comments.list({ block_id: pageId, start_cursor: cursor }),
    "getDecisionReply:comments"
  );
  for (let i = comments.length - 1; i >= 0; i--) {
    const text = (comments[i].rich_text || []).map((t) => t.plain_text).join("").trim();
    if (text && !text.startsWith(DECISION_COMMENT_PREFIX)) return text;
  }
  return "";
}

// Blocker ids straight from the already-fetched task object — zero API calls.
function getBlockerIds(task) {
  return (task.properties?.[PROPERTIES.blockedBy]?.relation || []).map((r) => r.id);
}

async function getPageStatusName(pageId) {
  const page = await api(() => notion.pages.retrieve({ page_id: pageId }), "getPageStatusName");
  return page.properties?.[PROPERTIES.status]?.status?.name || "";
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

// Per-task repo override — a GitHub URL cloned onto this machine. Empty → the
// Project Directory, then the template default.
function getTaskRepository(task) {
  return task.properties[PROPERTIES.repository]?.url || null;
}

// Per-task local working directory — an existing path the agent runs in as-is
// (never cloned). Takes precedence over Repository when set.
function getTaskProjectDir(task) {
  const rich = task.properties[PROPERTIES.projectDir]?.rich_text;
  const text = (rich || []).map((t) => t.plain_text).join("").trim();
  return text || null;
}

// A template's default repo lives once in its Tasks DB description as `repo=<url>`.
// Read it per database (cached — the binding is static for the process's life).
const repoCache = new Map();

function parseRepoFromDescription(description) {
  const text = (description || []).map((t) => t.plain_text).join("");
  const m = text.match(/repo=(\S+)/);
  return m ? m[1] : null;
}

async function getDataSourceRepo(dbId) {
  if (repoCache.has(dbId)) return repoCache.get(dbId);
  const db = await api(() => notion.databases.retrieve({ database_id: dbId }), "getDataSourceRepo");
  const repo = parseRepoFromDescription(db.description);
  repoCache.set(dbId, repo);
  return repo;
}

// Set the template default once (in the Tasks DB description).
async function setTemplateRepo(repo, dbId = TASKS_DB) {
  await api(
    () =>
      notion.databases.update({
        database_id: dbId,
        description: richText(`repo=${repo}`),
      }),
    "setTemplateRepo"
  );
  repoCache.set(dbId, repo);
}

// Query the Repositories database for a page by title.
// Returns the full page object or null if not found.
async function findRepositoryByName(name, dbId) {
  if (!dbId || !name) return null;
  const response = await api(
    () =>
      notion.databases.query({
        database_id: dbId,
        filter: {
          property: PROPERTIES.title,
          title: { equals: name },
        },
      }),
    "findRepositoryByName"
  );
  return response.results[0] || null;
}

// Read the "Default Location" property from a repository page. Supports both
// rich_text (path or URL as text) and url property types. Returns null when the
// DB is not configured or no matching page is found.
async function getRepositoryDefaultLocation(name, dbId) {
  if (!dbId || !name) return null;
  const page = await findRepositoryByName(name, dbId);
  if (!page) return null;
  const props = page.properties || {};
  const prop = props[PROPERTIES.defaultLocation];
  if (!prop) return null;
  // rich_text ("Default Location" as text — can hold URL or path)
  if (prop.rich_text) {
    const text = prop.rich_text.map((t) => t.plain_text).join("").trim();
    if (text) return text;
  }
  // url fallback
  if (prop.url) return prop.url || null;
  return null;
}

// Normalized DB title: join every rich-text segment and trim. Notion lets a
// title carry a trailing space or split runs, so exact `=== "Tasks"` matches
// would silently drop a real KADE template.
function dbTitle(db) {
  return (db.title || []).map((t) => t.plain_text).join("").trim();
}

// A DB counts as a KADE Tasks DB if it's titled "Tasks" and carries the marker
// properties. Shared by DB discovery (poller) and template grouping (populate).
function isKadeTasksDb(db) {
  const props = db.properties || {};
  return (
    dbTitle(db) === "Tasks" &&
    props[PROPERTIES.provider] &&
    props[PROPERTIES.assigned] &&
    props[PROPERTIES.status]
  );
}

// Every KADE database this integration can see, paged out of notion.search.
async function searchDatabases() {
  return paginate(
    (cursor) =>
      notion.search({
        filter: { value: "database", property: "object" },
        start_cursor: cursor,
      }),
    "searchDatabases"
  );
}

// Auto-discover every KADE "Tasks" database shared with this integration, so
// adding a repo is just: duplicate the template + share it — no config editing.
async function discoverTaskDatabases() {
  return (await searchDatabases()).filter(isKadeTasksDb).map((db) => db.id);
}

// A template is one page holding a KADE "Tasks" DB + a "Projects" DB. Group the
// searched DBs by their shared parent page → the unit populate targets by name.
// Pure (no I/O) so it's unit-testable; name resolution happens in the caller.
function groupTemplates(dbs) {
  const byPage = new Map();
  for (const db of dbs) {
    const pageId = db.parent?.page_id;
    if (!pageId) continue;
    const entry = byPage.get(pageId) || { pageId };
    if (isKadeTasksDb(db)) entry.tasksDbId = db.id;
    else if (dbTitle(db) === "Projects") entry.projectsDbId = db.id;
    byPage.set(pageId, entry);
  }
  return [...byPage.values()].filter((t) => t.tasksDbId && t.projectsDbId);
}

// Display label for a discovered template: the parent-page name, qualified with
// the short page id in brackets when two or more templates share the exact same
// name (e.g. duplicated "KADE setup" pages). Mirrors matchTemplate()'s error
// list format. Pure so it's unit-testable; the single-template fast path in
// setup.js skips this since one template can never collide.
function templateLabel(templates, t) {
  const name = t.name || "Untitled";
  const collides =
    templates.filter((x) => (x.name || "Untitled") === name).length > 1;
  return collides ? `${name} [${shortId(t.pageId)}]` : name;
}

// Match a template by parent-page name: exact (case-insensitive) first, then a
// unique substring. When two pages share a name, pass the short page id (shown
// in brackets in the error) to disambiguate. Ambiguous/missing → throw a list.
function matchTemplate(templates, name) {
  const q = String(name).trim().toLowerCase();
  const label = (t) => `${t.name} [${shortId(t.pageId)}]`;

  // Short page id is always unambiguous — use it as an escape hatch.
  const byId = templates.filter((t) => shortId(t.pageId) === q);
  if (byId.length === 1) return byId[0];

  const exact = templates.filter((t) => t.name?.trim().toLowerCase() === q);
  const hits = exact.length
    ? exact
    : templates.filter((t) => t.name?.toLowerCase().includes(q));
  const all = () => templates.map(label).join(", ") || "none";
  if (hits.length === 0) throw new Error(`No KADE template matches "${name}". Found: ${all()}`);
  if (hits.length > 1)
    throw new Error(`"${name}" matches ${hits.length} templates (${hits.map(label).join(", ")}); pass the id in brackets to disambiguate.`);
  return hits[0];
}

function pageTitle(page) {
  const titleProp = Object.values(page.properties || {}).find((p) => p.type === "title");
  return titleProp?.title?.[0]?.plain_text || "Untitled";
}

// Discover every template and label each with its parent page's title.
async function discoverTemplates() {
  const templates = groupTemplates(await searchDatabases());
  for (const t of templates) {
    const page = await api(() => notion.pages.retrieve({ page_id: t.pageId }), "discoverTemplates");
    t.name = pageTitle(page);
  }
  return templates;
}

async function resolveTemplate(name) {
  return matchTemplate(await discoverTemplates(), name);
}

// Retarget this process's task/project writes at a discovered template.
function useTemplate({ tasksDbId, projectsDbId }) {
  TASKS_DB = tasksDbId;
  PROJECTS_DB = projectsDbId;
}

module.exports = {
  createTask,
  createSubtask,
  updatePageIcon,
  createRelation,
  mergeRelations,
  createProject,
  getOrCreateProject,
  queryInProgressUnassigned,
  discoverTaskDatabases,
  discoverTemplates,
  resolveTemplate,
  useTemplate,
  groupTemplates,
  matchTemplate,
  templateLabel,
  reclaimStale,
  validateSchema,
  findTaskByTitleAndProject,
  countProjectTasks,
  hasOpenProjectTasks,
  setProjectStatus,
  LEASE_TIMEOUT_MS,
  getTaskDescription,
  markAssigned,
  markComplete,
  markNeedsDecision,
  hasPendingDecision,
  wasCompleted,
  getDecisionReply,
  postComment,
  getBlockerIds,
  getPageStatusName,
  getTaskTitle,
  getTaskProvider,
  getTaskModel,
  getResolvedModel,
  getTaskRepository,
  getTaskProjectDir,
  getDataSourceRepo,
  setTemplateRepo,
  findRepositoryByName,
  getRepositoryDefaultLocation,
  PROPERTIES,
  mapStatus,
  isOutputMarker,
  blockText,
};
