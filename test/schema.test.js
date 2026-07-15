const test = require("node:test");
const assert = require("node:assert/strict");
const {
  mapStatus,
  mapPriority,
  mapProjectStatus,
  STATUS,
  PRIORITY,
} = require("../lib/schema");

test("mapStatus converts plan values to Notion template options", () => {
  assert.equal(mapStatus("todo"), STATUS.todo);
  assert.equal(mapStatus("in_progress"), STATUS.in_progress);
  assert.equal(mapStatus("review"), STATUS.review);
  assert.equal(mapStatus("done"), STATUS.done);
});

test("mapPriority converts plan values", () => {
  assert.equal(mapPriority("urgent"), PRIORITY.urgent);
  assert.equal(mapPriority("high"), PRIORITY.high);
  assert.equal(mapPriority("medium"), PRIORITY.medium);
});

test("mapProjectStatus converts project statuses", () => {
  assert.equal(mapProjectStatus("planning"), "Planning");
  assert.equal(mapProjectStatus("in_progress"), "In Progress");
});
