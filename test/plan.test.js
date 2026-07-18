const test = require("node:test");
const assert = require("node:assert/strict");
const {
  parsePlan,
  extractPlan,
  sanitizeTasks,
  relationWrites,
  orchestrationPreamble,
} = require("../lib/plan");

// --- parsePlan (CLI entry — throws on garbage) ---

test("parsePlan accepts bare JSON", () => {
  const plan = parsePlan('{"tasks":[{"id":"t1","title":"x"}]}');
  assert.equal(plan.tasks[0].id, "t1");
});

test("parsePlan unwraps <task-plan> tags", () => {
  const plan = parsePlan('blah\n<task-plan>\n{"tasks":[]}\n</task-plan>\ntrailing');
  assert.deepEqual(plan.tasks, []);
});

test("parsePlan throws on invalid JSON", () => {
  assert.throws(() => parsePlan("not json at all"), SyntaxError);
});

// --- extractPlan (agent output — never throws) ---

test("extractPlan returns null when no block present", () => {
  assert.equal(extractPlan("I did the work, all done."), null);
  assert.equal(extractPlan(""), null);
  assert.equal(extractPlan(null), null);
});

test("extractPlan parses a tagged block", () => {
  const out = 'Done.\n<task-plan>\n{"tasks":[{"id":"t1","title":"follow up"}]}\n</task-plan>';
  assert.equal(extractPlan(out).tasks[0].title, "follow up");
});

test("extractPlan takes the LAST block when several exist", () => {
  const out =
    '<task-plan>{"tasks":[{"id":"a","title":"first"}]}</task-plan>\n' +
    "some narration\n" +
    '<task-plan>{"tasks":[{"id":"b","title":"second"}]}</task-plan>';
  assert.equal(extractPlan(out).tasks[0].title, "second");
});

test("extractPlan returns null on invalid JSON or missing tasks array", () => {
  assert.equal(extractPlan("<task-plan>{broken</task-plan>"), null);
  assert.equal(extractPlan('<task-plan>{"foo":1}</task-plan>'), null);
});

// --- sanitizeTasks ---

test("sanitizeTasks drops entries without a title", () => {
  const tasks = sanitizeTasks([
    { id: "t1", title: "ok" },
    { id: "t2" },
    null,
    { id: "t3", title: "  " },
  ]);
  assert.deepEqual(tasks.map((t) => t.id), ["t1"]);
});

test("sanitizeTasks enforces the budget across tasks and subtasks", () => {
  const tasks = sanitizeTasks(
    [
      { id: "t1", title: "a", subtasks: [{ id: "s1", title: "sa" }, { id: "s2", title: "sb" }] },
      { id: "t2", title: "b" },
      { id: "t3", title: "c" },
    ],
    { maxTasks: 3 }
  );
  // t1 + 2 subtasks consume the whole budget; t2/t3 never make it.
  assert.deepEqual(tasks.map((t) => t.id), ["t1"]);
  assert.deepEqual(tasks[0].subtasks.map((s) => s.id), ["s1", "s2"]);
});

test("sanitizeTasks preserves other fields and defaults maxTasks to 20", () => {
  const tasks = sanitizeTasks([{ id: "t1", title: "a", provider: "claude", blocked_by: ["x"] }]);
  assert.equal(tasks[0].provider, "claude");
  const many = Array.from({ length: 30 }, (_, i) => ({ id: `t${i}`, title: `t${i}` }));
  assert.equal(sanitizeTasks(many).length, 20);
});

// --- relationWrites ---

const PROPS = { blockedByProp: "Blocked By", relatedToProp: "Related To" };

test("relationWrites batches all blockers of a task into one write", () => {
  const tasks = [{ id: "t1", blocked_by: ["t2", "t3"], related: ["t4"] }];
  const idMap = { t1: "p1", t2: "p2", t3: "p3", t4: "p4" };
  const writes = relationWrites(tasks, idMap, PROPS);
  assert.equal(writes.length, 2);
  const blocked = writes.find((w) => w.property === "Blocked By");
  const related = writes.find((w) => w.property === "Related To");
  assert.deepEqual(blocked.ids.sort(), ["p2", "p3"]);
  assert.deepEqual(related.ids, ["p4"]);
});

test("relationWrites skips unknown ids, self-references, and tasks without pages", () => {
  const tasks = [
    { id: "t1", blocked_by: ["ghost", "t1", "t2"] },
    { id: "orphan", blocked_by: ["t2"] },
  ];
  const idMap = { t1: "p1", t2: "p2" }; // orphan never got a page
  const writes = relationWrites(tasks, idMap, PROPS);
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].ids, ["p2"]);
});

test("relationWrites dedupes repeated ids", () => {
  const tasks = [{ id: "t1", blocked_by: ["t2", "t2"] }];
  const writes = relationWrites(tasks, { t1: "p1", t2: "p2" }, PROPS);
  assert.deepEqual(writes[0].ids, ["p2"]);
});

// --- orchestrationPreamble ---

test("orchestrationPreamble includes the format spec and the task cap", () => {
  const p = orchestrationPreamble({ maxTasks: 7 });
  assert.match(p, /<task-plan>/);
  assert.match(p, /at most 7 tasks/);
  assert.match(p, /self-contained|stand alone/);
});

const { extractDecision, resumePreamble } = require("../lib/plan");

test("extractDecision returns null when no block present", () => {
  assert.equal(extractDecision("all done, no questions"), null);
  assert.equal(extractDecision(""), null);
});

test("extractDecision pulls the last needs-decision block", () => {
  const out =
    "work...\n<needs-decision>ignore me</needs-decision>\nmore\n<needs-decision>Deploy to prod or staging?</needs-decision>";
  assert.equal(extractDecision(out), "Deploy to prod or staging?");
});

test("extractDecision trims and treats an empty block as none", () => {
  assert.equal(extractDecision("<needs-decision>  \n </needs-decision>"), null);
});

test("resumePreamble embeds the human decision", () => {
  assert.match(resumePreamble("use staging"), /Human decision:\nuse staging/);
  assert.match(resumePreamble(""), /best judgment/);
});
