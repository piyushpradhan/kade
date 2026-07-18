/**
 * Wiring test for the poller's orchestration loop. Notion + provider spawns are
 * stubbed via the require cache BEFORE poller.js (and its populate.js) load, so
 * the full dispatch → complete → follow-up-plan path runs against fakes.
 */
const test = require("node:test");
const assert = require("node:assert/strict");

const { PROPERTIES } = require("../lib/schema");

// --- call records + stub behavior knobs --------------------------------------
const calls = {
  markAssigned: [],
  markComplete: [],
  markNeedsDecision: [],
  createTask: [],
  createSubtask: [],
  mergeRelations: [],
  setProjectStatus: [],
};
let spawnResult = { exitCode: 0, stdout: "", stderr: "" };

function reset() {
  for (const k of Object.keys(calls)) calls[k] = [];
  spawnResult = { exitCode: 0, stdout: "", stderr: "" };
}

// --- stub notion-client --------------------------------------------------------
const notionClientPath = require.resolve("../src/notion-client");
require.cache[notionClientPath] = {
  id: notionClientPath,
  filename: notionClientPath,
  loaded: true,
  exports: {
    queryInProgressUnassigned: async () => [],
    discoverTemplates: async () => [
      { pageId: "page-1", name: "T", tasksDbId: "db-1", projectsDbId: "projdb-1" },
    ],
    reclaimStale: async () => [],
    validateSchema: async () => {},
    getTaskDescription: async () => "do the thing",
    markAssigned: async (id) => calls.markAssigned.push(id),
    markComplete: async (id, code, stdout, stderr) =>
      calls.markComplete.push({ id, code, stdout, stderr }),
    markNeedsDecision: async (id, question, output) =>
      calls.markNeedsDecision.push({ id, question, output }),
    hasPendingDecision: async () => false,
    wasCompleted: () => false,
    getDecisionReply: async () => "",
    getBlockerIds: () => [],
    getPageStatusName: async () => "Done",
    getTaskTitle: () => "Origin task",
    getTaskProvider: () => "claude",
    getTaskModel: () => "sonnet",
    getResolvedModel: () => "sonnet",
    getTaskRepository: () => null,
    getTaskProjectDir: () => null,
    getDataSourceRepo: async () => null,
    countProjectTasks: async () => 3,
    hasOpenProjectTasks: async () => true,
    setProjectStatus: async (id, status) => calls.setProjectStatus.push({ id, status }),
    // populate.js surface
    createTask: async (data) => {
      calls.createTask.push(data);
      return `new-${calls.createTask.length + calls.createSubtask.length}`;
    },
    createSubtask: async (parentId, data) => {
      calls.createSubtask.push({ parentId, data });
      return `new-${calls.createTask.length + calls.createSubtask.length}`;
    },
    mergeRelations: async (pageId, prop, ids) => calls.mergeRelations.push({ pageId, prop, ids }),
    getOrCreateProject: async () => "proj-1",
    findTaskByTitleAndProject: async () => null,
    setTemplateRepo: async () => {},
    resolveTemplate: async () => ({}),
    useTemplate: () => {},
    mapStatus: (v) => ({ in_progress: "In Progress", todo: "Not Started", done: "Done", archived: "Archived" }[v] || v),
    PROPERTIES,
  },
};

// --- stub providers -------------------------------------------------------------
const providersPath = require.resolve("../src/providers");
require.cache[providersPath] = {
  id: providersPath,
  filename: providersPath,
  loaded: true,
  exports: {
    spawnAgent: async () => spawnResult,
    killAllChildren: () => {},
  },
};

const { dispatchTask } = require("../src/poller");

const FOLLOWUP_STDOUT = `work complete
<task-plan>
{"tasks":[
  {"id":"f1","title":"Follow-up A","description":"do A"},
  {"id":"f2","title":"Follow-up B","description":"do B","blocked_by":["f1"]}
]}
</task-plan>`;

const fakeTask = {
  id: "task-1",
  parent: { database_id: "db-1" },
  properties: {
    [PROPERTIES.project]: { relation: [{ id: "proj-1" }] },
  },
};

test("successful run applies the follow-up plan as auto-started subtasks", async () => {
  reset();
  spawnResult = { exitCode: 0, stdout: FOLLOWUP_STDOUT, stderr: "" };

  await dispatchTask(fakeTask);

  assert.deepEqual(calls.markAssigned, ["task-1"]);
  assert.equal(calls.markComplete[0].code, 0);

  // Both follow-ups became subtasks of the origin, created In Progress (auto-start)
  // and inheriting the origin's provider/model.
  assert.equal(calls.createSubtask.length, 2);
  for (const c of calls.createSubtask) {
    assert.equal(c.parentId, "task-1");
    assert.equal(c.data.status, "in_progress");
    assert.equal(c.data.provider, "claude");
    assert.equal(c.data.model, "sonnet");
    assert.equal(c.data.projectId, "proj-1");
  }

  // f2 blocked_by f1 → one batched merge write with the resolved page ids.
  assert.equal(calls.mergeRelations.length, 1);
  assert.equal(calls.mergeRelations[0].prop, "Blocked By");
  assert.equal(calls.mergeRelations[0].ids.length, 1);

  // Project rollup: started → In Progress; not closed while tasks remain open.
  assert.ok(calls.setProjectStatus.some((c) => c.status === "in_progress"));
  assert.ok(!calls.setProjectStatus.some((c) => c.status === "done"));
});

test("failed run records failure and schedules no follow-ups", async () => {
  reset();
  spawnResult = { exitCode: 1, stdout: "", stderr: "boom" };

  await dispatchTask(fakeTask);

  assert.equal(calls.markComplete[0].code, 1);
  assert.equal(calls.createSubtask.length, 0);
  assert.equal(calls.createTask.length, 0);
  assert.equal(calls.mergeRelations.length, 0);
});

test("successful run without a plan block creates nothing", async () => {
  reset();
  spawnResult = { exitCode: 0, stdout: "all done, nothing further", stderr: "" };

  await dispatchTask(fakeTask);

  assert.equal(calls.markComplete[0].code, 0);
  assert.equal(calls.createSubtask.length, 0);
  assert.equal(calls.createTask.length, 0);
});

test("successful run ending in <needs-decision> parks instead of completing", async () => {
  reset();
  spawnResult = {
    exitCode: 0,
    stdout:
      "I need a choice.\n<needs-decision>\nDeploy where?\n\n1. Production\n2. Staging\n</needs-decision>",
    stderr: "",
  };

  await dispatchTask(fakeTask);

  assert.equal(calls.markComplete.length, 0, "must not mark Done when parked");
  assert.equal(calls.markNeedsDecision.length, 1);
  assert.match(calls.markNeedsDecision[0].question, /Deploy where/);
  assert.equal(calls.markNeedsDecision[0].id, "task-1");
  // Follow-ups wait until the human answers and the run actually finishes.
  assert.equal(calls.createSubtask.length, 0);
});
