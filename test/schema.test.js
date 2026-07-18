const test = require("node:test");
const assert = require("node:assert/strict");
const {
  mapStatus,
  mapPriority,
  mapProjectStatus,
  mapProjectPriority,
  STATUS,
  PRIORITY,
} = require("../lib/schema");

test("mapStatus converts plan values to Notion template options", () => {
  assert.equal(mapStatus("todo"), STATUS.todo);
  assert.equal(mapStatus("in_progress"), STATUS.in_progress);
  assert.equal(mapStatus("done"), STATUS.done);
  assert.equal(mapStatus("archived"), STATUS.archived);
});

test("STATUS has no phantom options absent from the live template", () => {
  // "In Review" is required by the decision-gating flow — the Tasks DB must
  // carry this status option (validateSchema enforces it at startup).
  assert.deepEqual(
    Object.values(STATUS).sort(),
    ["Archived", "Done", "In Progress", "In Review", "Not Started"]
  );
});

test("mapPriority converts plan values", () => {
  assert.equal(mapPriority("urgent"), PRIORITY.urgent);
  assert.equal(mapPriority("high"), PRIORITY.high);
  assert.equal(mapPriority("medium"), PRIORITY.medium);
});

test("mapProjectPriority clamps Urgent to High (Projects has no Urgent)", () => {
  assert.equal(mapProjectPriority("urgent"), PRIORITY.high);
  assert.equal(mapProjectPriority("high"), PRIORITY.high);
  assert.equal(mapProjectPriority("low"), PRIORITY.low);
});

test("mapProjectStatus converts project statuses", () => {
  assert.equal(mapProjectStatus("planning"), "Planning");
  assert.equal(mapProjectStatus("in_progress"), "In Progress");
});
